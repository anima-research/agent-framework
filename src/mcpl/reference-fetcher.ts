/**
 * RFC-005 host-mediated reference fetcher (§6, §7) — the only code that ever
 * dereferences a reference, and it fails closed on every axis the RFC names:
 *
 *  - **origin binding (§6.1, revision 3):** authenticated fetches go only to
 *    the origin the reference's server connection was dialed to. This v1 does
 *    not fetch third-party origins at all (deferred with declared reference
 *    origins); the connection credential is applied as an Authorization
 *    header by this code alone and never surfaces to model, script, or URI.
 *  - **scheme allowlist (§7.1, vector 11):** https; http only when the dialed
 *    origin itself is plaintext (a ws:// server references its own origin).
 *  - **no redirect traversal (§7.2, vector 12):** any 3xx refuses.
 *  - **actual-byte ceiling (§7.3 list, vector 10):** streamed with abort the
 *    moment real octets exceed the ceiling, regardless of claimed sizeBytes.
 *    A claim already over the ceiling refuses without dialing (vector 4).
 *  - **digest verification (§7.4 list, vector 5):** sha256 computed while
 *    streaming; a mismatch is discarded, never presented.
 *  - **expiry (§7.4, vector 16):** expired testimony refuses locally.
 *  - **storage naming (§7.3):** the file name is host-generated from the
 *    reference id + verified type; the server's `name` is display-only.
 *
 * Autofetch policy (host default, not protocol): eager only below
 * DEFAULT_EAGER_FETCH_MAX_BYTES from the connection origin — anything under
 * that threshold the server could legitimately have inlined, so eager
 * materialization is never worse than the status quo. Everything larger is
 * fetched on demand (the fetch_reference tool, or the code-execution result
 * hook, where a script receiving a result is the strongest available signal
 * that the bytes are wanted). Per-server budgets cap cumulative appetite.
 */
import { createHash } from 'node:crypto';
import type { ReferenceRecord } from './references.js';
import { isReferenceExpired } from './references.js';

/** Per-fetch hard ceiling on actual bytes (overridable per server / call). */
export const DEFAULT_FETCH_MAX_BYTES = 256 * 1024 * 1024;
/** Eager (autofetch) threshold: at most what could have shipped inline. */
export const DEFAULT_EAGER_FETCH_MAX_BYTES = 256 * 1024;
/** Cumulative per-server budget for this process. */
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const EAGER_FETCH_TIMEOUT_MS = 10_000;

export interface ResolvedServerBinding {
  /** The url the connection was dialed to (ws/wss/http/https). */
  url: string;
  /** Connection credential, applied host-side as Authorization: Bearer. */
  token?: string;
  autofetch?: { maxBytes?: number; maxTotalBytes?: number };
}

export interface FetchOutcome {
  ok: boolean;
  /** Mount-prefixed workspace path of the saved payload (on success). */
  path?: string;
  bytes?: number;
  mimeType?: string;
  digestVerified?: boolean;
  error?: string;
}

/** Magic-byte sniff for the formats this pipeline actually moves. The
 *  header is testimony too (vector 13): sniffed type wins for the storage
 *  extension and the record's verified type; header, then testimony, are
 *  fallbacks for containers the sniffer doesn't know. */
export function sniffMime(data: Buffer): string | null {
  if (data.length < 12) return null;
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF') return 'audio/wav';
  if (data.subarray(0, 4).toString('latin1') === 'fLaC') return 'audio/flac';
  if (data.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (data.subarray(0, 4).toString('latin1') === 'MThd') return 'audio/midi';
  if (data.subarray(0, 3).toString('latin1') === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 6).toString('latin1') === 'GIF87a' || data.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (data.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data[0] === 0x50 && data[1] === 0x4b) return 'application/zip';
  return null;
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/flac': 'flac', 'audio/midi': 'mid', 'audio/ogg': 'ogg',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'application/json': 'json', 'text/plain': 'txt',
  'application/pdf': 'pdf', 'application/zip': 'zip',
};

/** ws→http / wss→https with default ports elided, for origin comparison. */
export function normalizedOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    const scheme = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
    const defaultPort = scheme === 'https:' ? '443' : '80';
    const port = u.port === '' || u.port === defaultPort ? '' : `:${u.port}`;
    return `${scheme}//${u.hostname.toLowerCase()}${port}`;
  } catch {
    return null;
  }
}

export class ReferenceFetcher {
  private totals = new Map<string, number>();
  private inFlight = new Map<string, Promise<FetchOutcome>>();

  constructor(
    private readonly resolveServer: (serverId: string) => ResolvedServerBinding | undefined,
    /** Persist the payload; returns a mount-prefixed path or null when no
     *  writable workspace exists. File name is host-generated (§7.3). */
    private readonly saveFile: (fileName: string, data: Buffer, mimeType: string) => Promise<string | null>,
  ) {}

  /** Would the eager (autofetch) default fetch this record? */
  isEagerEligible(record: ReferenceRecord): boolean {
    if (record.fetchedPath) return false;
    if (record.serverId === undefined) return false;
    const binding = this.resolveServer(record.serverId);
    if (!binding) return false;
    const cap = binding.autofetch?.maxBytes ?? DEFAULT_EAGER_FETCH_MAX_BYTES;
    if (record.testimony.sizeBytes === undefined || record.testimony.sizeBytes > cap) return false;
    return this.originCheck(record, binding) === null;
  }

