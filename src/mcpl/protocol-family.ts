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
import type { McplServerConfig, ScopeConfig } from './types.js';

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
 * server's configuration knows to be credentials replaced:
 * - from the url, as written and decoded: credential-like path segments and
 *   query names, credential-shaped or credential-named query values, every
 *   other non-empty parameter as its whole name=value, and a ws:// url's
 *   username and password, its userinfo as one unit before its @ (the
 *   username alone when there's no password), with no length floor, so a
 *   short password goes with its username and a short username alone goes
 *   too, and the Basic credential a WebSocket client sends for that userinfo;
 * - the static token, raw, as JSON encoders write it (JSON.stringify's
 *   escapes, and with its slashes escaped too, as some encoders write them),
 *   and percent- or form-encoded with either case of hex;
 * - a stdio server's environment values whose names say they're
 *   credentials, raw, as JSON encoders write them, and percent-encoded with
 *   either case of hex.
 * A string replaced on its own has at least 8 characters, since a shorter
 * one can't be told from ordinary text, and it is replaced wherever it
 * occurs, after an escape or inside a longer token too. A query parameter is
 * also replaced as its whole name=value, only where no letter or digit
 * adjoins the pair, so v=2 leaves dev=2 alone; a short value goes only that
 * way. Every place one of these matches is replaced, overlapping places
 * included, and the replacement is never scanned again; text that may come
 * from several servers takes one pass over all their configurations'
 * strings (serverCredentialPatterns), so strings of different servers that
 * overlap are both replaced whole. A credential the
 * configuration doesn't hold, such as the token an access provider fetches
 * or another origin's, is outside it, and so are other encodings of the
 * ones it holds. JSON-RPC answers, and the error a host's own connect
 * raises, pass as they are.
 */
export function redactServerText(text: unknown, config: Pick<McplServerConfig, 'url' | 'token' | 'env'>): string {
  return serverTextRedactor(config)(text);
}

/**
 * {@link redactServerText} for one configuration, its strings found and its
 * pattern built once: for a connection's records, such as each stderr line.
 */
export function serverTextRedactor(config: Pick<McplServerConfig, 'url' | 'token' | 'env'>): (text: unknown) => string {
  return credentialRedactor(serverCredentialPatterns(config));
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
export function serverCredentialPatterns(config: Pick<McplServerConfig, 'url' | 'token' | 'env'>): CredentialPattern[] {
  // Strings replaced wherever they occur (after an escape or inside a longer
  // token too), and name=value pairs, replaced only where no letter or digit
  // adjoins them, so a pair such as v=2 leaves dev=2 alone. A pair's value is
  // also replaced on its own when it's a credential, wherever it occurs.
  const secrets = new Set<string>();
  const pairs = new Set<string>();
  const userinfo = new Set<string>();
  const standalone = (value: string): void => { if (value.length >= 8) secrets.add(value); };
  const decode = (value: string, query = false): string => {
    try { return decodeURIComponent(query ? value.replace(/\+/g, ' ') : value); }
    catch { return value; }
  };
  // Percent-escapes in lowercase hex, as some encoders write them.
  const lowerEscapes = (value: string): string => value.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
  // A string as written; as JSON encoders write it, with JSON.stringify's
  // escapes (a quote, a backslash, a control character) and with its
  // slashes escaped too, as some encoders write them; and percent-encoded in
  // either case of hex (a string encodeURIComponent refuses, such as one
  // with an unpaired surrogate, has no encoded form).
  const withEncoded = (value: string): void => {
    const json = JSON.stringify(value).slice(1, -1);
    for (const written of [value, json]) {
      standalone(written);
      standalone(written.replace(/\//g, '\\/'));
    }
    let encoded: string;
    try { encoded = encodeURIComponent(value); } catch { return; /* no percent-encoded form */ }
    standalone(encoded);
    standalone(lowerEscapes(encoded));
  };
  // The token as sent: raw in a header, and percent- or form-encoded where a
  // transport puts it in a url.
  const token = config.token ?? '';
  withEncoded(token);
  const formEncoded = new URLSearchParams({ t: token }).toString().slice(2);
  standalone(formEncoded);
  standalone(lowerEscapes(formEncoded));
  // A stdio server's environment values whose names say they carry a
  // credential: a part of the name that ends with a credential word
  // (GITHUB_TOKEN, API_KEY, PGPASSWORD, ACCESSTOKEN), and not one where the
  // word only begins or sits inside a part (GIT_AUTHOR_NAME, KEYBOARD_LAYOUT,
  // TOKENIZERS_PARALLELISM).
  for (const [name, value] of Object.entries(config.env ?? {})) {
    // A JavaScript host can pass a value that isn't a string; only strings are derived.
    if (typeof value === 'string' && name.split(/[_\-.]/).some((part) => CREDENTIAL_NAME_PART.test(part))) withEncoded(value);
  }
  let url: URL | undefined;
  try { url = new URL(config.url ?? ''); } catch { /* Still remove the static token. */ }
  if (url) {
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
  }
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ...[...secrets].map(value => ({ value, source: escape(value) })),
    ...[...pairs].map(value => ({ value, source: `(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])` })),
    ...[...userinfo].map(value => ({ value, source: `(?<![A-Za-z0-9])${escape(value)}(?=@)` })),
  ];
}

/**
 * Every place one of the given patterns matches becomes `redacted`,
 * overlapping places included: the matches are found in the text as given,
 * a match may begin inside another, and each run of overlapping matches is
 * replaced as one. So two strings that overlap, one's end being the other's
 * start, are both replaced whole, and the replacement is never scanned.
 */
export function credentialRedactor(patterns: readonly CredentialPattern[]): (text: unknown) => string {
  if (patterns.length === 0) return asText;
  // Longest first, so at each place the longest string that matches there is
  // the match.
  const sources = [...patterns].sort((a, b) => b.value.length - a.value.length).map(({ source }) => source);
  const pattern = new RegExp([...new Set(sources)].join('|'), 'g');
  return (text) => {
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
    let from = 0;
    for (const [start, end] of spans) {
      redacted += `${input.slice(from, start)}redacted`;
      from = end;
    }
    return redacted + input.slice(from);
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
 * `enabledCapabilities: toolLifecycle.observe` or `autofetch.maxBytes`: each
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
 * 'manual'` (the default), `toolLifecycle` with only `maxInputBytes` or
 * with an `observe` or `inputs` that isn't a policy object (which grants
 * nothing), an `autofetch` bound at or below its default, and
 * `shouldTriggerInference`, which only narrows which channel messages
 * trigger inference. So a host that stamps a deny-list on every server it
 * deploys can deploy a modern one. Empty values grant nothing either.
 */
export function mcplPolicyGrants(config: McplServerConfig): string[] {
  const grants: string[] = [];
  if (isEffective(config.allowHostCommands)) grants.push('allowHostCommands');
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
 * design added, so every configuration that worked before still passes.
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
        `MCP server "${config.id}": requestTimeoutMs must be an integer from 1 to ${MAX_TIMER_MS} for a modern server (got ${String(timeout)}); every modern call has a deadline`,
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
