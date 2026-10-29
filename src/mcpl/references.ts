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
 * URIs and testimony live here, and model-visible content shows a uri only
 * as a tool result's link line shows one (shownLinkUri). Fetching
 * (§6/§7 origin binding, ceilings, redirects) is deliberately not here yet —
 * the registry is what makes a future host-mediated fetcher and the
 * code-execution materialization hook possible.
 */
import { cutToFit, suppliedValue } from '../supplied-text.js';
import { NOTICE_TAG } from '../notice-tags.js';


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
  /** Set when the testimony is an MCP resource_link's, which claims no
   *  digest, expiry or disposition. A link is registered but never fetched
   *  on the side, and its testimony never replaces a record's (register). */
  fromLink?: true;
}

export type BlockClassification =
  | { kind: 'text' }
  | { kind: 'inline'; contradiction: boolean }
  | { kind: 'reference'; testimony: ReferenceTestimony }
  /** MCP's embedded resource (embeddedResourceContents): each lane shows
   *  its contents as it shows the block they make. */
  | { kind: 'embedded'; contents: EmbeddedContents }
  /** `shown` is what the model-visible lanes put in the block's place. */
  | { kind: 'invalid'; shown: string };

/** What an embedded resource's contents are shown as: the ordinary block
 *  they make, withheld inline data, or a marker saying why they aren't
 *  shown. */
export type EmbeddedContents =
  | { kind: 'block'; block: { type: 'text'; text: string } | { type: 'image' | 'audio'; data: string; mimeType: string } }
  | { kind: 'withheld' }
  | { kind: 'marker'; text: string };

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
    case 'resource': {
      const contents = embeddedResourceContents(block);
      return contents ? { kind: 'embedded', contents } : parseReferenceFields(block);
    }
    case 'resource_link':
      // MCP's link to a resource is a reference too. RFC-005 §8.1 maps it
      // onto the reference record field for field, its `size` as `sizeBytes`,
      // with no disposition: the host's default policy, as for any reference
      // that claims none. Its title, description and annotations aren't
      // testimony.
      // A link's size is MCP's `size`; the script lane's object for a link
      // names it `sizeBytes`, so given again it reads the same, where
      // sanitizeLabel left its uri as it was. Read on every lane, so a
      // peer's link that names a `sizeBytes` is labelled with it too.
      return linkTestimony(parseReferenceFields({ uri: block.uri, name: block.name, mimeType: block.mimeType, sizeBytes: block.size ?? block.sizeBytes }));
    default:
      return { kind: 'invalid', shown: unknownBlockText(block) };
  }
}

/**
 * MCP's EmbeddedResource: a `resource` block with no uri of its own whose
 * `resource` is a record with a string `uri`. RFC-005 §8.1 reads it as "an
 * ordinary inline block, nothing new", so its contents show as the block
 * they make: with exactly one of a string `text` or a string `blob`
 * (base64), its text as text, and its blob as the inline image or audio its
 * media type makes it, or as a marker for any other type; with both or
 * neither, the marker saying its contents can't be read. Its uri is never shown, since
 * no lane RFC-005 governs showed it before and nothing here can tell a
 * capability in a uri from a location. A disposition on it is inline
 * content claiming bulk disposition (RFC-005 vector 2), so it's withheld.
 * Null for any other block, among them MCPL's reference, whose uri is its
 * own.
 */
