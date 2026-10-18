/**
 * RFC-005 bulk content references — host treatment (agent-framework side).
 *
 * Mirrors the pure module in mcpl-core-ts `src/references.ts` (this framework
 * deliberately does not depend on that package; hand-maintained MCPL types
 * are the house convention — see types.ts header). Semantics are the RFC's,
 * revision 3:
 *
 *  - every parsed field is server *testimony*, never a fact (§3);
 *  - the one invalid-field rule (§8): a bad optional field is dropped while
 *    the block and its subtractive `disposition` survive; a bad `uri`
 *    rejects the block whole;
 *  - `disposition:"never"` withholds payload AND uri from model context
 *    unconditionally — enforced in code here, not by caller discipline (§5);
 *  - stub size is independent of every server-supplied field length (§5);
 *  - unparseable `expiresAt` fails closed (§7.4), and so does one rejected
 *    as a field: it's absent as testimony, never read as immortal;
 *  - unknown block types never propagate `undefined` (the pre-existing
 *    convertBlock switches had no default — a latent corruption this module
 *    retires).
 *
 * The ReferenceRegistry is the host-private reference record (§6.2): raw
 * URIs and testimony live here and never in model-visible content. Fetching
 * (§6/§7 origin binding, ceilings, redirects) is deliberately not here yet —
 * the registry is what makes a future host-mediated fetcher and the
 * code-execution materialization hook possible.
 */

import { NON_STRING_TEXT_PLACEHOLDER } from './visible-content.js';

export const REFERENCE_LIMITS = { uri: 4096, mimeType: 255, name: 255, expiresAt: 64 } as const;
export const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const MAX_SAFE = 9007199254740991; // 2^53 - 1
const STUB_FIELD_CHARS = 120;
/** A saved copy's path, as its stub shows it. */
const SAVED_PATH_CHARS = 256;
/** A reference id's random suffix (see ReferenceRegistry.register). */
const REF_ID_SUFFIX_CHARS = 4;

export type ReferenceDisposition = 'never' | 'ref';

export interface ReferenceTestimony {
  uri: string;
  mimeType?: string;
  sizeBytes?: number;
  digest?: string;
  expiresAt?: string;
  name?: string;
  disposition?: ReferenceDisposition;
  rejectedFields: string[];
  truncatedFields: string[];
  /** Set when the testimony is an MCP resource_link's, which claims no
   *  digest, expiry or disposition. A link is registered but never fetched
   *  on the side, and its testimony never replaces a record's (register). */
  fromLink?: true;
}

export type BlockClassification =
  | { kind: 'text' }
  | { kind: 'inline'; contradiction: boolean }
  | { kind: 'reference'; testimony: ReferenceTestimony }
  /** `shown` is what the model-visible lanes put in the block's place. */
  | { kind: 'invalid'; shown: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function takeString(
  raw: unknown, field: keyof typeof REFERENCE_LIMITS & string,
  out: { rejected: string[] },
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') { out.rejected.push(field); return undefined; }
  // JSON Schema maxLength counts Unicode code points, not UTF-16 units.
  // Stop as soon as the optional field is invalid, without allocating a copy
  // of an arbitrarily large server string. Display truncation happens later.
  let length = 0;
  for (const _codePoint of raw) {
    if (++length > REFERENCE_LIMITS[field]) {
      out.rejected.push(field);
      return undefined;
    }
  }
  return raw;
}

export function classifyBlock(block: unknown): BlockClassification {
  if (!isRecord(block) || typeof block.type !== 'string') {
    return { kind: 'invalid', shown: unknownBlockText(block) };
  }
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string'
        ? { kind: 'text' }
        : { kind: 'invalid', shown: NON_STRING_TEXT_PLACEHOLDER };
    case 'image':
    case 'audio': {
      // An empty uri is no link, as the push lane's converter reads it.
      const hasLink = typeof block.uri === 'string' && block.uri !== '';
      if (typeof block.data === 'string') {
        // Inline form claiming bulk disposition (or smuggling a link beside
        // the data) is the vector-2 contradiction: fail closed, withhold.
        return { kind: 'inline', contradiction: block.disposition !== undefined || hasLink };
      }
      if (hasLink) return parseReferenceFields(block);
      return { kind: 'invalid', shown: block.type === 'image' ? IMAGE_NO_DATA_TEXT : AUDIO_NO_DATA_TEXT };
    }
    case 'resource':
      return parseReferenceFields(block);
    case 'resource_link':
      // MCP's link to a resource is a reference too. RFC-005 §8.1 maps it
      // onto the reference record field for field, its `size` as `sizeBytes`,
      // with no disposition: the host's default policy, as for any reference
      // that claims none. Its title, description and annotations aren't
      // testimony.
      return linkTestimony(parseReferenceFields({ uri: block.uri, name: block.name, mimeType: block.mimeType, sizeBytes: block.size }));
    default:
      return { kind: 'invalid', shown: unknownBlockText(block) };
  }
}

