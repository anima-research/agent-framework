/**
 * Which MCP protocol family a configured server speaks, and over which
 * transport. Both are decided from the configuration alone, before anything
 * is spawned or dialed: there is no cross-family probing and no fallback.
 *
 * - **Legacy**: MCP 2024-11-05, with MCPL riding on it as an experimental
 *   capability. `McplServerConnection` speaks it, over stdio or MCPL's
 *   WebSocket binding.
 * - **Modern**: MCP 2026-07-28, which is stateless. It has no `initialize`;
 *   every request carries its version and client capabilities in `_meta`, and
 *   server-to-client requests are replaced by in-band continuation.
 *   `ModernMcpConnection` speaks it, over stdio or Streamable HTTP.
 *
 * A URL's scheme decides a network server's family: `ws://`/`wss://` is
 * legacy, `http://`/`https://` is modern, because neither family has the
 * other's binding. A stdio (`command`) server can be either. It is legacy
 * unless its config says `protocol: 'modern'`, so every existing stdio
 * configuration opens exactly as before.
 *
 * Why no auto-detection: the modern spec's discover-first probe makes some
 * real MCPL servers exit (heartbeat-mcpl closes on any first message that
 * isn't `initialize`), the SDK's stdio probe launches the server twice, and a
 * server's era is a stable fact its configuration can state.
 */
import { DENY_BY_DEFAULT, capabilityPatternMatches } from './capability-grant.js';
import { DEFAULT_EAGER_FETCH_MAX_BYTES, DEFAULT_MAX_TOTAL_BYTES } from './reference-fetcher.js';
import { DEFAULT_MAX_INPUT_BYTES } from './tool-lifecycle.js';
import type { McplServerConfig, ScopeConfig } from './types.js';
import { kindOf } from '../config-checks.js';

/** The one revision the legacy engine offers and accepts. */
export const LEGACY_MCP_PROTOCOL_VERSION = '2024-11-05';
/** The revision the modern engine pins. */
export const MODERN_MCP_PROTOCOL_VERSION = '2026-07-28';

export type McpProtocolFamily = 'legacy' | 'modern';
export type McpTransportKind = 'stdio' | 'websocket' | 'http';

export interface ServerBinding {
  family: McpProtocolFamily;
  transport: McpTransportKind;
}

/** The largest delay a Node/Bun timer honors (2³¹−1 ms, about 24.8 days). */
export const MAX_TIMER_MS = 2_147_483_647;


type BindingFields = Pick<McplServerConfig, 'id' | 'command' | 'url' | 'transport' | 'protocol'>;

/**
 * A path segment that may be a credential. Some hosted servers put a
 * per-user secret in the path (`…/mcp/s/<secret>/mcp`). A random token
 * (base64url, hex, a uuid) is long and carries a digit; anything very long
 * is treated as one too. A short or plain-word segment can't be told apart
 * from a name, so it stays.
 */
function credentialLikeSegment(segment: string): boolean {
  return (segment.length >= 16 && /[0-9]/.test(segment)) || segment.length >= 32;
}

/** Query parameter names that say they carry a credential. */
const CREDENTIAL_PARAM = /token|key|secret|password|auth|signature/i;

/**
 * A query parameter name that may itself be a credential, which
 * {@link redactUrl} replaces and a warning never quotes: one shaped like a
 * token, or one with no value whose name says it carries a credential, since
 * a bare token rides as a name alone (`?<token>`).
 */
function credentialLikeQueryName(name: string, value: string): boolean {
  return credentialLikeSegment(name) || (value === '' && CREDENTIAL_PARAM.test(name));
}

/**
 * A url as text a person or a log reads it: its scheme, host and port, and
 * its path with any credential-like segment replaced. The userinfo is
 * removed and each query parameter's value replaced, since a credential
 * rides there too, and so is a parameter name that may itself be one
 * ({@link credentialLikeQueryName}). A url that doesn't parse can't be
 * redacted, so it isn't shown at all.
 */
export function redactUrl(url: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '');
  } catch {
    return '(an invalid url, not shown)';
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.split('/').map((segment) => (credentialLikeSegment(segment) ? 'redacted' : segment)).join('/');
  parsed.search = new URLSearchParams([...parsed.searchParams].map(([name, value]): [string, string] => [credentialLikeQueryName(name, value) ? 'redacted' : name, 'redacted'])).toString();
  return parsed.toString();
}