  /** §6.1/§7.1 policy check; returns a refusal reason or null. */
  private originCheck(record: ReferenceRecord, binding: ResolvedServerBinding): string | null {
    const refOrigin = normalizedOrigin(record.testimony.uri);
    const dialedOrigin = normalizedOrigin(binding.url);
    if (!refOrigin) return 'reference uri does not parse';
    if (!dialedOrigin) return 'server url does not parse';
    const scheme = refOrigin.split('//')[0];
    if (scheme !== 'https:' && scheme !== 'http:') return `scheme not allowed: ${scheme}`;
    if (refOrigin !== dialedOrigin) {
      return `third-party origin (${refOrigin} != dialed ${dialedOrigin}); not fetched by this host`;
    }
    if (scheme === 'http:' && dialedOrigin.startsWith('https:')) {
      return 'plaintext reference from a secure origin';
    }
    return null;
  }

  /** Fetch a reference to workspace storage. Idempotent per record; concurrent
   *  callers share one in-flight fetch. */
  fetch(record: ReferenceRecord, opts?: { maxBytes?: number; timeoutMs?: number }): Promise<FetchOutcome> {
    if (record.fetchedPath) {
      return Promise.resolve({ ok: true, path: record.fetchedPath, bytes: record.verifiedBytes,
        mimeType: record.verifiedMimeType, digestVerified: record.digestVerified });
    }
    const existing = this.inFlight.get(record.refId);
    if (existing) return existing;
    const p = this.doFetch(record, opts).finally(() => this.inFlight.delete(record.refId));
    this.inFlight.set(record.refId, p);
    return p;
  }

  private async doFetch(record: ReferenceRecord, opts?: { maxBytes?: number; timeoutMs?: number }): Promise<FetchOutcome> {
    const t = record.testimony;
    if (record.serverId === undefined) return { ok: false, error: 'reference has no server binding' };
    const binding = this.resolveServer(record.serverId);
    if (!binding) return { ok: false, error: `unknown server: ${record.serverId}` };

    const refusal = this.originCheck(record, binding);
    if (refusal) return { ok: false, error: refusal };
    if (isReferenceExpired(t)) return { ok: false, error: 'reference expired (or unparseable expiry — fail closed)' };

    const ceiling = opts?.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
    // Vector 4: a claim already over the ceiling refuses without dialing.
    if (t.sizeBytes !== undefined && t.sizeBytes > ceiling) {
      return { ok: false, error: `claimed ${t.sizeBytes} bytes exceeds fetch ceiling ${ceiling}` };
    }
    const budget = binding.autofetch?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const used = this.totals.get(record.serverId) ?? 0;
    if (used >= budget) {
      return { ok: false, error: `per-server fetch budget exhausted (${used}/${budget} bytes)` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {};
      if (binding.token) headers.authorization = `Bearer ${binding.token}`;
      const resp = await fetch(t.uri, { headers, redirect: 'manual', signal: controller.signal });
      if (resp.status >= 300 && resp.status < 400) {
        return { ok: false, error: `redirect refused (HTTP ${resp.status}) — no redirect traversal` };
      }
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      if (!resp.body) return { ok: false, error: 'no response body' };

      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      let received = 0;
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > ceiling || received > budget - used) {
          controller.abort();
          const which = received > ceiling ? 'ceiling' : 'per-server budget';
          return { ok: false, error: `aborted: actual bytes exceeded ${which} at ${received}` };
        }
        const buf = Buffer.from(value);
        hash.update(buf);
        chunks.push(buf);
      }
      const data = Buffer.concat(chunks);

      let digestVerified: boolean | undefined;
      if (t.digest) {
        const got = 'sha256:' + hash.digest('base64url');
        if (got !== t.digest) {
          // Vector 5: never presented as the described content.
          return { ok: false, error: `digest mismatch (claimed ${t.digest.slice(0, 20)}…, got ${got.slice(0, 20)}…)` };
        }
        digestVerified = true;
      }

      const headerMime = resp.headers.get('content-type')?.split(';')[0].trim() || null;
      const observedMime = sniffMime(data) ?? headerMime ?? t.mimeType ?? 'application/octet-stream';
      const ext = EXT_BY_MIME[observedMime] ?? EXT_BY_MIME[headerMime ?? ''] ?? EXT_BY_MIME[t.mimeType ?? ''] ?? 'bin';
      // §7.3: host-generated storage name; the server's `name` is display-only.
      const path = await this.saveFile(`${record.refId}.${ext}`, data, observedMime);
      if (path === null) return { ok: false, error: 'no writable workspace mount to store the payload' };

      this.totals.set(record.serverId, used + data.length);
      record.fetchedPath = path;
      record.verifiedBytes = data.length;
      record.verifiedMimeType = observedMime;
      record.digestVerified = digestVerified;
      return { ok: true, path, bytes: data.length, mimeType: observedMime, digestVerified };
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'fetch timed out or aborted' : (e as Error).message;
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

export { EAGER_FETCH_TIMEOUT_MS };
