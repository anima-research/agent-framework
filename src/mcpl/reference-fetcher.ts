/**
 * RFC-005 host-mediated reference fetcher (§6, §7) — the only code that ever
 * dereferences a reference, and it fails closed on every axis the RFC names:
 *
 *  - **origin binding (§6.1, revision 3):** authenticated fetches go only to
 *    the origin a server's connection was dialed to, for a reference that
 *    server delivered, with that server's credential. This v1 does
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
import type { ReferenceRecord, Refusal, ServerAddress } from './references.js';
import { dialCheck, dialServer, noAddressReason, REFERENCE_LIMITS, sanitizeLabel, shownServerId } from './references.js';

export { normalizedOrigin, type Refusal } from './references.js';

/** Per-fetch hard ceiling on actual bytes (overridable per server / call). */
export const DEFAULT_FETCH_MAX_BYTES = 256 * 1024 * 1024;
/** Eager (autofetch) threshold: at most what could have shipped inline. */
export const DEFAULT_EAGER_FETCH_MAX_BYTES = 256 * 1024;
/** Cumulative per-server budget for this process: every byte a fetch dialed
 *  through a server reads counts against that server's, whether or not it's
 *  kept. */
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
/** What a refusal by the per-server budget adds. The total lives as long as
 *  this fetcher, one per framework, so only someone running the host renews
 *  it, by starting a new one, or raises the budget (the server's config's
 *  autofetch.maxTotalBytes, which each fetch reads afresh). */
const BUDGET_LASTS = "the budget doesn't renew on its own, so calling again won't change that unless whoever runs this host raises or renews it";
const EAGER_FETCH_TIMEOUT_MS = 10_000;

export interface ResolvedServerBinding {
  /** The url the host dials the server at. The framework's resolver gives only
   *  a ws:// or wss:// url its WebSocket transport dials; the origin check
   *  reads ws as http and wss as https. */
  url: string;
  /** Connection credential, applied host-side as Authorization: Bearer. */
  token?: string;
  autofetch?: { maxBytes?: number; maxTotalBytes?: number };
}

/** What the host knows of a server a reference came from: its binding, or
 *  'no-address' for one the host doesn't reach over a network, such as a
 *  stdio server, which has no address to dial. A server the host doesn't
 *  know resolves to undefined. */
export type ServerResolution = ResolvedServerBinding | 'no-address';