/** A link's classification, its testimony marked as a link's (fromLink). */
function linkTestimony(c: BlockClassification): BlockClassification {
  return c.kind === 'reference' ? { kind: 'reference', testimony: { ...c.testimony, fromLink: true } } : c;
}

function parseReferenceFields(block: Record<string, unknown>): BlockClassification {
  if (typeof block.uri !== 'string' || block.uri.length === 0) {
    return { kind: 'invalid', shown: REFERENCE_NO_LINK_TEXT };
  }
  if (block.uri.length > REFERENCE_LIMITS.uri) {
    return { kind: 'invalid', shown: REFERENCE_LINK_TOO_LONG_TEXT };
  }
  const out = { rejected: [] as string[], truncated: [] as string[] };
  const t: ReferenceTestimony = { uri: block.uri, rejectedFields: out.rejected, truncatedFields: out.truncated };
  t.mimeType = takeString(block.mimeType, 'mimeType', out);
  t.name = takeString(block.name, 'name', out);
  t.expiresAt = takeString(block.expiresAt, 'expiresAt', out);
  if (block.sizeBytes !== undefined) {
    const n = block.sizeBytes;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_SAFE) t.sizeBytes = n;
    else out.rejected.push('sizeBytes');
  }
  if (block.digest !== undefined) {
    if (typeof block.digest === 'string' && DIGEST_PATTERN.test(block.digest)) t.digest = block.digest;
    else out.rejected.push('digest');
  }
  if (block.disposition !== undefined) {
    if (block.disposition === 'never' || block.disposition === 'ref') t.disposition = block.disposition;
    else out.rejected.push('disposition');
  }
  return { kind: 'reference', testimony: t };
}

/** RFC-005 vector 2: an inline-data block claiming bulk disposition (or
 *  smuggling a uri beside its data) is an emitter contradiction — the host
 *  fails closed by withholding the inline data from context. Every lane that
 *  handles inline media MUST consult this before its data branch. */
export function isInlineContradiction(block: unknown): boolean {
  const c = classifyBlock(block);
  return c.kind === 'inline' && c.contradiction;
}

export const INLINE_WITHHELD_TEXT =
  '[Content not shown: its inline data arrived marked as a reference too, so this host withheld it.]';

/*
 * What the model-visible lanes (push, channel, context injection and tool
 * results) put in place of a block they can't show as itself. Each says what
 * kind of thing was there and why it can't be seen, in the host's words, so
 * the agent doesn't read the content as complete; there's nothing for the
 * agent to do about any of them. The text marker is NON_STRING_TEXT_PLACEHOLDER
 * (visible-content.ts).
 */
export const IMAGE_NO_MEDIA_TYPE_TEXT = '[Image not shown: its data arrived without a media type.]';
export const IMAGE_NO_DATA_TEXT = '[Image not shown: it arrived with no usable data or link.]';
export const AUDIO_NO_MEDIA_TYPE_TEXT = '[Audio not shown: its data arrived without a media type.]';
/** On the push, channel and context-injection lanes, audio shows only as
 *  inline data, so a plain link isn't enough either. (A tool result's audio
 *  with a link is a reference, as any block with one is there.) */
export const AUDIO_NO_DATA_TEXT = '[Audio not shown: it arrived with no usable inline data.]';
export const REFERENCE_NO_LINK_TEXT = '[Reference not shown: it arrived without a link.]';
export const REFERENCE_LINK_TOO_LONG_TEXT = '[Reference not shown: its link is longer than this host accepts.]';
const UNREADABLE_BLOCK_TEXT = "[Content not shown: a part arrived in a form this host can't read.]";

/** A block of a type the host doesn't show, of no type at all, or no block.
 *  The type is the sender's word, so it's shown as a label is: bounded, with
 *  its controls removed. One that isn't a string is no type, and is never
 *  converted to one. */
export function unknownBlockText(block: unknown): string {
  if (!isRecord(block)) return UNREADABLE_BLOCK_TEXT;
  const label = typeof block.type === 'string' ? sanitizeLabel(block.type, STUB_FIELD_CHARS) : '';
  return label
    ? `[Content not shown: this host can't display "${label}" content.]`
    : '[Content not shown: a part arrived with no type.]';
}

