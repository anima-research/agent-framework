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
import type { McplServerConfig } from './types.js';

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

/**
 * Configuration fields that are MCPL policy: they have no meaning for a modern
 * server, which cannot negotiate MCPL. Setting one there is rejected rather
 * than ignored, so an operator who chose a policy learns that it cannot apply.
 */
export const MCPL_ONLY_POLICY_FIELDS = [
  'enabledFeatureSets',
  'disabledFeatureSets',
  'enabledCapabilities',
  'disabledCapabilities',
  'scopes',
  'channelSubscription',
  'allowHostCommands',
  'toolLifecycle',
  'autofetch',
  'shouldTriggerInference',
] as const satisfies readonly (keyof McplServerConfig)[];

type BindingFields = Pick<McplServerConfig, 'id' | 'command' | 'url' | 'transport' | 'protocol'>;

function urlScheme(config: BindingFields): string {
  let parsed: URL;
  try {
    parsed = new URL(config.url!);
  } catch {
    throw new Error(`MCP server "${config.id}": invalid url "${config.url}"`);
  }
  return parsed.protocol;
}

/**
 * Resolve a server's family and transport. Throws on a configuration that
 * names no usable transport (for example an `ftp://` URL, or
 * `transport: 'http'` with a WebSocket URL).
 */
export function resolveServerBinding(config: BindingFields): ServerBinding {
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
        `MCP server "${config.id}": transport "${config.transport}" does not match url "${config.url}"`,
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
  if (config.protocol !== undefined) {
    if (config.protocol !== 'legacy' && config.protocol !== 'modern') {
      problems.push(`MCP server "${config.id}": protocol must be 'legacy' or 'modern', got ${JSON.stringify(config.protocol)}`);
    } else if (binding.transport !== 'stdio') {
      problems.push(
        `MCP server "${config.id}": "protocol" applies only to stdio (command) servers; the url's scheme decides a network server's family`,
      );
    }
  }
  if (binding.family === 'modern') {
    const timeout = config.requestTimeoutMs;
    if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_TIMER_MS)) {
      problems.push(
        `MCP server "${config.id}": requestTimeoutMs must be an integer from 1 to ${MAX_TIMER_MS} for a modern server (got ${String(timeout)}); every modern call has a deadline`,
      );
    }
    for (const field of MCPL_ONLY_POLICY_FIELDS) {
      if (isEffective(config[field])) {
        problems.push(`MCP server "${config.id}": "${field}" is MCPL policy, which a modern MCP server cannot negotiate`);
      }
    }
  }
  return problems;
}

/** A host a connection to which never leaves this machine. The unspecified
 *  addresses count: a connection to 0.0.0.0 or [::] reaches this host. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host) ||
    host === '0.0.0.0' || host === '[::]';
}

/**
 * What is usable in a server configuration but worth an operator's attention,
 * as messages; empty when there is nothing. A credential (`token` or
 * `accessProvider`) for an `http://` or `ws://` url whose host isn't loopback
 * crosses the network in cleartext, in the `Authorization` header or the
 * WebSocket `?token=` query. That can be deliberate, on a private network or
 * behind a TLS-terminating proxy, so it is a warning and never a refusal.
 */
export function serverConfigWarnings(config: McplServerConfig): string[] {
  if (!config.token && !config.accessProvider) return [];
  let transport: McpTransportKind;
  try {
    transport = resolveServerBinding(config).transport;
  } catch {
    return []; // an unusable configuration is serverConfigProblems' to report
  }
  if (transport === 'stdio') return [];
  const url = new URL(config.url!);
  if ((url.protocol !== 'http:' && url.protocol !== 'ws:') || isLoopbackHost(url.hostname)) return [];
  const secure = url.protocol === 'http:' ? 'https' : 'wss';
  return [
    `MCP server "${config.id}": its credential goes to ${url.host} unencrypted (${url.protocol}//), where anything on the ` +
      `network path can read it; use ${secure}:// unless that network is trusted`,
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
