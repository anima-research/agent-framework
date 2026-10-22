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
 *  - **scheme allowlist (§7.1, vector 11):** the uri's own scheme is http: or
 *    https:, and since origins compare with their schemes, http only from a
 *    server dialed in plaintext (ws://), https only from one dialed over TLS
 *    (wss://).
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
import { boundedForLog, describeCause } from './errors.js';
import { EXPIRY_REASON, noAddressReason, referenceExpiry, REFERENCE_LIMITS, sanitizeLabel, UNBOUND_REASON } from './references.js';

/** Per-fetch hard ceiling on actual bytes. A call can lower it for itself
 *  (fetch_reference's max_bytes, which it clamps to this); nothing raises it. */
export const DEFAULT_FETCH_MAX_BYTES = 256 * 1024 * 1024;
/** Eager (autofetch) threshold: at most what could have shipped inline. */
export const DEFAULT_EAGER_FETCH_MAX_BYTES = 256 * 1024;
/** Cumulative per-server budget for this process: every byte a fetch dialed
 *  through a server reads counts against that server's, whether or not it's
 *  kept. */
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const EAGER_FETCH_TIMEOUT_MS = 10_000;

// What calling again can do, as each failure's remedy says it. The fetcher
// doesn't know where a reference came from (a tool result, a push, a channel
// message), so none names a tool, and fetch_reference's max_bytes is named
// only where a larger one can fetch it.
const NOTHING_TO_DO = "Calling again won't change that.";
/** The registry keys a record by its uri, so a fresh reference to the same
 *  uri arrives as this very id and refreshes its record. */
const FRESH_REFERENCE = "Once a fresh reference to it arrives, fetching may work; until then, fetching it again won't.";
const TRY_LATER = 'Trying again later may work.';
/** A request that failed before an answer: a refused or reset connection
 *  can clear, and a cause that repeats on every try (a port fetch refuses, a
 *  name that doesn't resolve, a certificate this host doesn't trust) is
 *  whoever runs the host's to change, so the remedy names both. */
const REQUEST_FAILED = "Trying again later may work; if it fails the same way, whoever runs this host can check its connection to the server.";
const CREDENTIALS = "Calling again won't change that; whoever runs this host can check its credentials for the server.";
const FRESH_OR_CREDENTIALS = "Once a fresh reference to it arrives, fetching may work; if that's refused too, whoever runs this host can check its credentials for the server.";
/** The total lives as long as this fetcher, one per framework, so only
 *  someone running the host renews it, by starting a new one, or raises the
 *  budget (the server's config's autofetch.maxTotalBytes, which each fetch
 *  reads afresh). */
const BUDGET = "The budget doesn't renew on its own, so calling again won't change that unless whoever runs this host raises or renews it.";
/** The host's own ceiling: fetch_reference clamps max_bytes to it, and no
 *  config sets another. */
const HOST_CEILING = "No max_bytes or setting lifts that limit, so calling again won't change it.";
/** The resolver reads the host's server configs as they are at each fetch. */
const SERVER_BACK = "Calling again won't change that unless whoever runs this host adds that server back.";

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

/** Why a fetch failed, or would be refused before dialing. */
export interface Refusal {
  /** What happened, as a clause that completes "couldn't fetch <ref>: ",
   *  whatever it's about: fetch_reference's sentence, save_recent_image's,
   *  and the eager and script-demand fetches' log lines read it. */
  error: string;
  /** What calling again can do, as a sentence. fetch_reference and
   *  save_recent_image show it; the eager and script-demand fetches log the
   *  error alone. */
  remedy: string;
}

/** A fetch's result: the saved copy, or why it failed, which every failure
 *  says with both a clause and a remedy. The fields the other side lacks are
 *  declared undefined, so a caller can read them before checking ok. */
export type FetchOutcome =
  | {
    ok: true;
    /** Mount-prefixed workspace path of the saved payload. */
    path: string;
    bytes?: number;
    mimeType?: string;
    digestVerified?: boolean;
    error?: undefined;
    remedy?: undefined;
  }
  | ({ ok: false; path?: undefined; bytes?: undefined; mimeType?: undefined; digestVerified?: undefined } & Refusal);

const refused = (error: string, remedy: string): { refusal: Refusal } => ({ refusal: { error, remedy } });
const fail = (error: string, remedy: string): FetchOutcome => ({ ok: false, error, remedy });

/** What calling again can do about a server's HTTP status. A later try can
 *  work after a timeout, a conflict or lock the server's state can clear, a
 *  request it calls too early, a rate limit or a server's passing trouble,
 *  though not after 501 or 505, which say the server doesn't support the
 *  request. A 401 is about this host's credentials for the server, which a
 *  fresh reference doesn't change, and a 403 can be either those or this
 *  reference. The rest of 4xx is about this reference, which a fresh one may
 *  not share. */
function statusRemedy(status: number): string {
  if (status === 501 || status === 505) return NOTHING_TO_DO;
  if (status === 408 || status === 409 || status === 423 || status === 425 || status === 429 || status >= 500) return TRY_LATER;
  if (status === 401) return CREDENTIALS;
  if (status === 403) return FRESH_OR_CREDENTIALS;
  return FRESH_REFERENCE;
}

/** What a download stopped at a call's own ceiling, below the host's, can do.
 *  Its whole size is unknown, only that it's past what arrived, and a fetch
 *  again reads it from the start, within the host's ceiling and what the
 *  server's budget has left after this one's bytes. The read loop stops a
 *  download past the host's ceiling before it asks, so what arrived is within
 *  it, and only the budget can be what binds. */
function largerMaxBytes(received: number, left: number, server: string): string {
  const most = Math.min(DEFAULT_FETCH_MAX_BYTES, left);
  if (received <= most) return `It's at least ${received} bytes; a larger max_bytes, up to ${most}, may fetch it.`;
  return `It's at least ${received} bytes, more than the ${left} bytes left of this host's fetch budget for ${server}. ${BUDGET}`;
}

/** What a thrown fetch says went wrong. fetch's own "fetch failed" says only
 *  that, so its cause's words come first. A cause from trying each of a
 *  host's addresses (an AggregateError) has no words of its own, so its
 *  attempts' stand in. */
function whyFetchFailed(e: unknown): string {
  const source = (e as { cause?: unknown } | null | undefined)?.cause ?? e;
  const own = describeCause(source);
  if (own !== '') return own;
  const attempts = (source as { errors?: unknown } | null | undefined)?.errors;
  return Array.isArray(attempts) && attempts.length > 0 ? attempts.map(describeCause).join('; ') : describeCause(e);
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

/** A server's address as it's configured, its scheme and host, for a
 *  clause: never its userinfo, path or query. URL's own origin is 'null' for
 *  a scheme that isn't special, which normalizedOrigin accepts. The caller
 *  has already parsed it. */
function configuredOrigin(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

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
  /** Bytes read through each server in this process, charged to the server a
   *  fetch dials through as each chunk is read, kept or not. Concurrent
   *  fetches through one server share the total, so each checks what the
   *  others have taken. */
  private totals = new Map<string, number>();
  private inFlight = new Map<string, Promise<FetchOutcome>>();

  constructor(
    private readonly resolveServer: (serverId: string) => ServerResolution | undefined,
    /** Persist the payload; returns a mount-prefixed path or null when no
     *  writable mount without an include exists. File name is host-generated (§7.3). */
    private readonly saveFile: (fileName: string, data: Buffer, mimeType: string) => Promise<string | null>,
  ) {}

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

  /** The server to dial for a record (§6.2): the first, in the order they
   *  delivered it, whose address is on the uri's origin. When none is, the
   *  first server's refusal (unknown to this host, with no address to dial,
   *  or the origin check's), and for a record no server delivered, that it's
   *  unbound. */
  private serverFor(record: ReferenceRecord): { serverId: string; binding: ResolvedServerBinding } | { refusal: Refusal } {
    let refusal: { refusal: Refusal } | undefined;
    for (const serverId of record.serverIds) {
      const binding = this.resolveServer(serverId);
      if (!binding) {
        refusal ??= refused(`this host no longer has the "${serverId}" server it came from`, SERVER_BACK);
        continue;
      }
      if (binding === 'no-address') {
        refusal ??= refused(noAddressReason(serverId), NOTHING_TO_DO);
        continue;
      }
      const offOrigin = this.originCheck(record, binding, serverId);
      if (offOrigin === null) return { serverId, binding };
      refusal ??= offOrigin;
    }
    // A later delivery of the same uri by a server binds this record.
    return refusal ?? refused(`it's ${UNBOUND_REASON}`, FRESH_REFERENCE);
  }

  /** Every check the fetch makes before it dials, in its order: the server
   *  (none, unknown, no address, an address of its own or the reference's
   *  that doesn't parse, a reference address carrying a user name or
   *  password, a scheme other than http: or https:, off the uri's origin),
   *  the expiry, a claimed size over the host's own ceiling, the server's
   *  spent budget, a claimed size over a call's ceiling. For a record with no
   *  saved copy and no fetch under way, the fetch, `refusal()` and the eager
   *  check all ask this, so what save_recent_image says is the reason the
   *  fetch would refuse with, and no eager slot goes to a fetch that would be
   *  refused. */
  private beforeDial(record: ReferenceRecord, opts?: { maxBytes?: number }):
    { refusal: Refusal } | { serverId: string; binding: ResolvedServerBinding; ceiling: number; budget: number } {
    const server = this.serverFor(record);
    if ('refusal' in server) return server;
    const { serverId, binding } = server;
    const t = record.testimony;
    const expiry = referenceExpiry(t);
    if (expiry) return refused(`the reference is ${EXPIRY_REASON[expiry]}`, FRESH_REFERENCE);

    const ceiling = opts?.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
    // A claim past the host's own ceiling is refused first: nothing lifts
    // it, not even a budget whoever runs the host raises.
    if (t.sizeBytes !== undefined && t.sizeBytes > DEFAULT_FETCH_MAX_BYTES) {
      return refused(`it claims ${t.sizeBytes} bytes, over the ${DEFAULT_FETCH_MAX_BYTES} bytes this host fetches at most`, HOST_CEILING);
    }
    // The budget is checked before a call's ceiling, here and while reading:
    // a larger max_bytes lifts that ceiling, and nothing the caller does lifts
    // the budget, so a fetch past both is told about the budget.
    const budget = binding.autofetch?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const used = this.totals.get(serverId) ?? 0;
    if (used >= budget) {
      return refused(`this host's fetch budget for the "${serverId}" server is used up (${used} of ${budget} bytes)`, BUDGET);
    }
    // Vector 4: a claim already over the ceiling refuses without dialing. One
    // that's also over what's left of the budget is told about the budget,
    // which no max_bytes lifts. A claim over what's left but within the
    // ceiling still dials, and the budget stops it at its first chunk past.
    if (t.sizeBytes !== undefined && t.sizeBytes > ceiling) {
      if (t.sizeBytes > budget - used) {
        return refused(
          `it claims ${t.sizeBytes} bytes, more than the ${budget - used} bytes left of this host's fetch budget for the "${serverId}" server`,
          BUDGET,
        );
      }
      // Within what's left of the budget and the host's ceiling, so a
      // ceiling of the call's own is what a larger max_bytes lifts.
      return refused(`it claims ${t.sizeBytes} bytes, over the ${ceiling} bytes this call allows`,
        `Pass max_bytes of at least ${t.sizeBytes} to fetch it.`);
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

  /** §6.1/§7.1 policy check; returns a refusal or null. */
  private originCheck(record: ReferenceRecord, binding: ResolvedServerBinding, serverId: string): { refusal: Refusal } | null {
    const refOrigin = normalizedOrigin(record.testimony.uri);
    if (!refOrigin) return refused("its address doesn't parse as a URL", NOTHING_TO_DO);
    // A server's address that doesn't parse leaves nothing to dial. The
    // framework's resolver gives only an address its transport dials, so this
    // guards other resolvers.
    const dialedOrigin = normalizedOrigin(binding.url);
    if (!dialedOrigin) {
      return refused(`the "${serverId}" server's address doesn't parse as a URL, so there's nowhere to fetch it from`,
        "Calling again won't change that unless whoever runs this host corrects the server's address.");
    }
    const refUrl = new URL(record.testimony.uri);
    // A user name or password in the uri is a credential embedded in it,
    // which RFC-005 §6.1 forbids a server to mint and lets a host refuse
    // (vector 6). This host neither sends nor repeats it: fetch refuses such
    // a url with a message that holds it whole.
    if (refUrl.username !== '' || refUrl.password !== '') {
      return refused("its address carries a user name or password, which this host doesn't send", NOTHING_TO_DO);
    }
    // The uri's own scheme, not its origin's: an origin reads ws: as http:
    // and wss: as https:, and fetch refuses a ws: or wss: uri ('unknown
    // scheme') before connecting, which would read as a failed request a
    // later try can mend.
    const scheme = refUrl.protocol;
    if (scheme !== 'https:' && scheme !== 'http:') {
      return refused(`its address uses ${scheme}, and this host fetches only http: and https: addresses`, NOTHING_TO_DO);
    }
    // Origins compare with their schemes, so this also refuses an http:
    // reference from a server dialed over TLS (wss://).
    if (refOrigin !== dialedOrigin) {
      return refused(`it points to ${refOrigin}, not to the "${serverId}" server's own address (${configuredOrigin(binding.url)}), ` +
        'and this host fetches only from the server itself', NOTHING_TO_DO);
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
    const check = this.beforeDial(record, opts);
    if ('refusal' in check) return { ok: false, ...check.refusal };
    const { serverId, binding, ceiling, budget } = check;
    const server = `the "${serverId}" server`;

    const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (binding.token) headers.authorization = `Bearer ${binding.token}`;
      const resp = await fetch(t.uri, { headers, redirect: 'manual', signal: controller.signal });
      if (resp.status >= 300 && resp.status < 400) {
        return fail(`${server} answered HTTP ${resp.status}, a redirect, and this host doesn't follow redirects`, NOTHING_TO_DO);
      }
      if (!resp.ok) return fail(`${server} answered HTTP ${resp.status}`, statusRemedy(resp.status));
      if (!resp.body) return fail(`${server} answered without any content`, FRESH_REFERENCE);

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
        // The limit nothing lifts first, as before dialing: the host's
        // ceiling, then the budget, then a call's own ceiling.
        if (received > DEFAULT_FETCH_MAX_BYTES) {
          controller.abort();
          return fail(`the download had reached ${received} bytes, past the ${DEFAULT_FETCH_MAX_BYTES} bytes this host fetches at most, ` +
            'so it was stopped and nothing was kept', HOST_CEILING);
        }
        if (total > budget) {
          controller.abort();
          // The server's running total, as the next fetch's refusal gives it:
          // other fetches through the server may have spent part of it.
          return fail(`this host's fetch budget for ${server} ran out during the download (${total} of ${budget} bytes), ` +
            'so it was stopped and nothing was kept', BUDGET);
        }
        if (received > ceiling) {
          controller.abort();
          return fail(`the download had reached ${received} bytes, past the ${ceiling} bytes this call allows, ` +
            'so it was stopped and nothing was kept', largerMaxBytes(received, budget - total, server));
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
          return fail(
            `the bytes that arrived don't match the reference's digest (${t.digest.slice(0, 20)}…, against ${got.slice(0, 20)}…), ` +
              "so they weren't kept",
            "Trying again may work; if it fails the same way, fetching may work once a fresh reference to it arrives.",
          );
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
      // A null from the save hook covers no workspace, no writable mount
      // without an include and a failed write, and the hook logs which. A
      // throw is the save's failure too, not the fetch's, so it's logged here.
      const fileName = `${record.refId}.${ext}`;
      let path: string | null;
      try {
        path = await this.saveFile(fileName, data, observedMime);
      } catch (e) {
        console.error(`[refs] couldn't store ${fileName}: ${boundedForLog(describeCause(e))}`);
        path = null;
      }
      if (path === null) {
        return fail("it was fetched, but this host couldn't store it in its workspace, so nothing was kept",
          'Calling again is likely to fail the same way; whoever runs this host can see why in its log.');
      }

      record.fetchedPath = path;
      record.verifiedBytes = data.length;
      record.verifiedMimeType = observedMime;
      record.digestVerified = digestVerified;
      return { ok: true, path, bytes: data.length, mimeType: observedMime, digestVerified };
    } catch (e) {
      // The timer is the only abort that throws: the budget and the ceiling
      // abort the download and return at once.
      if ((e as Error)?.name === 'AbortError') {
        const seconds = timeoutMs / 1000;
        return fail(`it took longer than ${seconds} second${seconds === 1 ? '' : 's'}`, TRY_LATER);
      }
      return fail(`the request to ${server} failed: ${boundedForLog(whyFetchFailed(e))}`, REQUEST_FAILED);
    } finally {
      clearTimeout(timer);
    }
  }
}

export { EAGER_FETCH_TIMEOUT_MS };