/**
 * Why a reference counts as expired, or null when it doesn't: its expiresAt
 * has passed, doesn't parse, or was rejected as a field (§7.4, §8). A
 * rejected expiry (past its schema maximum, or not a string, null included)
 * is absent as testimony under the one invalid-field rule, but reading that
 * absence as "never expires" would let field invalidity widen exposure:
 * like an unparseable one, it fails closed. A reference that claims no
 * expiry has none.
 */
export function referenceExpiry(
  t: Pick<ReferenceTestimony, 'expiresAt' | 'rejectedFields'>, nowMs = Date.now(),
): 'rejected' | 'unparseable' | 'passed' | null {
  if (t.rejectedFields.includes('expiresAt')) return 'rejected';
  if (t.expiresAt === undefined) return null;
  const exp = Date.parse(t.expiresAt);
  if (Number.isNaN(exp)) return 'unparseable';
  return exp <= nowMs ? 'passed' : null;
}

export function isReferenceExpired(t: Pick<ReferenceTestimony, 'expiresAt' | 'rejectedFields'>, nowMs = Date.now()): boolean {
  return referenceExpiry(t, nowMs) !== null;
}

/** Each expiry case in the agent's words, as the stub, the fetcher's refusal
 *  and save_recent_image's refusal all say it. */
export const EXPIRY_REASON = {
  passed: 'expired',
  unparseable: "treated as expired, since its expiry time can't be read",
  rejected: "treated as expired, since its expiry time isn't in a form this host accepts",
} as const;

/** A reference registered with no server, in the agent's words, as the stub,
 *  the fetcher's refusal and save_recent_image's all say it: the fetcher dials
 *  only through a server that delivered the reference. */
export const UNBOUND_REASON = "not tied to any server, so there's nowhere to fetch it from";

/** The refusal for a server the host has no address to dial, one it doesn't
 *  connect to over a network, such as a stdio server, as a clause that
 *  completes "couldn't fetch <ref>: " and says so of the server: the fetcher
 *  dials only through a server's address. A reference's stub, fetch_reference
 *  and save_recent_image all give it (dialCheck). */
export function noAddressReason(serverId: string): string {
  return `this host doesn't connect to the "${serverId}" server over a network, so there's nowhere to fetch it from`;
}

/** A server's id as the agent reads it in a stub or a refusal: as a label
 *  is, bounded and with its controls removed. */
export function shownServerId(serverId: string): string {
  return sanitizeLabel(serverId, STUB_FIELD_CHARS);
}

/**
 * Query and fragment parameters that carry a credential, by name, compared
 * by their letters and digits alone, without letter case, so `access_token`,
 * `accessToken`, `access-token` and `access_token[]` are one name. RFC-005 §5: "Signed URLs and query capabilities are
 * bearer credentials that look like locations", so a uri is shown only where
 * the host's policy classifies it as non-capability-bearing, which here is
 * one with no userinfo and none of these parameters (uriMayCarryCredential).
 * For example:
 * - AWS's signed URLs: `https://b.s3.amazonaws.com/k?X-Amz-Algorithm=…&X-Amz-Credential=…&X-Amz-Security-Token=…&X-Amz-Signature=…`
 * - Google Cloud Storage's: `https://storage.googleapis.com/b/k?X-Goog-Algorithm=…&X-Goog-Credential=…&X-Goog-Signature=…`
 * - Azure's shared access signatures: `https://a.blob.core.windows.net/c/b?sv=…&se=…&sp=r&sig=…`
 * - CloudFront's: `https://d1.cloudfront.net/k?Expires=…&Signature=…&Key-Pair-Id=…`, or `?Policy=…&Signature=…&Key-Pair-Id=…`
 * - Discord's CDN: `https://cdn.discordapp.com/attachments/1/2/f.png?ex=…&is=…&hm=…`
 * - Backblaze B2's: `https://f000.backblazeb2.com/file/b/k?Authorization=…`
 * - OAuth's: `#access_token=…&token_type=bearer`, `#id_token=…`, `?refresh_token=…`, `?client_secret=…`,
 *   and OAuth 1.0a's `?oauth_token=…&oauth_signature=…`
 * - the generic: `?token=…`, `?auth=…`, `?key=…`, `?apikey=…`, `?api_key=…`, `?x-api-key=…`, `?private_token=…`,
 *   `?secret=…`, `?password=…`, `?signature=…`
 * A credential named otherwise, or carried in a path, such as a webhook's
 * `https://discord.com/api/webhooks/<id>/<token>`, isn't caught.
 */