/**
 * Server and transport text as the framework records it, with the strings a
 * server's configuration knows to be credentials replaced, and those its
 * dials sent:
 * - from the url as each dial sends it ({@link urlAsDialed}), and decoded:
 *   the configured one, and each one dialed with an access provider's token
 *   ({@link noteDialSent}): credential-like path segments and
 *   query names, credential-shaped or credential-named query values, every
 *   other non-empty parameter as its whole name=value, and a WebSocket url's
 *   username and password, its userinfo as one unit before its @ (the
 *   username alone when there's no password), with no length floor, so a
 *   short password goes with its username and a short username alone goes
 *   too, and the Basic credential a WebSocket client sends for that userinfo;
 * - the static token, and each token an access provider handed a dial for
 *   a header, raw, and percent- or form-encoded with either case of hex;
 * - a stdio server's environment values whose names say they're
 *   credentials, raw, and percent-encoded with either case of hex.
 * Each of these strings, from every source, the name=value pairs and
 * userinfo units too, is also replaced as JSON encoders write it:
 * JSON.stringify's escapes (a quote, a backslash, a control character), and
 * with its slashes escaped too, as some encoders write them.
 * A string replaced on its own has at least 8 characters, since a shorter
 * one can't be told from ordinary text, and it is replaced wherever it
 * occurs, after an escape or inside a longer token too. A query parameter is
 * also replaced as its whole name=value, only where no letter or digit
 * adjoins the pair, so v=2 leaves dev=2 alone (a JSON escape before it, such
 * as \n, isn't one); a short value goes only that way. Every place one of
 * these matches is replaced, overlapping places included, and the
 * replacement is never scanned again; text that may come
 * from several servers takes one pass over all their configurations'
 * strings (serverCredentialPatterns), so strings of different servers that
 * overlap are both replaced whole. A credential neither the configuration
 * holds nor a dial of it sent, such as another origin's, is outside it, and
 * so are other encodings of the ones it holds. A JSON-RPC answer's result
 * passes as it is. No error a host's own call gets, whether thrown, rejected
 * with or in an error answer's data, carries one of the strings above,
 * whoever wrote the words: a server's words are redacted, then bounded,
 * where an error is built from them, the strings in an error answer's data
 * are redacted ({@link redactedData}), and an error a library raised is
 * handed on as its name and its redacted words alone ({@link maskedError}),
 * with a stdio launch failure's code. A failed handshake's stderr tail
 * is redacted from a longer window of the stream, so a credential of up to
 * 14,336 characters that reaches into it is replaced whole
 * (McplTransport.stderrTailRedacted). A close's or a
 * cleanup's failure carries the transports' own words, a child's pid, its
 * server's id and the wait it was given, and passes as built. A
 * connection's events are the framework's records' inputs, and the records
 * redact them.
 *
 * A configuration that can't be read, such as one whose `env` is a getter
 * that throws, says nothing of which strings to replace, so the whole text
 * is withheld ({@link WITHHELD_TEXT}) rather than thrown on: a redaction
 * runs where a throw has nowhere to go, such as inside a transport's 'error'
 * listener.
 */
export function redactServerText(text: unknown, config: Pick<McplServerConfig, 'url' | 'token' | 'env' | 'tokenTransport'>): string {
  return serverTextRedactor(config)(text);
}

/** A {@link serverTextRedactor}: a redaction of one configuration's
 *  credentials, which reads the configuration until a build succeeds. */
export interface ServerTextRedactor {
  (text: unknown, from?: number): string;
  /**
   * This redaction for one piece of work, such as building one error from a
   * server's words and data: its pattern built now if it isn't, so the
   * configuration is read at most once for all the work's texts, and every
   * text withheld if it can't be read.
   */
  now(): Redaction;
}

/** The redaction of a configuration that can't be read. */
const withheld: Redaction = () => WITHHELD_TEXT;

/**
 * {@link redactServerText} for one configuration, its strings found and its
 * pattern built once, and again once a dial has sent something new
 * ({@link noteDialSent}): for a connection's records, such as each stderr
 * line. A build that can't read the configuration withholds that call's
 * text, and the next call builds again.
 */
export function serverTextRedactor(config: Pick<McplServerConfig, 'url' | 'token' | 'env' | 'tokenTransport'>): ServerTextRedactor {
  let built = -1;
  let redact!: Redaction;
  const now = (): Redaction => {
    const version = dialsSent.get(config)?.version ?? 0;
    if (version !== built) {
      let patterns: CredentialPattern[];
      try {
        patterns = serverCredentialPatterns(config);
      } catch {
        return withheld;
      }
      redact = credentialRedactor(patterns);
      built = version;
    }
    return redact;
  };
  return Object.assign((text: unknown, from?: number) => now()(text, from), { now });
}

/** What a redaction gives in place of text when the configuration it
 *  redacts with can't be read ({@link redactServerText}). */
export const WITHHELD_TEXT = "[withheld: the server's configuration couldn't be read to redact this]";

/** What {@link redactedData} gives in place of data nested deeper than it
 *  walks. */
export const TOO_DEEP_TEXT = '[withheld: nested too deep to redact]';

/** How deep {@link redactedData} walks. A server's JSON can nest deeper than
 *  a recursive walk's stack holds (10,000 levels overflow it), and the walk
 *  runs where a throw would leave the request it answers unsettled. */
const REDACTED_DATA_DEPTH = 64;

/**
 * The data a server's error answer carries beside its words, with every
 * string in it, an object's keys included, redacted (`redact`, a server's
 * {@link serverTextRedactor}, built once for the walk), so an error handed
 * to a host carries no credential its configuration holds. Arrays and plain
 * objects are walked, to a depth of 64; deeper data is
 * {@link TOO_DEEP_TEXT}. A number goes as its redacted text if its digits,
 * as JavaScript reads the number, hold a credential: a number with more
 * significant digits than a double holds (about 15) has lost its last ones
 * before anything sees it, so a credential sent as such a number isn't
 * matched. A redacted key that comes out the same as another key is
 * numbered, so every entry is kept under a name of its own, and a key the
 * redaction leaves alone keeps its name. Any other value, null or a
 * boolean, is kept as it is. With a configuration that can't be read, the
 * data as a whole is {@link WITHHELD_TEXT}.
 */