/** fetch_reference's words for a refusal. */
function refusalText(refusal: Refusal): string {
  return refusal.ofReference ? `reference ${refusal.reason}` : refusal.reason;
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

/** A Map, so a server's type such as `constructor` finds no inherited key. */
const EXT_BY_MIME = new Map<string, string>(Object.entries({
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/flac': 'flac', 'audio/midi': 'mid', 'audio/ogg': 'ogg',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'application/json': 'json', 'text/plain': 'txt',
  'application/pdf': 'pdf', 'application/zip': 'zip',
}));

export class ReferenceFetcher {
  /** Bytes read through each server in this process, charged to the server a
   *  fetch dials through as each chunk is read, kept or not. Concurrent
   *  fetches through one server share the total, so each checks what the
   *  others have taken. */
  private totals = new Map<string, number>();
  private inFlight = new Map<string, Promise<FetchOutcome>>();

  constructor(
    /** A server's address, credential and limits, by id, from the
     *  framework's own config: the origin a fetch is checked against and the
     *  token it carries come from one answer. */
    private readonly resolveServer: (serverId: string) => ServerResolution | undefined,
    /** Persist the payload; returns a mount-prefixed path or null when no
     *  writable workspace exists. File name is host-generated (§7.3). */
    private readonly saveFile: (fileName: string, data: Buffer, mimeType: string) => Promise<string | null>,
  ) {}

  /** How the host reaches a server, as the resolver answers: what dialCheck
   *  and dialServer read for a fetch. */
  private readonly addressOf = (serverId: string): ServerAddress | undefined => {
    const resolution = this.resolveServer(serverId);
    return resolution === undefined || resolution === 'no-address' ? resolution : { url: resolution.url };
  };

  /** A server's credential and limits, for a server dialServer chose. */
  private bindingFor(serverId: string): { serverId: string; binding: ResolvedServerBinding } | { refusal: Refusal } {
    const binding = this.resolveServer(serverId);
    if (binding === undefined) return { refusal: { reason: `unknown server: ${shownServerId(serverId)}`, ofReference: false } };
    if (binding === 'no-address') return { refusal: { reason: noAddressReason(shownServerId(serverId)), ofReference: false } };
    return { serverId, binding };
  }

  /** The server a fetch of a record dials (§6.2), with its credential and
   *  limits, or why none can be. */
  private serverFor(record: ReferenceRecord): { serverId: string; binding: ResolvedServerBinding } | { refusal: Refusal } {
    const server = dialServer(record, this.addressOf);
    return 'refusal' in server ? server : this.bindingFor(server.serverId);
  }

  /** Would the eager (autofetch) default fetch this record? Not one the fetch
   *  would refuse before dialing, asked as the eager fetch asks it, with the
   *  default ceiling, so such a record takes no eager slot; and only one whose
   *  claimed size is within the eager limit of the server it dials. For one
   *  whose fetch is already under way, which the eager fetch would join as
   *  fetch() does, only the server and its eager limit enter: the expiry,
   *  the budget and the ceiling were checked when that fetch began. */
  isEagerEligible(record: ReferenceRecord): boolean {
    if (record.fetchedPath) return false;
    const check = this.inFlight.has(record.refId) ? this.serverFor(record) : this.beforeDial(record);
    if ('refusal' in check) return false;
    const cap = check.binding.autofetch?.maxBytes ?? DEFAULT_EAGER_FETCH_MAX_BYTES;
    return record.testimony.sizeBytes !== undefined && record.testimony.sizeBytes <= cap;
  }

  /** Every check the fetch makes before it dials, in its order: the server
   *  (none, unknown, no address, off the uri's origin) and the expiry, which
   *  dialCheck makes as a reference's stub does; then the server's spent
   *  budget, a claimed size over the ceiling. For a record with no saved
   *  copy and no fetch under way, the fetch, `refusal()` and the eager
   *  check all ask this, so what save_recent_image says is the reason the
   *  fetch would refuse with, and no eager slot goes to a fetch that would
   *  be refused. */
  private beforeDial(record: ReferenceRecord, opts?: { maxBytes?: number }):
    { refusal: Refusal } | { serverId: string; binding: ResolvedServerBinding; ceiling: number; budget: number } {
    const dial = dialCheck(record, this.addressOf);
    if ('refusal' in dial) return dial;
    const server = this.bindingFor(dial.serverId);
    if ('refusal' in server) return server;
    const { serverId, binding } = server;
    const t = record.testimony;

    const ceiling = opts?.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
    // The budget is checked before the ceiling, here and while reading: a
    // larger max_bytes lifts the ceiling, and nothing the caller does lifts
    // the budget, so a fetch past both is told about the budget.
    const budget = binding.autofetch?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const used = this.totals.get(serverId) ?? 0;
    if (used >= budget) {
      return { refusal: { reason: `per-server fetch budget exhausted (${used}/${budget} bytes); ${BUDGET_LASTS}`, ofReference: false } };
    }
    // Vector 4: a claim already over the ceiling refuses without dialing. One
    // that's also over what's left of the budget is told about the budget,
    // which no max_bytes lifts. A claim over what's left but within the
    // ceiling still dials, and the budget stops it at its first chunk past.
    if (t.sizeBytes !== undefined && t.sizeBytes > ceiling) {
      if (t.sizeBytes > budget - used) {
        return {
          refusal: {
            reason: `claimed ${t.sizeBytes} bytes exceeds what's left of the per-server fetch budget (${used}/${budget} bytes); ${BUDGET_LASTS}`,
            ofReference: false,
          },
        };
      }
      return { refusal: { reason: `claimed ${t.sizeBytes} bytes exceeds fetch ceiling ${ceiling}`, ofReference: false } };
    }
    return { serverId, binding, ceiling, budget };
  }

  /** Why a fetch of this record would be refused before dialing, with the
   *  default ceiling, which a fetch_reference call naming no max_bytes has.
   *  Null where the fetch would serve a saved copy, join a fetch of it
   *  already under way, or dial (where it can still fail), the same three
   *  steps fetch() takes. */
  refusal(record: ReferenceRecord): Refusal | null {
    if (record.fetchedPath || this.inFlight.has(record.refId)) return null;
    const check = this.beforeDial(record);
    return 'refusal' in check ? check.refusal : null;
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
    const check = this.beforeDial(record, opts);
    if ('refusal' in check) return { ok: false, error: refusalText(check.refusal) };
    const { serverId, binding, ceiling, budget } = check;

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
        // What's read is charged at once, kept or not: other fetches from
        // this server read the same total, so none spends what another took.
        const total = (this.totals.get(serverId) ?? 0) + value.byteLength;
        this.totals.set(serverId, total);
        if (total > budget) {
          controller.abort();
          return { ok: false, error: `aborted: per-server fetch budget exhausted (${total}/${budget} bytes); ${BUDGET_LASTS}` };
        }
        if (received > ceiling) {
          controller.abort();
          return { ok: false, error: `aborted: actual bytes exceeded ceiling at ${received}` };
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

      // The response's header and the server's claimed type are both the
      // server's words, and either can become fetch_reference's mime_type,
      // the saved type and the record's verified type, so each is shown as a
      // label is. One left empty once sanitized counts as absent.
      const header = resp.headers.get('content-type');
      const headerMime = header !== null ? sanitizeLabel(header.split(';')[0], REFERENCE_LIMITS.mimeType) || null : null;
      const claimedMime = t.mimeType !== undefined ? sanitizeLabel(t.mimeType, REFERENCE_LIMITS.mimeType) || undefined : undefined;
      const observedMime = sniffMime(data) ?? headerMime ?? claimedMime ?? 'application/octet-stream';
      const ext = EXT_BY_MIME.get(observedMime) ?? EXT_BY_MIME.get(headerMime ?? '') ?? EXT_BY_MIME.get(claimedMime ?? '') ?? 'bin';
      // §7.3: host-generated storage name; the server's `name` is display-only.
      const path = await this.saveFile(`${record.refId}.${ext}`, data, observedMime);
      if (path === null) return { ok: false, error: 'no writable workspace mount to store the payload' };

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