const CREDENTIAL_PARAMETERS: ReadonlySet<string> = new Set([
  'x-amz-signature', 'x-amz-credential', 'x-amz-security-token',
  'x-goog-signature', 'x-goog-credential',
  'sig',
  'signature', 'key-pair-id', 'policy',
  'hm',
  'authorization',
  'access_token', 'id_token', 'refresh_token', 'client_secret',
  'oauth_token', 'oauth_signature',
  'token', 'auth', 'key', 'api_key', 'x-api-key', 'private_token', 'secret', 'password',
].map(credentialName));

/** A parameter's name as CREDENTIAL_PARAMETERS compares it: its letters and
 *  digits alone, in lower case. */
function credentialName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Whether a uri may carry a credential: userinfo, or a query or fragment
 * parameter named on CREDENTIAL_PARAMETERS with a value, a fragment read as
 * `name=value&…` as a query is. A name with no value carries nothing, as an
 * anchor (`#token`) or `?token=` doesn't. A `?` or `;` inside either may
 * separate parameters too, as in a route kept in a fragment
 * (`#/reset?token=…`), so the parameters are read both with and without
 * them as separators, and one with a value in either reading counts. A uri
 * that doesn't parse, even as a relative reference, may, since its parts
 * can't be read.
 */
export function uriMayCarryCredential(uri: string): boolean {
  let u: URL;
  try {
    // Absolute first: against an http base, `http:user:pass@host` would read
    // as a relative path and hide its userinfo.
    u = new URL(uri);
  } catch {
    try {
      u = new URL(uri, 'http://relative.invalid/');
    } catch {
      return true;
    }
  }
  if (u.username !== '' || u.password !== '') return true;
  // Read both ways: with '&' alone separating parameters, as a server
  // reading the query as WHATWG does sees them, and with '?' and ';' too, so
  // a value that opens with one (`token=;…`) still counts in the first.
  const named = (params: string) => [params, params.replace(/[?;]/g, '&')].some((read) =>
    [...new URLSearchParams(read).entries()]
      .some(([name, value]) => value !== '' && CREDENTIAL_PARAMETERS.has(credentialName(name))));
  return named(u.search) || named(u.hash.slice(1));
}

/** How the host reaches a server, as far as fetching its references goes:
 *  the url it dials the server at, or none, for a server it doesn't connect
 *  to over a network, such as a stdio server. A framework records each of its
 *  servers' in the registry (ReferenceRegistry.setServerAddress), where a
 *  stub reads it; its fetcher reads the same from the framework's own
 *  configs, beside each server's credential. */
export type ServerAddress = { url: string } | 'no-address';

/** Why a fetch of a reference failed, or would be refused before it dials. */
export interface Refusal {
  /** What happened, as a clause that completes "couldn't fetch <ref>: ",
   *  whatever it's about: fetch_reference's sentence, save_recent_image's,
   *  and the eager and script-demand fetches' log lines read it. */
  error: string;
  /** What calling again can do, as a sentence. fetch_reference and
   *  save_recent_image show it; the eager and script-demand fetches log the
   *  error alone, and a reference's stub never shows it. */
  remedy: string;
  /** How the reference's stub words it, where the clause names parts of the
   *  uri the stub never shows. A stub shows this or the clause. */
  inStub?: string;
}

// What calling again can do, for the refusals a reference's stub shares with
// a fetch; the fetcher has these and its own. None names a tool: a fetch
// doesn't know where its reference came from.
export const NOTHING_TO_DO = "Calling again won't change that.";
/** The registry keys a record by its uri, so a fresh reference to the same
 *  uri arrives as this very id and refreshes its record. */
export const FRESH_REFERENCE = "Once a fresh reference to it arrives, fetching may work; until then, fetching it again won't.";
/** A server's address is read from the host's configs as they are at each
 *  fetch. */
export const SERVER_BACK = "Calling again won't change that unless whoever runs this host adds that server back.";
const SERVER_ADDRESS = "Calling again won't change that unless whoever runs this host corrects the server's address.";

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

/** A server's address as it's configured, its scheme and host, for a
 *  clause: never its userinfo, path or query. URL's own origin is 'null' for
 *  a scheme that isn't special, which normalizedOrigin accepts. The caller
 *  has already parsed it. */