export function redactedData(value: unknown, redactor: ServerTextRedactor | Redaction): unknown {
  const redact = 'now' in redactor ? redactor.now() : redactor;
  if (redact === withheld) return value === undefined ? undefined : WITHHELD_TEXT;
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') return redact(item);
    if (typeof item === 'number') {
      const digits = String(item);
      const redacted = redact(digits);
      return redacted === digits ? item : redacted;
    }
    if (item === null || typeof item !== 'object') return item;
    const walked = Array.isArray(item) || [Object.prototype, null].includes(Object.getPrototypeOf(item));
    if (!walked) return item;
    if (depth >= REDACTED_DATA_DEPTH) return TOO_DEEP_TEXT;
    if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1));
    // A key the redaction leaves as it is keeps its name; a redacted one
    // takes the first name no other key has, so no entry is lost or moved.
    const entries = Object.entries(item);
    const names = entries.map(([key]) => redact(key));
    const taken = new Set(names.filter((name, n) => name === entries[n][0]));
    // Each name's next number to try, so keys that redact alike don't search
    // from 2 again: every number below it was taken, and stays taken.
    const next = new Map<string, number>();
    return Object.fromEntries(entries.map(([key, entry], n) => {
      let name = names[n];
      if (name !== key) {
        const base = name;
        let k = next.get(base) ?? 2;
        while (taken.has(name)) name = `${base} (${k++})`;
        next.set(base, k);
        taken.add(name);
      }
      return [name, walk(entry, depth + 1)];
    }));
  };
  return walk(value, 0);
}

/**
 * An error a library raised, as the framework hands it to a host: its name,
 * which is its class's, as it is, and its words redacted (`redact`, a
 * server's {@link serverTextRedactor}), and nothing else. A library's error
 * can carry the url it dialed elsewhere than in its message (Bun's fetch
 * errors keep it in `path`, its path and query included), or keep the raw
 * error it wraps as its `cause`, so none of that is carried over.
 */
export function maskedError(error: unknown, redact: (text: unknown) => string): Error {
  const masked = new Error(redact(error instanceof Error ? error.message : error));
  // Not enumerable, as an error's own name is not.
  if (error instanceof Error) Object.defineProperty(masked, 'name', { value: error.name, writable: true, configurable: true });
  return masked;
}

/**
 * What a configuration's dials sent that the configuration doesn't hold: the
 * urls dialed with an access provider's token, and the provider's tokens,
 * sent in a url or a header. Kept by the configuration object the dial read.
 * For the dials that note anything, a WebSocket dial and an HTTP bearer, that
 * is the object the framework records the server's text with. A provider can
 * hand each dial a new token, so only the newest sixteen of each are kept,
 * newest by when a dial last sent it.
 */
const dialsSent = new WeakMap<object, { readonly urls: string[]; readonly tokens: string[]; version: number }>();
const DIAL_SENT_KEPT = 16;

/** Note what one dial sent: the url it dialed, or a token it sent in a
 *  header. That configuration's patterns cover it from then on. */
export function noteDialSent(config: object, sent: { readonly url?: string; readonly token?: string }): void {
  let entry = dialsSent.get(config);
  if (!entry) {
    entry = { urls: [], tokens: [], version: 0 };
    dialsSent.set(config, entry);
  }
  const kept = entry;
  const keep = (list: string[], value: string | undefined): void => {
    if (!value) return;
    const at = list.indexOf(value);
    if (at >= 0) {
      // Sent again: it moves to the newest place, and the set is unchanged.
      list.splice(at, 1);
      list.push(value);
      return;
    }
    list.push(value);
    if (list.length > DIAL_SENT_KEPT) list.shift();
    kept.version += 1;
  };
  keep(kept.urls, sent.url);
  keep(kept.tokens, sent.token);
}

/**
 * The url a dial sends. A WebSocket dial that sends its token in the query
 * sets it as the `token` parameter, and setting it makes URLSearchParams
 * write the whole query again, form-encoded (a space as `+`), so the url as
 * sent can differ from the url as configured. A header-mode WebSocket dial,
 * which is given no token here, and an http(s) dial send the url as
 * configured.
 */
export function urlAsDialed(url: URL, token: string | null | undefined): URL {
  const dialed = new URL(url);
  if (token && (dialed.protocol === 'ws:' || dialed.protocol === 'wss:')) dialed.searchParams.set('token', token);
  return dialed;
}

/** A string {@link redactServerText} replaces, and the pattern that finds it. */
export interface CredentialPattern {
  readonly value: string;
  readonly source: string;
}

/**
 * The strings {@link redactServerText} replaces for one configuration, as
 * patterns for {@link credentialRedactor}. Text that may come from several
 * servers goes through one redactor over all their patterns, so a secret
 * that begins inside another configuration's, or shares its start, can't
 * leave any of that one in place.
 */