function embeddedResourceContents(block: Record<string, unknown>): EmbeddedContents | null {
  if (block.uri !== undefined && block.uri !== null && block.uri !== '') return null;
  if (!isRecord(block.resource) || typeof block.resource.uri !== 'string') return null;
  const { text, blob, mimeType } = block.resource;
  if (block.disposition !== undefined) return { kind: 'withheld' };
  if ((typeof text === 'string') === (typeof blob === 'string')) return { kind: 'marker', text: EMBEDDED_RESOURCE_UNREADABLE_TEXT };
  if (typeof text === 'string') return { kind: 'block', block: { type: 'text', text } };
  const data = blob as string;
  const type = typeof mimeType === 'string' ? mimeType : '';
  // image/* or audio/*, with a subtype: a bare `image` is no media type a
  // block can carry, so it reads as any other type does.
  const family = /^(image|audio)\/[^/]/i.exec(type)?.[1]?.toLowerCase() as 'image' | 'audio' | undefined;
  if (family) return { kind: 'block', block: { type: family, data, mimeType: type } };
  if (type === '') return { kind: 'marker', text: EMBEDDED_RESOURCE_NO_MEDIA_TYPE_TEXT };
  return { kind: 'marker', text: embeddedBinaryText(type, data) };
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
  const out = { rejected: [] as string[] };
  const t: ReferenceTestimony = { uri: block.uri, rejectedFields: out.rejected };
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
  `[${NOTICE_TAG.contentNotShown}: its inline data arrived marked as a reference too, so this host withheld it.]`;

/*
 * What the model-visible lanes (push, channel, context injection and tool
 * results) put in place of a block they can't show as itself. Each says what
 * kind of thing was there and why it can't be seen, in the host's words, so
 * the agent doesn't read the content as complete; there's nothing for the
 * agent to do about any of them. The text marker is NON_STRING_TEXT_PLACEHOLDER
 * (visible-content.ts).
 */
export const IMAGE_NO_MEDIA_TYPE_TEXT = `[${NOTICE_TAG.imageNotShown}: its data arrived without a media type.]`;
export const IMAGE_NO_DATA_TEXT = `[${NOTICE_TAG.imageNotShown}: it arrived with no usable data or link.]`;
export const AUDIO_NO_MEDIA_TYPE_TEXT = `[${NOTICE_TAG.audioNotShown}: its data arrived without a media type.]`;
/** On the push, channel and context-injection lanes, audio shows only as
 *  inline data, so a plain link isn't enough either. (A tool result's audio
 *  with a link is a reference, as any block with one is there.) */
export const AUDIO_NO_DATA_TEXT = `[${NOTICE_TAG.audioNotShown}: it arrived with no usable inline data.]`;
/** MCP's embedded resource whose contents are neither text nor a blob, or
 *  both. */
export const EMBEDDED_RESOURCE_UNREADABLE_TEXT = `[${NOTICE_TAG.resourceNotShown}: its contents arrived as neither text nor data, or as both.]`;
/** MCP's embedded resource whose blob has no media type, so it can't be
 *  shown as an image or audio. */
export const EMBEDDED_RESOURCE_NO_MEDIA_TYPE_TEXT = `[${NOTICE_TAG.resourceNotShown}: its data arrived without a media type.]`;

/** MCP's embedded resource whose blob is of a type no lane can show: what
 *  it was, by its type and size. Made well formed (a lone UTF-16 surrogate
 *  becomes U+FFFD), as a stub is (#695), since it names the block's media
 *  type, whose lone surrogates referenceTypeLabel leaves as they are: every
 *  lane then shows the same text. */
export function embeddedBinaryText(mimeType: string, blob: string): string {
  const what = [referenceTypeLabel(mimeType), formatSizeBytes(Math.floor(blob.length * 3 / 4))].filter(Boolean).join(', ');
  return `[${NOTICE_TAG.resourceNotShown}: this host can't display its data (${what}).]`.toWellFormed();
}
/**
 * What the converter (convertBlock, on every lane) shows for a text
 * block whose text isn't a string, which only a nonconformant sender writes,
 * so the agent learns that a block was there. It is the host's word, not the
 * sender's, so it never makes content visible (isVisiblyEmptyConversion in
 * visible-content.ts, which re-exports it).
 */
export const NON_STRING_TEXT_PLACEHOLDER = `[${NOTICE_TAG.textNotShown}: a text part arrived without readable text.]`;
export const REFERENCE_NO_LINK_TEXT = `[${NOTICE_TAG.referenceNotShown}: it arrived without a link.]`;
export const REFERENCE_LINK_TOO_LONG_TEXT = `[${NOTICE_TAG.referenceNotShown}: its link is longer than this host accepts.]`;
const UNREADABLE_BLOCK_TEXT = `[${NOTICE_TAG.contentNotShown}: a part arrived in a form this host can't read.]`;

/** A block of a type the host doesn't show, of no type at all, or no block.
 *  The type is the sender's word, so it's shown as a label is: bounded, with
 *  its controls removed. One that isn't a string is no type, and is never
 *  converted to one. */
export function unknownBlockText(block: unknown): string {
  if (!isRecord(block)) return UNREADABLE_BLOCK_TEXT;
  const label = typeof block.type === 'string' ? suppliedLabel(block.type, STUB_FIELD_CHARS) : '';
  return label
    ? `[${NOTICE_TAG.contentNotShown}: this host can't display "${label}" content.]`
    : `[${NOTICE_TAG.contentNotShown}: a part arrived with no type.]`;
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
 * one with no userinfo and none of these parameters, nor any uri in a
 * parameter's value that has them (uriMayCarryCredential).
 * For example:
 * - AWS's signed URLs: `https://b.s3.amazonaws.com/k?X-Amz-Algorithm=…&X-Amz-Credential=…&X-Amz-Security-Token=…&X-Amz-Signature=…`
 * - Google Cloud Storage's: `https://storage.googleapis.com/b/k?X-Goog-Algorithm=…&X-Goog-Credential=…&X-Goog-Signature=…`
 * - Azure's shared access signatures: `https://a.blob.core.windows.net/c/b?sv=…&se=…&sp=r&sig=…`
 * - CloudFront's: `https://d1.cloudfront.net/k?Expires=…&Signature=…&Key-Pair-Id=…`, or `?Policy=…&Signature=…&Key-Pair-Id=…`
 * - Discord's CDN: `https://cdn.discordapp.com/attachments/1/2/f.png?ex=…&is=…&hm=…`
 * - Backblaze B2's: `https://f000.backblazeb2.com/file/b/k?Authorization=…`
 * - OAuth's: `#access_token=…&token_type=bearer`, `#id_token=…`, `?refresh_token=…`, `?client_secret=…`,
 *   and OAuth 1.0a's `?oauth_token=…&oauth_signature=…`
 * - the generic: `?token=…`, `?auth=…`, `?auth_token=…`, `?key=…`, `?apikey=…`, `?api_key=…`, `?api_token=…`,
 *   `?x-api-key=…`, `?private_token=…`, `?secret=…`, `?password=…`, `?signature=…`
 * - a session's id, a bearer credential too: `?session_id=…`, `?jsessionid=…` (in a path, as
 *   `;jsessionid=…` usually rides, it isn't read)
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
  'token', 'auth', 'auth_token', 'key', 'api_key', 'api_token', 'x-api-key', 'private_token', 'secret', 'password',
  'session_id', 'jsessionid',
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
 * (`#/reset?token=…`), so the parameters are read both with and without them
 * as separators, and one with a value in either reading counts. A
 * parameter's value that is itself a uri is read the same way
 * (nestedMayCarry): an absolute one, as an image proxy's `?url=<a
 * percent-encoded signed URL>` is once decoded; a protocol-relative one, or
 * a relative one with a query or fragment, as a login's
 * `?next=%2Freset%3Ftoken%3D…` is; and one encoded again inside the value,
 * as a redirector that encodes an already encoded url leaves it, each read
 * and each decode a level of its own. That goes up to CREDENTIAL_NESTING
 * levels deep, and a uri reached deeper may carry one, since a bound that
 * let the next level through would be the same gap one level down. A uri
 * carried in another encoding, such as base64, isn't read. A uri that
 * doesn't parse, even as a relative reference, may, since its parts can't be
 * read.
 */
export function uriMayCarryCredential(uri: string): boolean {
  let u: URL;
  try {
    // Absolute first: against an http base, `http:user:pass@host` would read
    // as a relative path and hide its userinfo.
    u = new URL(uri);
  } catch {
    try {
      u = new URL(uri, RELATIVE_BASE);
    } catch {
      return true;
    }
  }
  return urlMayCarryCredential(u, 0);
}

/** The base a relative uri is read against: it supplies only a scheme and a
 *  path, and a credential lives in the uri's own authority, query or
 *  fragment. */
const RELATIVE_BASE = 'http://relative.invalid/';

/** How deep uriMayCarryCredential reads uris nested in parameters' values,
 *  each one a parameter's value in the uri before it. */
const CREDENTIAL_NESTING = 4;

function urlMayCarryCredential(u: URL, depth: number): boolean {
  if (u.username !== '' || u.password !== '') return true;
  // Read both ways: with '&' alone separating parameters, as a server
  // reading the query as WHATWG does sees them, and with '?' and ';' too, so
  // a value that opens with one (`token=;…`) still counts in the first.
  const named = (params: string) => [params, params.replace(/[?;]/g, '&')].some((read) =>
    [...new URLSearchParams(read).entries()].some(([name, value]) => value !== ''
      && (CREDENTIAL_PARAMETERS.has(credentialName(name)) || nestedMayCarry(value, depth))));
  return named(u.search) || named(u.hash.slice(1));
}

/** Whether a parameter's value is a uri that may carry a credential, read in
 *  this order: as an absolute uri; else, where its form is a relative
 *  reference's (it starts with `/` or `\`, or holds `?` or `#`), resolved
 *  against RELATIVE_BASE, never against the uri it sits in, which may have
 *  no path to resolve against, as a `mailto:` hasn't; else, where decoding
 *  it once more changes it, decoded and read again from the start. Each read
 *  or decode is a level, and a decode is lenient, as the parameter's own
 *  was, so a stray `%` doesn't stop it. A value that is none of these, such
 *  as a word, answers false; within the bound a decode alone never
 *  withholds, and past it a value that would still decode does. */
function nestedMayCarry(value: string, depth: number): boolean {
  let inner: URL | null = null;
  try {
    inner = new URL(value);
  } catch {
    // Its form as the URL parser reads it, which first trims C0 controls and
    // spaces, so `\t//user:pass@…` is the protocol-relative uri it resolves
    // as. The tabs and newlines it also drops can't change this form once the
    // lead is trimmed: none is a `/`, `\\`, `?` or `#`.
    if (/^[\u0000-\u0020]*[/\\]|[?#]/.test(value)) {
      try {
        inner = new URL(value, RELATIVE_BASE);
      } catch {
        // Against a hierarchical base only a value that is protocol-relative
        // as the parser reads it (`//`, or `\\` as a special scheme reads it)
        // fails to resolve, on its authority, and it may carry one, as a uri
        // that doesn't parse may: its authority can't be read. So an
        // ordinary value such as `q=// note` is withheld too.
        return true;
      }
    }
  }
  if (inner !== null) return depth >= CREDENTIAL_NESTING || urlMayCarryCredential(inner, depth + 1);
  // Decoded as the parameter itself was, leniently: a stray `%` stays as it
  // is rather than stopping the reading, as it doesn't stop a server's.
  // `+` and `&` are escaped first, so they come back as themselves.
  const decoded = new URLSearchParams(`v=${value.replace(/[+&]/g, encodeURIComponent)}`).get('v') ?? value;
  if (decoded === value) return false;
  // Past the bound, a value that would still decode is withheld: the check's
  // work stops where its reading does, and a uri found deeper would be.
  return depth >= CREDENTIAL_NESTING || nestedMayCarry(decoded, depth + 1);
}

/** How the host reaches a server, as far as fetching its references goes:
 *  the WebSocket url it dials an MCPL server at, or none: for a server it
 *  spawns, such as a stdio one, or a modern MCP server over HTTP, whose
 *  results carry no references (RFC-005 governs MCPL peers' alone), or one
 *  whose url the transport won't dial. A framework records each of its
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
 * goes with the address it checks. In a process with one running framework,
 * or with running frameworks that agree on each id they share, the two
 * sources hold the same addresses, so a stub promises the server the fetch
 * dials. A stub reads an expiry with its result's claims, and the fetch with
 * the record's latest testimony, so where one result names a uri both
 * expired and fresh, its stub says expired while a fetch can succeed. A
 * stopped framework's addresses are out of the registry, so its stubs read
 * another running framework's entry for the same id where there is one, and
 * otherwise say the server is unknown, while its configs still resolve it.
 * Where two
 * frameworks configure one id differently, only a stub's words can be wrong,
 * never where a token goes. A fetch's own limits, its budget and ceiling,
 * come after it.
 */
export function dialCheck(
  record: ReferenceRecord,
  addressOf: (serverId: string) => ServerAddress | undefined,
  nowMs = Date.now(),
  /** For a stub or a script's object, the claims of the result it's shown
   *  in, which decide where its references name the record's uri, the
   *  record's own testimony deciding otherwise (claimedExpiry). A fetch
   *  reads the record alone. */
  claims?: ResultClaims,
): { serverId: string } | { refusal: Refusal } {
  const server = dialServer(record, addressOf);
  if ('refusal' in server) return server;
  const expiry = claimedExpiry(record, claims, nowMs);
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

function suppliedLabel(s: string, maxChars: number): string {
  const shown = suppliedValue(s).replace(/[\p{Cc}\p{Bidi_Control}]/gu, '').trim();
  return shown.length <= maxChars ? shown : `${cutToFit(shown, maxChars - 1)}…`;
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
  /** Set when the eager default's fetch of it failed, so the eager default
   *  doesn't choose it again; fetch_reference still fetches it. A refreshed
   *  testimony leaves it set, since a server can re-issue a uri at every
   *  result, and it lasts as long as the record. A record fetched later, by a
   *  save that landed after the eager pass stopped waiting or by
   *  fetch_reference, can carry it too: fetchedPath is read first. */
  eagerFailed?: boolean;
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
   *  (tool-result-history.ts's, which both copies of a tool result take)
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
  /** Each open journal's copies (openJournal), by uri. */
  private journals = new Set<Map<string, ReferenceRecord | null>>();

  /**
   * Keep, until `close`, each record as it stood when this opened: a copy
   * taken the first time a registration names its uri, whatever it changes,
   * or evicts its record, or null where the uri had none then. `before(uri)`
   * gives that copy, or, where no registration has named the uri since, the
   * record as it is, which is the same. A fetch that saves a copy while it's
   * open sets its record's saved path without registering: a record no
   * registration has named since is read with it, and one a registration
   * named first is read as it stood then, saved or not. For a record a fetch
   * saved meanwhile, both readings are of one the host can fetch, since a
   * fetch saves only what passed the checks a link's line reads too, except
   * where two frameworks configure one server id differently, which a stub's
   * words can't tell apart either (setServerAddress). Each
   * open has its own copies, so lanes that overlap keep theirs apart, and
   * closing one lets its copies go.
   */
  openJournal(): RegistryJournal {
    const copies = new Map<string, ReferenceRecord | null>();
    this.journals.add(copies);
    return {
      before: (uri) => (copies.has(uri) ? copies.get(uri) ?? undefined : this.findByUri(uri)),
      close: () => { this.journals.delete(copies); },
    };
  }

  /** Copy a uri's record into each open journal that has none for it yet,
   *  a copy of its own for each. */
  private keepFirst(uri: string): void {
    if (this.journals.size === 0) return;
    const record = this.findByUri(uri);
    for (const copies of this.journals) {
      if (!copies.has(uri)) copies.set(uri, record ? { ...record, serverIds: [...record.serverIds] } : null);
    }
  }

  /** How many journals are open: none once every lane has closed its own. */
  get journalCount(): number {
    return this.journals.size;
  }

  register(testimony: ReferenceTestimony, serverId?: string): ReferenceRecord {
    this.keepFirst(testimony.uri);
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
    const refId = `${NOTICE_TAG.referenceId}_${(++this.counter).toString(36)}_${Math.random().toString(36).slice(2, 2 + REF_ID_SUFFIX_CHARS)}`;
    const record: ReferenceRecord = { refId, serverIds: serverId === undefined ? [] : [serverId], testimony, receivedAt: Date.now() };
    this.records.set(refId, record);
    this.byKey.set(testimony.uri, refId);
    if (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) {
        const old = this.records.get(oldest);
        if (old) this.keepFirst(old.testimony.uri);
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
   *  fetcher can still dial them. */
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

/** A registry's records as they stood when it opened (openJournal). */
export interface RegistryJournal {
  before(uri: string): ReferenceRecord | undefined;
  close(): void;
}

/**
 * The model's line for a result as a script's link object reads it: the
 * claims that line reads, and each record as it stood when the script lane
 * began to treat the result (a journal's `before`), whatever the treatment
 * has registered, rebound or evicted since, which the line never sees.
 */
export interface ScriptLine {
  claims: ResultClaims;
  recordBefore(uri: string): ReferenceRecord | undefined;
}

// ============================================================================
// Stub building (§5)
// ============================================================================

/** A reference's type as its stub shows one, or '' when nothing is left of
 *  it once sanitized (the stub then leaves it out). */
export function referenceTypeLabel(mimeType: string | undefined): string {
  return mimeType ? suppliedLabel(mimeType, STUB_FIELD_CHARS) : '';
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
  `[${NOTICE_TAG.referenceId}_${MAX_SAFE.toString(36)}_] `.length + REF_ID_SUFFIX_CHARS
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
  /** The claims of the result this block is shown in (resultClaims), which
   *  decide what the stub says where its references name the record's uri,
   *  the record's own testimony deciding otherwise. */
  claims?: ResultClaims;
}

/**
 * What one tool result's references claim of each uri they name, each uri's
 * testimonies read as one (UriClaims): the strictest claim wins, so a uri any
 * of them marks `disposition: never` is withheld, and one any of them gives
 * an expiry that counts is expired (claimedExpiry), whatever the order of the
 * blocks and whatever the registry evicted while it was read (Ada-1017's
 * call). A decision about a record reads its result's claims where the
 * result's references name its uri, a plain one included, and otherwise the
 * record's own testimony, from an earlier result. A reference naming the uri
 * is that result's word on it, the latest, as the registry keeps it
 * (register() replaces a record's testimony with it until the record is
 * fetched), so an earlier result's `never` or expiry gives way to it
 * (Ada-1017's call). A link claims no disposition or expiry, so it adds
 * nothing here, and a result that names a uri only in links leaves its
 * record's testimony in force.
 */
export type ResultClaims = ReadonlyMap<string, UriClaims>;

/**
 * A uri as a link shows it: cleaned as sanitizeLabel cleans a label (controls
 * and bidi marks dropped, surrounding space trimmed; a uri past
 * REFERENCE_LIMITS.uri is no reference, so none is shortened), and well
 * formed, as every copy is before it's shown, a lone surrogate showing as
 * U+FFFD. A `never` is about what a link shows, so it's found by this text
 * (neverShown): a claim of `never` on a uri withholds every link that shows
 * the same text, two uris that clean alike sharing it. Every other claim is about the record,
 * which the fetch reads by its raw uri, so it's kept by the raw uri (Ada-1017,
 * room-203 #202239).
 */
export function shownUri(uri: string): string {
  return sanitizeLabel(uri, REFERENCE_LIMITS.uri).toWellFormed();
}

const NEVER_SHOWN = new WeakMap<ResultClaims, ReadonlySet<string>>();

/** The texts a link shows (shownUri) for the uris a result's claims mark
 *  `never`, read once per claims. A ResultClaims isn't changed once made. */
function neverShown(claims: ResultClaims): ReadonlySet<string> {
  let shown = NEVER_SHOWN.get(claims);
  if (!shown) {
    shown = new Set([...claims].filter(([, c]) => c.never).map(([uri]) => shownUri(uri)));
    NEVER_SHOWN.set(claims, shown);
  }
  return shown;
}

/** What a result's references say of one uri, read as one. */
export interface UriClaims {
  /** Whether any of them marks it `disposition: never`. */
  never: boolean;
  /** Whether any of them gives an expiry rejected as a field. */
  rejected: boolean;
  /** Whether any of them gives an expiry that doesn't parse. */
  unparseable: boolean;
  /** The earliest expiry any of them gives, in ms since the epoch, or null. */
  earliestMs: number | null;
}

/** A result's claims (ResultClaims), from the testimonies of its references,
 *  each read once, as referenceExpiry reads an expiry. */
export function resultClaims(testimonies: Iterable<ReferenceTestimony>, nevers: Iterable<string> = []): ResultClaims {
  const claims = new Map<string, UriClaims>();
  // A uri inline content marks `disposition: never` (inlineNeverUri), inline
  // data beside its data, the classifier's contradiction, or an embedded
  // resource: withheld unconditionally (RFC-005 §5), though the block is no
  // reference. Only its never counts, since its other claims could loosen
  // (Ada-1017, room-203 #201013, #206688).
  const entry = (uri: string): UriClaims => {
    let c = claims.get(uri);
    if (!c) claims.set(uri, c = { never: false, rejected: false, unparseable: false, earliestMs: null });
    return c;
  };
  for (const uri of nevers) entry(uri).never = true;
  for (const t of testimonies) {
    if (t.fromLink) continue;
    const c = entry(t.uri);
    if (t.disposition === 'never') c.never = true;
    if (t.rejectedFields.includes('expiresAt')) {
      c.rejected = true;
    } else if (t.expiresAt !== undefined) {
      const ms = Date.parse(t.expiresAt);
      if (Number.isNaN(ms)) c.unparseable = true;
      else if (c.earliestMs === null || ms < c.earliestMs) c.earliestMs = ms;
    }
  }
  return claims;
}

/** The claims of a content array's references, read from its elements as
 *  the array shows them: an element's own fields, such as an image's
 *  `_meta`, aren't shown, so a reference inside them doesn't count. */
export function contentClaims(blocks: readonly unknown[]): ResultClaims {
  const testimonies: ReferenceTestimony[] = [];
  const nevers: string[] = [];
  for (const block of blocks) {
    const c = classifyBlock(block);
    if (c.kind === 'reference') testimonies.push(c.testimony);
    const never = inlineNeverUri(block, c);
    if (never !== null) nevers.push(never);
  }
  return resultClaims(testimonies, nevers);
}

/** The uri inline content marks `disposition: never`, which counts for that
 *  uri's claims (resultClaims) though the block is no reference: inline data
 *  beside its uri, the classifier's contradiction, and MCP's embedded
 *  resource, whose uri sits under `resource` (Ada-1017, room-203 #206688).
 *  Null for any other block. A uri that isn't a non-empty string names
 *  nothing a claim is kept for. */
export function inlineNeverUri(block: unknown, c: BlockClassification = classifyBlock(block)): string | null {
  // Either kind is a record, so its fields can be read.
  if (!(c.kind === 'inline' && c.contradiction) && c.kind !== 'embedded') return null;
  const b = block as { uri?: unknown; disposition?: unknown; resource: { uri?: unknown } };
  const uri = c.kind === 'embedded' ? b.resource.uri : b.uri;
  return b.disposition === 'never' && typeof uri === 'string' && uri !== '' ? uri : null;
}

/** The claims a decision about a record reads: its result's for its uri,
 *  where the result's references name it, and otherwise the record's own
 *  testimony. */
function uriClaims(record: ReferenceRecord, claims?: ResultClaims): UriClaims | undefined {
  return claims?.get(record.testimony.uri) ?? resultClaims([record.testimony]).get(record.testimony.uri);
}

/** Whether a record's uri is withheld: marked `disposition: never` by its
 *  result's references, for any uri a link shows as the same text
 *  (shownUri), or by its own testimony where none of them names it. */
export function claimedNever(record: ReferenceRecord, claims?: ResultClaims): boolean {
  if (claims && neverShown(claims).has(shownUri(record.testimony.uri))) return true;
  return uriClaims(record, claims)?.never === true;
}

/** The expiry a record counts, as of `nowMs`: the first of EXPIRY_REASON's
 *  cases its claims give (uriClaims), so the order of the blocks doesn't
 *  choose the words. Null when none does. */
export function claimedExpiry(record: ReferenceRecord, claims: ResultClaims | undefined, nowMs: number): keyof typeof EXPIRY_REASON | null {
  const c = uriClaims(record, claims);
  if (!c) return null;
  const given: Record<keyof typeof EXPIRY_REASON, boolean> = {
    passed: c.earliestMs !== null && c.earliestMs <= nowMs,
    unparseable: c.unparseable,
    rejected: c.rejected,
  };
  return (Object.keys(EXPIRY_REASON) as Array<keyof typeof EXPIRY_REASON>).find((reason) => given[reason]) ?? null;
}

/**
 * The uri a tool result's link shows, or null where it shows none: a link
 * (fromLink) the host can't fetch, whose uri can't carry a credential, and
 * that no reference withholds with `disposition: never`, keeps its uri, the
 * agent's only handle on it. A `data:` uri holds its content rather than
 * naming where it lies, so it's never shown: a link's line isn't a way for
 * inline data to reach context. A tool result's link line (buildReferenceStub,
 * unfetchedLinkUri) and a script's object for the link
 * (referenceBlockForScript) both ask this, so the model and a script, whose
 * output comes back to the model, see a link's uri alike.
 *
 * The credential check reads the uri as it would be shown, with what
 * sanitizeLabel strips gone, so a uri split by a control character is read
 * as it would read: `ht\u0000tps://user:pass@…` parses as a path, and shows
 * as userinfo. A `disposition: "never"` for the uri keeps it out whatever
 * the link says: any reference's in the same result (claims), for this uri
 * or one shown as the same text, or, where no reference in the result names
 * the uri, the record's.
 */
export function shownLinkUri(t: ReferenceTestimony, record: ReferenceRecord, nowMs = Date.now(), claims?: ResultClaims): string | null {
  if (!t.fromLink || claimedNever(record, claims)) return null;
  if (unfetchableReason(record, nowMs, claims) === null) return null;
  const uri = shownUri(t.uri);
  return uriMayCarryCredential(uri) || /^data:/i.test(uri) ? null : uri;
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
  // One clock reading for the whole stub, so whether it shows a link's uri
  // and the reason it gives can't disagree across an expiry.
  const nowMs = Date.now();
  const parts: string[] = [];
  // A label is shown only when something is left of it once sanitized.
  const name = t.name ? suppliedLabel(t.name, STUB_FIELD_CHARS) : '';
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
    if (options?.unfetchedLinkUri) {
      const uri = shownLinkUri(t, record, nowMs, options.claims);
      if (uri !== null) return unfetchedLinkText(t, uri);
    }
    parts.push(unfetchableReason(record, nowMs, options?.claims) ?? 'fetch with fetch_reference');
  }
  return `[${record.refId}] ${parts.join(' — ') || 'referenced content'}`;
}

/**
 * What a tool result's link the host can't fetch shows, where its uri can't
 * carry a credential: its name, its uri and its type, as a standard MCP
 * server's link shows (StubOptions.unfetchedLinkUri).
 */
function unfetchedLinkText(t: ReferenceTestimony, uri: string): string {
  const name = t.name ? suppliedLabel(t.name, STUB_FIELD_CHARS) : '';
  const mimeType = referenceTypeLabel(t.mimeType);
  return `[${NOTICE_TAG.resourceLink}${name ? ` "${name}"` : ''}: ${uri}${mimeType ? `, ${mimeType}` : ''}; not fetched]`;
}

/**
 * Why the fetcher would refuse a reference before it dials, whatever the
 * fetch, in its stub's words: the registry's dialCheck, from its record and
 * its servers' addresses. Null for a saved copy, which the fetcher serves
 * before any check, and where a fetch would dial. A fetch's own limits, the
 * server's spent budget or a claimed size over the ceiling it's given, the
 * fetcher gives in its own words, and save_recent_image says them too.
 */
export function unfetchableReason(record: ReferenceRecord, nowMs = Date.now(), claims?: ResultClaims): string | null {
  if (record.fetchedPath) return null;
  const dial = dialCheck(record, (serverId) => referenceRegistry.serverAddress(serverId), nowMs, claims);
  return 'refusal' in dial ? dial.refusal.inStub ?? dial.refusal.error : null;
}

/**
 * RFC-005 treatment for one MCPL wire block, for the model-visible text
 * lanes. Returns a replacement string, or null when the block should keep
 * its existing (inline/text) handling. A reference's stub carries text taken
 * from the block's own fields, so it's made well formed (a lone UTF-16
 * surrogate becomes U+FFFD), as the context store would make it: a tool
 * result's copies then carry the same text (#695). For MCP's embedded
 * resource, it's the text for contents that can't be shown (its marker is
 * well formed where it's made), and null where they can: the caller shows the
 * block they make (classifyBlock's `embedded`).
 */
export function referenceStubOrNull(block: unknown, provenance?: string, serverId?: string, options?: StubOptions): string | null {
  const c = classifyBlock(block);
  switch (c.kind) {
    case 'text': return null;
    case 'inline':
      return c.contradiction ? INLINE_WITHHELD_TEXT : null;
    case 'reference': return buildReferenceStub(c.testimony, provenance, serverId, options).toWellFormed();
    case 'embedded':
      return c.contents.kind === 'withheld' ? INLINE_WITHHELD_TEXT : c.contents.kind === 'marker' ? c.contents.text : null;
    case 'invalid': return c.shown;
  }
}

/**
 * RFC-005 treatment for one MCPL wire block, for a script's structured
 * result, which carries blocks rather than text. It makes the decision
 * referenceStubOrNull makes for the model's lanes, since what a script prints
 * comes back to the model, except that a script reads every field, so inline
 * data beside a uri of any type but null, absent or empty is withheld, where
 * the model's lanes, which show no uri, withhold it beside a string one that
 * isn't empty. A reference becomes the stub's facts as data: the host's
 * reference id, what the server said about it in this block (its labels
 * stripped and bounded as in the stub), and `savedTo`, the workspace path
 * its payload was fetched to, or null when it wasn't (`fetch_reference`
 * takes the id as `ref_id`). Its uri is left out, except that a link (MCP's
 * resource_link) carries `uri` where the model's line for it shows the uri
 * (shownLinkUri). An unsaved reference that counts as expired also carries
 * `expired`, and one the fetcher would refuse carries `unfetchable`, the
 * words a stub gives in place of advising fetch_reference
 * (unfetchableReason). Both give why a fetch_reference with the object's
 * `refId` would be refused, as the result's references claim it, so a link
 * whose line shows its uri, which the host can't fetch, carries them too: its
 * line has no id to fetch with. The fetch itself reads the record, which
 * keeps the latest testimony registered until it's fetched, and then the one
 * its saved copy was verified against (Ada-1017's call). `claims` are those
 * of everything the script's view shows (scriptViewClaims), so its other
 * references count (ResultClaims). The reference is registered bound to
 * `serverId`, the server whose tool returned it, as the model's lanes bind a
 * tool result's references, so the fetch its id offers can be made. With no
 * `serverId`, as for a module's result, it's registered as the model's
 * history registers a module's: the record its uri already has, bound where
 * it arrived (a module's ctx.callTool registers an MCPL peer's references),
 * or a new one bound to no server. A block the classifier
 * rejects becomes the notice the model's lanes show, and inline data that
 * also claims a bulk disposition, or a uri of any type but null, absent or
 * empty, the withheld notice, each as a text block. MCP's embedded resource
 * becomes the block its contents make, as the model's lanes show it, never
 * its uri.
 * A text block, or inline data that claims nothing, is returned as sent.
 */
export function referenceBlockForScript(block: unknown, serverId?: string, claims?: ResultClaims, line?: ScriptLine): unknown {
  const c = classifyBlock(block);
  switch (c.kind) {
    case 'text': return block;
    case 'inline': {
      // A script reads every field, as history's JSON writes it, so inline
      // data beside a uri of any type is withheld here, not only beside a
      // string one as in the model's lanes, which show no uri: an object can
      // carry a credential. An absent, null or empty uri carries none, as at
      // any depth (hasUri), so a peer's and a module's agree (Ada-1017,
      // room-203 #200094); one beside a disposition is the classifier's
      // contradiction, a reference's claim.
      const uri = (block as { uri?: unknown }).uri;
      return c.contradiction || (uri !== undefined && uri !== null && uri !== '')
        ? { type: 'text', text: INLINE_WITHHELD_TEXT }
        : block;
    }
    case 'invalid': return { type: 'text', text: c.shown };
    case 'embedded':
      // The block its contents make, as the model's lanes show it, and never
      // its uri or its `resource` record (Ada-1017, room-203 #206688): text,
      // or inline data that claims nothing, as such a block reaches a script;
      // the withheld notice where it claims a disposition; its marker
      // otherwise. Given again, each is as it was.
      if (c.contents.kind === 'block') return c.contents.block;
      return { type: 'text', text: c.contents.kind === 'withheld' ? INLINE_WITHHELD_TEXT : c.contents.text };
    case 'reference': {
      const t = c.testimony;
      const record = referenceRegistry.register(t, serverId);
      // One clock reading for the whole object, so its words can't disagree
      // with each other across an expiry.
      const nowMs = Date.now();
      // A link's uri where the model's line for the result shows it, by the
      // claims the line reads and its record as the line reads it (`line`,
      // where they differ from the view's), and never where the view's
      // claims withhold it: reading more claims can loosen as well as
      // tighten, since an expiry makes a link one the host can't fetch, whose
      // uri the line shows (Ada-1017, room-203 #201013). The line's record is
      // the registry's as the model's line leaves it, before the script
      // lane's own registrations (#202683, #203011), since the treatment
      // registers, rebinds and evicts as it goes, which the line never sees;
      // where there was none, it's the one the link's own registration
      // makes. A script never sees a uri the model's line
      // withholds, through its blocks; structured content goes as sent, as
      // on main.
      const lineRecord = line
        ? line.recordBefore(t.uri) ?? { refId: record.refId, serverIds: serverId === undefined ? [] : [serverId], testimony: t, receivedAt: record.receivedAt }
        : record;
      const lineShows = shownLinkUri(t, lineRecord, nowMs, line ? line.claims : claims);
      const uri = lineShows !== null && line !== undefined && claimedNever(record, claims) ? null : lineShows;
      // Why a fetch_reference with this object's refId would be refused, in
      // the words a stub gives, whether or not the model's line for it is a
      // stub: the line has no id to fetch with, and the object does. As the
      // stub judges it, a saved copy is still served, and the result's own
      // claims decide where its references name the uri (uriClaims).
      const expiry = record.fetchedPath ? null : claimedExpiry(record, claims, nowMs);
      const unfetchable = unfetchableReason(record, nowMs, claims);
      return {
        type: (block as { type: string }).type,
        refId: record.refId,
        ...(uri !== null ? { uri } : {}),
        ...(t.name !== undefined ? { name: sanitizeLabel(t.name, STUB_FIELD_CHARS) } : {}),
        ...(t.mimeType !== undefined ? { mimeType: sanitizeLabel(t.mimeType, STUB_FIELD_CHARS) } : {}),
        ...(t.sizeBytes !== undefined ? { sizeBytes: t.sizeBytes } : {}),
        ...(t.digest !== undefined ? { digest: t.digest } : {}),
        ...(t.expiresAt !== undefined ? { expiresAt: sanitizeLabel(t.expiresAt, STUB_FIELD_CHARS) } : {}),
        savedTo: record.fetchedPath ?? null,
        ...(expiry ? { expired: EXPIRY_REASON[expiry] } : {}),
        ...(unfetchable !== null ? { unfetchable } : {}),
      };
    }
  }
}