function configuredOrigin(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

/** The §6.1/§7.1 policy check of a uri against the url a server is dialed
 *  at: null where a fetch through that server may fetch it. */
function originRefusal(uri: string, serverUrl: string, serverId: string): Refusal | null {
  const refOrigin = normalizedOrigin(uri);
  if (!refOrigin) return { error: "its address doesn't parse as a URL", remedy: NOTHING_TO_DO };
  // A server's address that doesn't parse leaves nothing to dial. The
  // framework's resolver gives only an address its transport dials, so this
  // guards other resolvers.
  const dialedOrigin = normalizedOrigin(serverUrl);
  if (!dialedOrigin) {
    return {
      error: `the "${shownServerId(serverId)}" server's address doesn't parse as a URL, so there's nowhere to fetch it from`,
      remedy: SERVER_ADDRESS,
    };
  }
  const refUrl = new URL(uri);
  // A user name or password in the uri is a credential embedded in it,
  // which RFC-005 §6.1 forbids a server to mint and lets a host refuse
  // (vector 6). This host neither sends nor repeats it: fetch refuses such
  // a url with a message that holds it whole.
  if (refUrl.username !== '' || refUrl.password !== '') {
    return { error: "its address carries a user name or password, which this host doesn't send", remedy: NOTHING_TO_DO };
  }
  // The uri's own scheme, not its origin's: an origin reads ws: as http:
  // and wss: as https:, and fetch refuses a ws: or wss: uri ('unknown
  // scheme') before connecting, which would read as a failed request a
  // later try can mend.
  const scheme = refUrl.protocol;
  if (scheme !== 'https:' && scheme !== 'http:') {
    return {
      error: `its address uses ${sanitizeLabel(scheme, STUB_FIELD_CHARS)}, and this host fetches only http: and https: addresses`,
      remedy: NOTHING_TO_DO,
      inStub: 'scheme not allowed: this host fetches only http and https uris',
    };
  }
  // Origins compare with their schemes, so this also refuses an http:
  // reference from a server dialed over TLS (wss://).
  if (refOrigin !== dialedOrigin) {
    return {
      error: `it points to ${refOrigin}, not to the "${shownServerId(serverId)}" server's own address (${configuredOrigin(serverUrl)}), ` +
        'and this host fetches only from the server itself',
      remedy: NOTHING_TO_DO,
      inStub: "third-party origin: it isn't on its server's own address, so this host doesn't fetch it",
    };
  }
  return null;
}

/**
 * The server a fetch of a reference would dial: its servers, in the order
 * they delivered it, the first whose address is on the uri's origin (§6.2).
 * When none is, the first server's refusal (unknown to this host, with no
 * address, or the origin check's), and for a record no server delivered,
 * that it's unbound, which a later delivery of the uri by a server mends.
 */
export function dialServer(
  record: ReferenceRecord,
  addressOf: (serverId: string) => ServerAddress | undefined,
): { serverId: string } | { refusal: Refusal } {
  let refusal: Refusal | undefined;
  let dialed: string | undefined;
  for (const serverId of record.serverIds) {
    const address = addressOf(serverId);
    if (address === undefined) {
      refusal ??= { error: `this host no longer has the "${shownServerId(serverId)}" server it came from`, remedy: SERVER_BACK };
    } else if (address === 'no-address') {
      refusal ??= { error: noAddressReason(shownServerId(serverId)), remedy: NOTHING_TO_DO };
    } else {
      const offOrigin = originRefusal(record.testimony.uri, address.url, serverId);
      if (offOrigin === null) {
        dialed = serverId;
        break;
      }
      refusal ??= offOrigin;
    }
  }
  return dialed === undefined
    ? { refusal: refusal ?? { error: `it's ${UNBOUND_REASON}`, remedy: FRESH_REFERENCE } }
    : { serverId: dialed };
}

/**
 * Where a fetch of a reference would dial, or why it would be refused before
 * dialing, whatever the fetch: dialServer's server, then the reference's
 * expiry. A pure function of the record and the servers' addresses: a
 * reference's stub asks it of the registry's (unfetchableReason), and the
 * fetcher's pre-dial check of its own framework's configs, whose credential
 * goes with the address it checks. In a process with one framework, or with
 * frameworks that agree on each id they share, the two sources hold the same
 * addresses, so a stub promises what the fetch does. Where two frameworks
 * configure one id differently, only a stub's words can be wrong, never where
 * a token goes. A fetch's own limits, its budget and ceiling, come after it.
 */
export function dialCheck(
  record: ReferenceRecord,
  addressOf: (serverId: string) => ServerAddress | undefined,
  nowMs = Date.now(),
): { serverId: string } | { refusal: Refusal } {
  const server = dialServer(record, addressOf);
  if ('refusal' in server) return server;
  const expiry = referenceExpiry(record.testimony, nowMs);
  return expiry ? { refusal: { error: `the reference is ${EXPIRY_REASON[expiry]}`, remedy: FRESH_REFERENCE } } : server;
}

/** Strip control characters (C0, DEL, C1), every bidi control (marks,
 *  embeddings, overrides, isolates, and the Arabic letter mark) and the line
 *  and paragraph separators (U+2028, U+2029), which a regex reads as line
 *  ends, so a label can't start a line of its own, such as one the image
 *  ledger would read as a slot. Then trim the whitespace (a BOM included)
 *  left at either end, and bound the length. Labels are labels — storage
 *  naming is host-generated elsewhere (§7.3). */
export function sanitizeLabel(s: string, maxChars: number): string {
  const cleaned = s.replace(/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu, '').trim();
  if (cleaned.length <= maxChars) return cleaned;
  let cut = cleaned.slice(0, Math.max(0, maxChars - 1));
  // never split a surrogate pair at the truncation boundary
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + '…';
}

export function formatSizeBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `~${Math.round(n / 1024)}KB`;
  if (n < 1024 * 1024 * 1024) return `~${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `~${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ============================================================================
// Host-private reference record (§6.2) + reference ids (§5)
// ============================================================================

export interface ReferenceRecord {
  refId: string;
  /** The servers whose content delivered this uri, each once, in the order
   *  they did (§6.2). The fetcher dials through the first whose address is on
   *  the uri's origin. Empty when no server delivered it, as for a reference
   *  in a module's own tool result. */
  serverIds: string[];
  testimony: ReferenceTestimony;
  receivedAt: number;
  /** Set by the host-mediated fetcher after a successful, verified fetch. */
  fetchedPath?: string;
  verifiedBytes?: number;
  verifiedMimeType?: string;
  digestVerified?: boolean;
}

const MAX_RECORDS = 2000;

/**
 * Host-private store of received references. Raw URIs live here and in stubs
 * never (under `never`) or by policy only (`ref`/absent). Ids are stable and
 * never reused within the process (vector 20). Past MAX_RECORDS the record
 * registered least recently is evicted (registering a uri the registry holds
 * makes its record the newest), and a stale lookup returns undefined — a
 * defined miss, never a different record.
 *
 * Process-wide singleton by design: ids are host-local *names*, not
 * capabilities, and the record carries the servers that delivered it for the
 * origin-bound fetcher.
 */
export class ReferenceRegistry {
  private records = new Map<string, ReferenceRecord>();
  /** uri → refId. The uri ALONE is the identity key: a tool result's stubs
   *  (tool-result-history.ts's, and framework.ts's tryNativeToolResultContent)
   *  and a script's demand fetch register with no server context,
   *  while the registrations that know the server carry its id: a tool
   *  result's, before it's shown, whether the agent's dispatch or an
   *  in-process caller made the call, and convertBlock's, for push events,
   *  render results, channel messages and context injections. Keying on both
   *  split every reference into two records, the model-visible one unbound
   *  (fetch_reference failed on it) and the bound one invisible. One key, and
   *  each registration that knows its server ADDS that server to the record,
   *  once, in the order they came, instead of forking it. When several
   *  servers deliver one uri, the fetcher dials through the first whose
   *  address is on the uri's origin, so a server off that origin delivering
   *  it first doesn't decide whether it can be fetched; among servers on that
   *  origin, the first to deliver it is dialed. A server's token goes only to
   *  its own origin, for a uri it delivered. */
  private byKey = new Map<string, string>();
  private counter = 0;

  register(testimony: ReferenceTestimony, serverId?: string): ReferenceRecord {
    const existingId = this.byKey.get(testimony.uri);
    if (existingId !== undefined) {
      const existing = this.records.get(existingId);
      if (existing) {
        if (serverId !== undefined && !existing.serverIds.includes(serverId)) {
          existing.serverIds.push(serverId);
        }
        // Refresh testimony while unfetched: a re-issued reference with a new
        // digest/expiry supersedes the stale claims. Once fetched, the record
        // describes verified bytes on disk and keeps the testimony they were
        // verified against. A link claims no digest, expiry or disposition,
        // so its testimony never replaces a record's claims.
        if (!existing.fetchedPath && !testimony.fromLink) existing.testimony = testimony;
        // Newest again, so a uri just mentioned is the last to be evicted.
        this.records.delete(existingId);
        this.records.set(existingId, existing);
        return existing;
      }
    }
    const refId = `ref_${(++this.counter).toString(36)}_${Math.random().toString(36).slice(2, 2 + REF_ID_SUFFIX_CHARS)}`;
    const record: ReferenceRecord = { refId, serverIds: serverId === undefined ? [] : [serverId], testimony, receivedAt: Date.now() };
    this.records.set(refId, record);
    this.byKey.set(testimony.uri, refId);
    if (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) {
        const old = this.records.get(oldest);
        this.records.delete(oldest);
        if (old) this.byKey.delete(old.testimony.uri);
      }
    }
    return record;
  }

  get(refId: string): ReferenceRecord | undefined {
    return this.records.get(refId);
  }

  /** How the host reaches each server, by id, as each framework in the process
   *  configured it, which a reference's stub reads (unfetchableReason). A
   *  fetch reads its own framework's configs instead, so a server's token only
   *  ever goes to the origin its own config names. Keyed by id as a record's
   *  servers are: where two frameworks configure one id, the latest entry is
   *  in force, and a stub's words can be wrong for the other one's fetch. */
  private addresses = new Map<string, Array<{ owner: object; address: ServerAddress }>>();

  /** Record how the host reaches a server, as a framework (`owner`) does for
   *  each server it configures. Its entry for the id is then in force. */
  setServerAddress(serverId: string, address: ServerAddress, owner: object): void {
    const entries = (this.addresses.get(serverId) ?? []).filter((e) => e.owner !== owner);
    entries.push({ owner, address });
    this.addresses.set(serverId, entries);
  }

  /** Take back a framework's entry for a server, as it does for a server it
   *  removes, and for each of its servers when it stops. Another framework's
   *  entry for the id, if any, is in force again; with none, a stub reads the
   *  id's references as an unknown server's. After a removal, that framework's
   *  fetch refuses them too. A stopped framework keeps its configs, so its
   *  fetcher, called before it starts again, can still dial them. */
  forgetServerAddress(serverId: string, owner: object): void {
    const entries = (this.addresses.get(serverId) ?? []).filter((e) => e.owner !== owner);
    if (entries.length > 0) this.addresses.set(serverId, entries);
    else this.addresses.delete(serverId);
  }

  serverAddress(serverId: string): ServerAddress | undefined {
    return this.addresses.get(serverId)?.at(-1)?.address;
  }

  /** Find the record for a uri. */
  findByUri(uri: string): ReferenceRecord | undefined {
    const id = this.byKey.get(uri);
    return id !== undefined ? this.records.get(id) : undefined;
  }
}

export const referenceRegistry = new ReferenceRegistry();

// ============================================================================
// Stub building (§5)
// ============================================================================

/** A reference's type as its stub shows one, or '' when nothing is left of
 *  it once sanitized (the stub then leaves it out). */
export function referenceTypeLabel(mimeType: string | undefined): string {
  return mimeType ? sanitizeLabel(mimeType, STUB_FIELD_CHARS) : '';
}

/**
 * The longest stub buildReferenceStub writes, in UTF-16 code units, from its
 * own bounds: the longest id the registry mints, then the name, the type with
 * the largest size it shows, and the origin, each at its bound, and the
 * longest ending, a saved copy's path, with their separators. The other
 * endings, the fetch hint and the reasons a fetch would be refused, are
 * shorter. A line shaped like a stub but longer than this is quoted text the
 * writer can't have written, and no image slot (tool-image-ledger.ts). A
 * tool result's link line (StubOptions.unfetchedLinkUri) isn't shaped like a
 * stub, so it's no slot whatever its length.
 */
export const REFERENCE_STUB_MAX_CHARS =
  `[ref_${MAX_SAFE.toString(36)}_] `.length + REF_ID_SUFFIX_CHARS
  + STUB_FIELD_CHARS
  + ' — '.length + STUB_FIELD_CHARS + ', '.length + `${formatSizeBytes(MAX_SAFE)} claimed`.length
  + ' — '.length + STUB_FIELD_CHARS
  + ' — '.length + 'saved: '.length + SAVED_PATH_CHARS;

/** How a lane shows a reference beyond its stub. */
export interface StubOptions {
  /**
   * Show a link (MCP's resource_link) the host can't fetch as its name, uri
   * and type, unless its uri may carry a credential (uriMayCarryCredential).
   * For a tool result's links, whose JSON showed every link's uri before
   * this host read links as references: there the uri is the agent's only
   * handle on a link the host can't fetch, and showing it is §5's MAY for a
   * reference the host's policy classifies as non-capability-bearing. No
   * other lane showed a link's uri, so none shows one now.
   */
  unfetchedLinkUri?: boolean;
}

/**
 * Build the model-visible stub for a reference. Its length is bounded by
 * host constants and independent of every server-supplied field's length:
 * REFERENCE_STUB_MAX_CHARS. Under `disposition:"never"` the uri is omitted
 * unconditionally; under `ref`/absent it is omitted too — this host's default
 * policy is the opaque id everywhere (the safe default of §5), with retrieval
 * via the record. The one exception is a tool result's link the host can't
 * fetch (StubOptions.unfetchedLinkUri), which is no stub but a line of its
 * own, its uri bounded by REFERENCE_LIMITS.uri.
 */
export function buildReferenceStub(t: ReferenceTestimony, provenance?: string, serverId?: string, options?: StubOptions): string {
  const record = referenceRegistry.register(t, serverId);
  const parts: string[] = [];
  // A label is shown only when something is left of it once sanitized.
  const name = t.name ? sanitizeLabel(t.name, STUB_FIELD_CHARS) : '';
  if (name) parts.push(name);
  const meta: string[] = [];
  const mimeType = referenceTypeLabel(t.mimeType);
  if (mimeType) meta.push(mimeType);
  if (t.sizeBytes !== undefined) meta.push(`${formatSizeBytes(t.sizeBytes)} claimed`);
  if (meta.length) parts.push(meta.join(', '));
  const origin = provenance ? sanitizeLabel(provenance, STUB_FIELD_CHARS) : '';
  if (origin) parts.push(origin);
  if (record.fetchedPath) {
    // Already materialized by the host-mediated fetcher: hand the model the
    // workspace path (host-generated, §7.3) so existing tools just work.
    parts.push(`saved: ${sanitizeLabel(record.fetchedPath, SAVED_PATH_CHARS)}`);
  } else {
    // A reference the fetcher would refuse says why, rather than inviting a
    // fetch_reference call.
    const refusal = unfetchableReason(record);
    if (refusal !== null && t.fromLink && options?.unfetchedLinkUri && record.testimony.disposition !== 'never') {
      // The credential check reads the uri as it would be shown, with what
      // sanitizeLabel strips gone, so a uri split by a control character is
      // read as it would read: `ht\u0000tps://user:pass@…` parses as a path,
      // and shows as userinfo. A reference's disposition:"never" for the uri
      // keeps it out whatever the link says.
      const uri = sanitizeLabel(t.uri, REFERENCE_LIMITS.uri);
      if (!uriMayCarryCredential(uri)) return unfetchedLinkText(t, uri);
    }
    parts.push(refusal ?? 'fetch with fetch_reference');
  }
  return `[${record.refId}] ${parts.join(' — ') || 'referenced content'}`;
}

/**
 * What a tool result's link the host can't fetch shows, where its uri can't
 * carry a credential: its name, its uri and its type, as a standard MCP
 * server's link shows (StubOptions.unfetchedLinkUri).
 */
function unfetchedLinkText(t: ReferenceTestimony, uri: string): string {
  const name = t.name ? sanitizeLabel(t.name, STUB_FIELD_CHARS) : '';
  const mimeType = referenceTypeLabel(t.mimeType);
  return `[resource link${name ? ` "${name}"` : ''}: ${uri}${mimeType ? `, ${mimeType}` : ''}; not fetched]`;
}

/**
 * Why the fetcher would refuse a reference before it dials, whatever the
 * fetch, in its stub's words: the registry's dialCheck, from its record and
 * its servers' addresses. Null for a saved copy, which the fetcher serves
 * before any check, and where a fetch would dial. A fetch's own limits, the
 * server's spent budget or a claimed size over the ceiling it's given, the
 * fetcher gives in its own words, and save_recent_image says them too.
 */
export function unfetchableReason(record: ReferenceRecord, nowMs = Date.now()): string | null {
  if (record.fetchedPath) return null;
  const dial = dialCheck(record, (serverId) => referenceRegistry.serverAddress(serverId), nowMs);
  return 'refusal' in dial ? dial.refusal.inStub ?? dial.refusal.error : null;
}

/**
 * RFC-005 treatment for one MCPL wire block, for the model-visible text
 * lanes. Returns a replacement string, or null when the block should keep
 * its existing (inline/text) handling.
 */
export function referenceStubOrNull(block: unknown, provenance?: string, serverId?: string, options?: StubOptions): string | null {
  const c = classifyBlock(block);
  switch (c.kind) {
    case 'text': return null;
    case 'inline':
      return c.contradiction ? INLINE_WITHHELD_TEXT : null;
    case 'reference': return buildReferenceStub(c.testimony, provenance, serverId, options);
    case 'invalid': return c.shown;
  }
}