export function serverCredentialPatterns(config: Pick<McplServerConfig, 'url' | 'token' | 'env' | 'tokenTransport'>): CredentialPattern[] {
  // Strings replaced wherever they occur (after an escape or inside a longer
  // token too), and name=value pairs, replaced only where no letter or digit
  // adjoins them, so a pair such as v=2 leaves dev=2 alone. A pair's value is
  // also replaced on its own when it's a credential, wherever it occurs.
  const standalones = new Set<string>();
  const pairs = new Set<string>();
  const userinfo = new Set<string>();
  const standalone = (value: string): void => { standalones.add(value); };
  const decode = (value: string, query = false): string => {
    try { return decodeURIComponent(query ? value.replace(/\+/g, ' ') : value); }
    catch { return value; }
  };
  // Percent-escapes in lowercase hex, as some encoders write them.
  const lowerEscapes = (value: string): string => value.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
  // A string as written, and percent-encoded in either case of hex (a string
  // encodeURIComponent refuses, such as one with an unpaired surrogate, has
  // no encoded form). Its JSON forms come with every other string's, below.
  const withEncoded = (value: string): void => {
    standalone(value);
    let encoded: string;
    try { encoded = encodeURIComponent(value); } catch { return; /* no percent-encoded form */ }
    standalone(encoded);
    standalone(lowerEscapes(encoded));
  };
  // A token as sent: raw in a header, and percent- or form-encoded where a
  // transport puts it in a url.
  const addToken = (token: string): void => {
    withEncoded(token);
    const formEncoded = new URLSearchParams({ t: token }).toString().slice(2);
    standalone(formEncoded);
    standalone(lowerEscapes(formEncoded));
  };
  addToken(config.token ?? '');
  // A stdio server's environment values whose names say they carry a
  // credential: a part of the name that ends with a credential word
  // (GITHUB_TOKEN, API_KEY, PGPASSWORD, ACCESSTOKEN), and not one where the
  // word only begins or sits inside a part (GIT_AUTHOR_NAME, KEYBOARD_LAYOUT,
  // TOKENIZERS_PARALLELISM).
  for (const [name, value] of Object.entries(config.env ?? {})) {
    // A JavaScript host can pass a value that isn't a string; only strings are derived.
    if (typeof value === 'string' && name.split(/[_\-.]/).some((part) => CREDENTIAL_NAME_PART.test(part))) withEncoded(value);
  }
  // A url as a dial sends it. Nothing quotes the configured url before a
  // dial, so its form as configured needs no strings of its own.
  const addUrl = (url: URL): void => {
    for (const segment of url.pathname.split('/')) {
      if (credentialLikeSegment(segment)) {
        standalone(segment);
        standalone(decode(segment));
      }
    }
    for (const parameter of url.search.slice(1).split('&')) {
      const equals = parameter.indexOf('=');
      const encodedName = equals < 0 ? parameter : parameter.slice(0, equals);
      const encodedValue = equals < 0 ? '' : parameter.slice(equals + 1);
      const name = decode(encodedName, true);
      const value = decode(encodedValue, true);
      if (credentialLikeQueryName(name, value)) {
        standalone(encodedName);
        standalone(name);
      }
      if (CREDENTIAL_PARAM.test(name) || credentialLikeSegment(value)) {
        standalone(encodedValue);
        standalone(value);
      }
      if (value !== '') {
        pairs.add(`${encodedName}=${encodedValue}`);
        pairs.add(`${name}=${value}`);
      }
    }
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      for (const value of [url.username, url.password]) {
        standalone(value);
        standalone(decode(value));
      }
      // The userinfo itself as one unit wherever it stands before an @ with
      // no letter or digit just before it: username:password, or the
      // username alone when there's no password, as a token written as the
      // username is. So a password too short to replace on its own still
      // goes with its username, and a short username alone goes too. The @
      // and that boundary anchor the unit as a pair's boundaries do, so it
      // has no length floor. And the Basic credential a WebSocket client
      // sends for it. Each from the userinfo as written and as decoded.
      for (const [username, password] of [[url.username, url.password], [decode(url.username), decode(url.password)]]) {
        if (!username && !password) continue;
        userinfo.add(password ? `${username}:${password}` : username);
        standalone(Buffer.from(`${username}:${password}`).toString('base64'));
      }
    }
  };
  // Read before the parse's try: a configuration that can't be read throws,
  // so its redaction withholds the text rather than redact it without the
  // url's strings.
  const configuredUrl = config.url ?? '';
  let url: URL | undefined;
  try { url = new URL(configuredUrl); } catch { /* Still remove the static token. */ }
  if (url) addUrl(urlAsDialed(url, config.tokenTransport === 'header' ? null : config.token));
  // What the dials sent beyond that: urls dialed with an access provider's
  // token, and its tokens sent in a header.
  const sent = dialsSent.get(config);
  for (const dialed of sent?.urls ?? []) {
    try { addUrl(new URL(dialed)); } catch { /* a dialed url always parses */ }
  }
  for (const token of sent?.tokens ?? []) addToken(token);
  // Every string above, from every source, as written and as JSON encoders
  // write it: with JSON.stringify's escapes (a quote, a backslash, a control
  // character), and with its slashes escaped too, as some encoders write
  // them. So a url's credential goes in JSON's forms as a token's does: in a
  // log line that prints a server's JSON value as its JSON text, or in a
  // server's JSON that echoes a decoded url secret. A string replaced on its
  // own has at least 8 characters in each form it's replaced in.
  const withJsonForms = (values: Iterable<string>, floor: number): Set<string> => {
    const forms = new Set<string>();
    for (const value of values) {
      const json = JSON.stringify(value).slice(1, -1);
      for (const written of [value, json]) {
        for (const form of [written, written.replace(/\//g, '\\/')]) if (form.length >= floor) forms.add(form);
      }
    }
    return forms;
  };
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Where a pair or userinfo unit may start: where no letter or digit
  // adjoins it, at the text's start or after any other character, or after a
  // JSON escape that ends in one (\b \f \n \r \t, \uXXXX), as a value's JSON
  // text writes a control character before it.
  const start = String.raw`(?<=^|[^A-Za-z0-9]|\\[bfnrt]|\\u[0-9A-Fa-f]{4})`;
  return [
    ...[...withJsonForms(standalones, 8)].map(value => ({ value, source: escape(value) })),
    ...[...withJsonForms(pairs, 0)].map(value => ({ value, source: `${start}${escape(value)}(?![A-Za-z0-9])` })),
    ...[...withJsonForms(userinfo, 0)].map(value => ({ value, source: `${start}${escape(value)}(?=@)` })),
  ];
}

/**
 * A redaction: `text` with the credentials it holds replaced, and only what
 * lies from its `from`th code unit on (0 when left out). A credential that
 * begins before `from` and reaches past it is matched whole and replaced
 * whole, so a part of the text can be given redacted as the whole text has
 * it.
 */
export type Redaction = (text: unknown, from?: number) => string;

/**
 * Every place one of the given patterns matches becomes `redacted`,
 * overlapping places included: the matches are found in the text as given,
 * a match may begin inside another, and each run of overlapping matches is
 * replaced as one. So two strings that overlap, one's end being the other's
 * start, are both replaced whole, and the replacement is never scanned.
 */
export function credentialRedactor(patterns: readonly CredentialPattern[]): Redaction {
  if (patterns.length === 0) return (text, from = 0) => asText(text).slice(from);
  // Longest first, so at each place the longest string that matches there is
  // the match.
  const sources = [...patterns].sort((a, b) => b.value.length - a.value.length).map(({ source }) => source);
  const pattern = new RegExp([...new Set(sources)].join('|'), 'g');
  return (text, from = 0) => {
    const input = asText(text);
    const spans: Array<[start: number, end: number]> = [];
    pattern.lastIndex = 0;
    for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
      const start = match.index;
      const end = start + match[0].length;
      const last = spans[spans.length - 1];
      if (last && start < last[1]) last[1] = Math.max(last[1], end);
      else spans.push([start, end]);
      // The next search starts one place on, not after this match, so a
      // match that begins inside this one is found too.
      pattern.lastIndex = start + 1;
    }
    let redacted = '';
    let at = from;
    for (const [start, end] of spans) {
      if (end <= from) continue;
      redacted += `${input.slice(at, start)}redacted`;
      at = end;
    }
    return redacted + input.slice(at);
  };
}

/** Any value as text: a value that can't be printed reads as a placeholder. */
export function asText(text: unknown): string {
  if (typeof text === 'string') return text;
  try { return String(text); } catch { return '[a value that cannot be printed]'; }
}

/** A part of an environment variable's name that ends with a credential word, in the singular or plural, with any digits after it. */
const CREDENTIAL_NAME_PART = /(?:tokens?|keys?|secrets?|passwords?|passwd|pass|passphrases?|passcodes?|pat|auth|authorization|authentication|bearer|cookies?|creds|signatures?|credentials?)\d*$/i;

/**
 * A credential provider's failure as a log line may show it: the error's
 * class and its message's length, never the text, which may quote the
 * credential it failed to refresh.
 */
export function describeCredentialError(error: unknown): string {
  if (!(error instanceof Error)) return `a thrown ${typeof error}`;
  const length = error.message.length;
  return `${error.constructor?.name || error.name || 'Error'}, ${length} character${length === 1 ? '' : 's'}`;
}

function urlScheme(config: BindingFields): string {
  let parsed: URL;
  try {
    parsed = new URL(config.url!);
  } catch {
    // Not echoed: a url that doesn't parse can't be redacted.
    throw new Error(`MCP server "${config.id}": invalid url (it isn't shown, since it may carry a credential)`);
  }
  return parsed.protocol;
}

/**
 * Resolve a server's family and transport. Throws on a configuration that
 * names no usable transport (for example an `ftp://` URL, or
 * `transport: 'http'` with a WebSocket URL), or names two without saying
 * which: `command` and `url` together need a `transport`, since one of them
 * goes unused. (A host may layer a url and its transport over a file's
 * command, so both with a `transport` stay valid.)
 */
export function resolveServerBinding(config: BindingFields): ServerBinding {
  if (config.command && config.url && config.transport === undefined) {
    throw new Error(
      `MCP server "${config.id}": "command" and "url" are both set, and no "transport" says which one to use: ` +
        `a server is either launched (command) or dialed (url)`,
    );
  }
  const networkKind = (): McpTransportKind => {
    const scheme = urlScheme(config);
    if (scheme === 'ws:' || scheme === 'wss:') return 'websocket';
    if (scheme === 'http:' || scheme === 'https:') return 'http';
    throw new Error(
      `MCP server "${config.id}": url must be ws:// or wss:// (legacy MCPL) or http:// or https:// (modern MCP), got "${scheme}"`,
    );
  };

  let transport: McpTransportKind;
  if (config.transport === 'stdio' || (config.transport === undefined && config.command)) {
    if (!config.command) {
      throw new Error(`MCP server "${config.id}": the stdio transport requires "command"`);
    }
    transport = 'stdio';
  } else if (config.url) {
    transport = networkKind();
    if (config.transport !== undefined && config.transport !== transport) {
      throw new Error(
        `MCP server "${config.id}": transport "${config.transport}" does not match url ${redactUrl(config.url)}`,
      );
    }
  } else if (config.transport !== undefined) {
    throw new Error(`MCP server "${config.id}": transport "${config.transport}" requires "url"`);
  } else {
    throw new Error(`MCP server "${config.id}": needs "command" (stdio) or "url" (WebSocket or HTTP)`);
  }

  if (transport === 'stdio') return { family: config.protocol ?? 'legacy', transport };
  return { family: transport === 'http' ? 'modern' : 'legacy', transport };
}

/** A configured value that would take effect, as opposed to an empty default. */
function isEffective(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The parts of a configuration's MCPL policy whose values grant something,
 * by path, such as `allowHostCommands`, `scopes.<set>.whitelist`,
 * `enabledCapabilities: toolLifecycle.observe`, `toolLifecycle.maxInputBytes`
 * or `autofetch.maxBytes`: each
 * asks for behaviour only an MCPL server can have. A modern server has none,
 * so such a value can't apply there, and is refused rather than ignored, so
 * that an operator who chose it learns so.
 *
 * A value that only takes something away, or repeats a default, is already
 * satisfied on a modern server and isn't listed: `enabledFeatureSets`, an
 * allow-list over every declared set (`feature-set-manager.ts`);
 * `enabledCapabilities` patterns that match no path denied by default, since
 * elsewhere it is an allow-list too; `disabledFeatureSets`,
 * `disabledCapabilities`, a scope's `blacklist`, `channelSubscription:
 * 'manual'` (the default), `toolLifecycle` with only a `maxInputBytes` at
 * or below its default or with an `observe` or `inputs` that isn't a policy
 * object (which grants nothing), an `autofetch` bound at or below its
 * default, and
 * `shouldTriggerInference`, which only narrows which channel messages
 * trigger inference. So a host that stamps a deny-list on every server it
 * deploys can deploy a modern one. Empty values grant nothing either.
 */
export function mcplPolicyGrants(config: McplServerConfig): string[] {
  const grants: string[] = [];
  if (isEffective(config.allowHostCommands)) grants.push('allowHostCommands');
  // RFC-014 tool hints are an MCPL advertisement.
  if (config.toolHints === true) grants.push('toolHints');
  // An allow-list, except that a pattern matching a path denied by default
  // grants it (computeGrant's explicitlyEnabled), named by the path.
  const enabled = config.enabledCapabilities as unknown;
  if (Array.isArray(enabled)) {
    for (const path of DENY_BY_DEFAULT) {
      if (enabled.some((pattern) => typeof pattern !== 'string' || capabilityPatternMatches(pattern, path))) {
        grants.push(`enabledCapabilities: ${path}`);
      }
    }
  } else if (isEffective(enabled)) {
    grants.push('enabledCapabilities');
  }
  if (config.channelSubscription !== 'manual' && isEffective(config.channelSubscription)) grants.push('channelSubscription');
  if (isPlainRecord(config.scopes)) {
    for (const [set, scope] of Object.entries(config.scopes)) {
      if (isEffective((scope as ScopeConfig | null | undefined)?.whitelist)) grants.push(`scopes.${set}.whitelist`);
    }
  } else if (isEffective(config.scopes)) {
    grants.push('scopes');
  }
  for (const key of ['observe', 'inputs'] as const) {
    if (isPlainRecord((config.toolLifecycle as Record<string, unknown> | undefined)?.[key])) grants.push(`toolLifecycle.${key}`);
  }
  // A larger input bound than the default asks for more than MCPL gives
  // by default, as an autofetch bound above its default does.
  const maxInputBytes = (config.toolLifecycle as Record<string, unknown> | undefined)?.maxInputBytes;
  if (maxInputBytes !== undefined && maxInputBytes !== null && !(typeof maxInputBytes === 'number' && maxInputBytes <= DEFAULT_MAX_INPUT_BYTES)) {
    grants.push('toolLifecycle.maxInputBytes');
  }
  const bounds = [['maxBytes', DEFAULT_EAGER_FETCH_MAX_BYTES], ['maxTotalBytes', DEFAULT_MAX_TOTAL_BYTES]] as const;
  for (const [key, ceiling] of bounds) {
    const value = (config.autofetch as Record<string, unknown> | undefined)?.[key];
    if (value !== undefined && value !== null && !(typeof value === 'number' && value <= ceiling)) grants.push(`autofetch.${key}`);
  }
  return grants;
}

/**
 * Problems with a server configuration's protocol settings, as messages; empty
 * when it is usable. Legacy configurations are checked only for what this
 * design added, so every configuration that worked before still passes but
 * one: `command` and `url` with no `transport`, which was launched as stdio
 * with its url ignored, and is now refused as naming no transport to use.
 */
export function serverConfigProblems(config: McplServerConfig): string[] {
  let binding: ServerBinding;
  try {
    binding = resolveServerBinding(config);
  } catch (error) {
    return [(error as Error).message];
  }
  const problems: string[] = [];
  if (binding.transport === 'http') {
    // fetch refuses a url with userinfo, and its error quotes the whole url,
    // password included, into the connect failure's log line, trace and
    // ops alert. A setting nothing could send is refused, not ignored.
    const url = new URL(config.url!);
    if (url.username || url.password) {
      problems.push(
        `MCP server "${config.id}": an http(s):// url can't carry userinfo (user:password@), since the HTTP client refuses such a url; give the credential as "token" or "accessProvider"`,
      );
    }
  }
  if (config.tokenTransport !== undefined && config.tokenTransport !== null) {
    if (binding.transport !== 'websocket') {
      problems.push(
        `MCP server "${config.id}": "tokenTransport" applies only to a ws(s):// server; an http(s):// server always sends its credential as a header, and a stdio server sends none`,
      );
    } else {
      const problem = tokenTransportProblem(config, new URL(config.url!));
      if (problem) problems.push(problem);
      // A static token known now that no dial could send as configured.
      else if (config.tokenTransport === 'header' && config.token && !headerCarries(config.token)) {
        problems.push(
          `MCP server "${config.id}": with tokenTransport 'header', "token" must be printable ASCII (U+0020 to U+007E) with no space at either end, which is all a header carries as configured`,
        );
      }
    }
  }
  if (config.protocol !== undefined) {
    if (config.protocol !== 'legacy' && config.protocol !== 'modern') {
      problems.push(`MCP server "${config.id}": protocol must be 'legacy' or 'modern', got ${JSON.stringify(config.protocol)}`);
    } else if (binding.transport !== 'stdio') {
      problems.push(
        `MCP server "${config.id}": "protocol" applies only to stdio (command) servers; the url's scheme decides a network server's family`,
      );
    }
  }
  const timeout = config.requestTimeoutMs;
  if (binding.family === 'modern') {
    if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_TIMER_MS)) {
      problems.push(
        `MCP server "${config.id}": requestTimeoutMs must be an integer from 1 to ${MAX_TIMER_MS} for a modern server (got ${asText(timeout)}); every modern call has a deadline`,
      );
    }
    for (const path of mcplPolicyGrants(config)) {
      problems.push(`MCP server "${config.id}": "${path}" asks for MCPL behaviour, which a modern MCP server cannot negotiate`);
    }
    // A modern stdio server takes no credential: nothing would carry it.
    if (binding.transport === 'stdio') {
      for (const field of ['token', 'accessProvider'] as const) {
        if (config[field]) {
          problems.push(`MCP server "${config.id}": "${field}" applies only to a network (url) server; a modern stdio server would ignore it`);
        }
      }
    }
  } else if (typeof timeout === 'number' && timeout > MAX_TIMER_MS) {
    // Never usable: Node runs a longer timer after about 1 ms, so every
    // request timed out at once. Every value that worked (0 included) passes.
    problems.push(
      `MCP server "${config.id}": requestTimeoutMs must be at most ${MAX_TIMER_MS} (got ${String(timeout)}), or 0 to disable the request timeout; a larger value times every request out at once`,
    );
  }
  return problems;
}

/**
 * What's wrong with a WebSocket server's `tokenTransport`, as a message, or
 * undefined: a value that is neither mode, or `'header'` with a url that
 * carries a `token` query parameter of its own, which would still put a
 * credential in the url, or userinfo, whose Basic credential the Bearer
 * header replaces whenever it carries a credential, since a request has one
 * Authorization header. null counts as not set, as config-checks.ts has it.
 * The refusal names the value's kind, never the value, which could be a
 * credential pasted into the wrong field, and quotes nothing of the url.
 */
export function tokenTransportProblem(config: Pick<McplServerConfig, 'id' | 'tokenTransport'>, url: URL): string | undefined {
  // A configuration read from JSON can hold anything here.
  const mode: unknown = config.tokenTransport;
  if (mode === undefined || mode === null || mode === 'query') return undefined;
  if (mode !== 'header') {
    return `MCP server "${config.id}": tokenTransport must be 'query' or 'header', not ${typeof mode === 'string' ? 'another string' : kindOf(mode)}`;
  }
  if (url.searchParams.has('token')) {
    return `MCP server "${config.id}": with tokenTransport 'header' the url must not carry a "token" query parameter, which would still put a credential in it; give it as "token" or "accessProvider"`;
  }
  if (url.username || url.password) {
    return `MCP server "${config.id}": with tokenTransport 'header' the url must not carry userinfo (user:password@), since the Bearer header replaces the userinfo's Basic credential whenever it carries a credential; leave out "tokenTransport" to send the userinfo as before, or give the credential as "token" or "accessProvider"`;
  }
  return undefined;
}

/**
 * Whether a header-mode credential can go in an `Authorization: Bearer`
 * header as it is: printable ASCII (U+0020 to U+007E), with no space at
 * either end. Node and Bun send exactly those bytes, so the server checks the
 * credential that was configured, and the redactor's patterns match whatever
 * it echoes. Outside that set a header can't carry it as configured: a space
 * at either end is dropped (by Bun before sending, by an HTTP parser on
 * arrival), a control character can't go in a header, and a character past
 * U+007E goes out as different bytes from Node and from Bun, or is refused
 * when the socket is built.
 */
export function headerCarries(credential: string): boolean {
  return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(credential);
}

/** A host a connection to which never leaves this machine, as the WHATWG URL
 *  parser gives it. The unspecified addresses count: a connection to 0.0.0.0
 *  or [::] reaches this host. So do 127.0.0.0/8 written as an IPv4-mapped
 *  IPv6 address ([::ffff:127.0.0.1] parses as [::ffff:7f00:1]) and a name
 *  with its root's trailing dot (localhost.). */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host) || host === '0.0.0.0' || host === '[::]';
}

/**
 * What is usable in a server configuration but worth an operator's attention,
 * as messages; empty when there is nothing. A credential for an `http://` or
 * `ws://` url whose host isn't loopback crosses the network in cleartext:
 * `token` or `accessProvider` (in the `Authorization` header, or the
 * WebSocket `?token=` query), and a secret the url carries itself (a ws://
 * url's userinfo, a query parameter whose name says it's a credential, or
 * whose value is shaped like one under a plain name, a query parameter name
 * that may itself be one, or a path segment that looks like one, as
 * {@link redactUrl} judges it). A name that may itself be a credential is
 * counted, never quoted. That can be deliberate, on a private network or
 * behind a TLS-terminating proxy, so it is a warning and never a refusal.
 */
export function serverConfigWarnings(config: McplServerConfig): string[] {
  let transport: McpTransportKind;
  try {
    transport = resolveServerBinding(config).transport;
  } catch {
    return []; // an unusable configuration is serverConfigProblems' to report
  }
  if (transport === 'stdio') return [];
  const url = new URL(config.url!);
  if ((url.protocol !== 'http:' && url.protocol !== 'ws:') || isLoopbackHost(url.hostname)) return [];
  const carried: string[] = [];
  if (config.token || config.accessProvider) carried.push('its credential');
  // An http:// url's userinfo is refused (serverConfigProblems); a ws://
  // url sends it.
  if (url.protocol === 'ws:' && (url.username || url.password)) carried.push("its url's userinfo");
  if (url.pathname.split('/').some(credentialLikeSegment)) carried.push("a credential-like segment of its url's path");
  const entries = [...url.searchParams];
  const hidden = entries.filter(([name, value]) => credentialLikeQueryName(name, value)).length;
  // A parameter carries a credential by its name, or by its value's shape,
  // as redaction reads it; the name is shown only when it isn't one itself.
  const params = [...new Set(entries.filter(([name, value]) => !credentialLikeQueryName(name, value) && (CREDENTIAL_PARAM.test(name) || credentialLikeSegment(value))).map(([name]) => name))];
  if (params.length > 0) {
    carried.push(`its url's query ${params.length === 1 ? 'parameter' : 'parameters'} ${params.map((name) => JSON.stringify(name)).join(', ')}`);
  }
  if (hidden > 0) {
    carried.push(hidden === 1 ? 'a query parameter whose name looks like a credential' : `${hidden} query parameters whose names look like credentials`);
  }
  if (carried.length === 0) return [];
  const what = carried.length === 1 ? carried[0] : `${carried.slice(0, -1).join(', ')} and ${carried[carried.length - 1]}`;
  const one = carried.length === 1 && params.length <= 1 && hidden <= 1;
  const secure = url.protocol === 'http:' ? 'https' : 'wss';
  return [
    `MCP server "${config.id}": ${what} ${one ? 'goes' : 'go'} to ${url.host} unencrypted (${url.protocol}//), ` +
      `where anything on the network path can read ${one ? 'it' : 'them'}; use ${secure}:// unless that network is trusted`,
  ];
}

/** Throw one error listing every problem. Otherwise log each warning and
 *  return the resolved binding. Both engines admit a configuration here. */
export function checkServerConfig(config: McplServerConfig): ServerBinding {
  const problems = serverConfigProblems(config);
  if (problems.length > 0) throw new Error(problems.join('; '));
  for (const warning of serverConfigWarnings(config)) console.warn(`[mcp] ${warning}`);
  return resolveServerBinding(config);
}

const DROPPED_LINES_LOGGED = 3;
const droppedLinesLogged = new WeakMap<object, number>();

export function logDroppedLine(serverId: string, line: string, reason: 'unparsed' | 'not-object', connection: object): void {
  if (/^[ \t]*$/.test(line)) return;
  const logged = droppedLinesLogged.get(connection) ?? 0;
  if (logged > DROPPED_LINES_LOGGED) return;
  droppedLinesLogged.set(connection, logged + 1);
  if (logged === DROPPED_LINES_LOGGED) {
    console.error(`MCP server "${serverId}" sent another line that isn't a JSON object, so it was dropped; more such lines on this connection are dropped without a log line`);
    return;
  }
  let length = 0;
  for (const _ of line) length++;
  const why = reason === 'not-object' ? 'is JSON but not an object'
    : /^[ \t]*\{/.test(line) ? "starts like a JSON object but doesn't parse"
    : "isn't JSON";
  console.error(`MCP server "${serverId}" sent a line of length ${length} that ${why}, so it was dropped`);
}
