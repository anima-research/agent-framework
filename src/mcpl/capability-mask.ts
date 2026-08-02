/**
 * Host-side capability scoping for MCPL servers.
 *
 * A server names its own capabilities in its initialize response, and
 * everything downstream — hook fan-out, channel streaming, push handling —
 * keys off that self-advertisement. `enabledCapabilities` /
 * `disabledCapabilities` in McplServerConfig let the host intersect the
 * advertisement with its own policy at handshake time, so a capability the
 * config masks behaves exactly as if the server had never advertised it.
 *
 * The mask is applied once, where the negotiated capabilities are stored
 * (McplServerConnection.handshake), rather than re-checked at each consumer:
 * hook orchestration, streaming observation, and capability queries all read
 * the already-masked object. Inbound server-initiated methods gated by a
 * masked capability are additionally rejected at the connection
 * (see METHOD_TO_REQUIRED_CAPABILITY in server-connection.ts).
 *
 * Matching is a generic recursive walk per SPEC 0.5 §5.4: every path at
 * every depth is addressable (`contextHooks.beforeInference.inject.system`
 * works the day the host stores that shape), and a pattern matching a parent
 * masks the whole subtree. No hardcoded set of nestable keys.
 */

import type { McplCapabilities, McplServerConfig } from './types.js';

/** Result of masking: the surviving capabilities plus what was dropped. */
export interface MaskedCapabilities {
  capabilities: McplCapabilities | null;
  /**
   * Dotted paths of advertised capabilities removed by the mask (e.g.
   * `contextHooks.afterInference`). When an entire multi-flag capability is
   * removed (`channels` advertised as a boolean, denied as a parent, or
   * every advertised flag masked), the bare parent path (`channels`) is
   * included so inbound enforcement can key on it.
   */
  dropped: string[];
}

/**
 * Segment-wise wildcard match, same rules as feature-set patterns:
 * `*` matches exactly one dot-segment, literal segments match exactly,
 * segment counts must agree.
 */
function wildcardMatch(pattern: string, name: string): boolean {
  const patternParts = pattern.split('.');
  const nameParts = name.split('.');

  if (patternParts.length !== nameParts.length) {
    return false;
  }

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p === '*') {
      continue;
    }
    if (p !== nameParts[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Whether a pattern matches a capability path or any ancestor prefix of it —
 * `contextHooks` (or `*`) covers `contextHooks.beforeInference.inject.system`
 * at any depth, so masking a parent masks everything beneath it.
 */
function patternMatchesPath(pattern: string, path: string): boolean {
  const parts = path.split('.');
  for (let depth = parts.length; depth >= 1; depth--) {
    if (wildcardMatch(pattern, parts.slice(0, depth).join('.'))) {
      return true;
    }
  }
  return false;
}

function anyMatches(patterns: string[], path: string): boolean {
  return patterns.some((pattern) => patternMatchesPath(pattern, path));
}

/** Keys that are negotiation metadata, not grantable capabilities. */
const UNMASKABLE_KEYS = new Set(['version', 'featureSets']);

/**
 * Interior object paths whose object value is itself the capability, with
 * children as refinements — dropping a refinement leaves the capability
 * granted (`inferenceRequest` minus `.streaming` is still inferenceRequest).
 * Every other interior object is a pure namespace (`contextHooks`,
 * `channels`, a future `inject`): it holds no authority of its own and is
 * pruned when all its advertised children are masked.
 *
 * This is a retention-shape distinction only — matching and addressability
 * are fully generic and depth-unbounded either way.
 */
const OBJECT_CAPABILITY_PATHS = new Set(['inferenceRequest', 'contextHooks.afterInference']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Intersect a server's advertised MCPL capabilities with the host config's
 * `enabledCapabilities` / `disabledCapabilities`.
 *
 * Semantics mirror enabledTools/disabledTools: if `enabledCapabilities` is
 * set, only advertised capabilities matching at least one pattern survive;
 * `disabledCapabilities` removes matches and wins on conflict. Patterns are
 * dotted paths with `*` matching one segment, and a pattern that matches a
 * parent (`contextHooks`) covers every path beneath it. `version` and
 * `featureSets` are never masked here — feature sets have their own
 * enable/disable knobs.
 *
 * With neither list set, the advertisement passes through untouched.
 */
export function maskNegotiatedCapabilities(
  capabilities: McplCapabilities | null,
  config: Pick<McplServerConfig, 'enabledCapabilities' | 'disabledCapabilities'>,
): MaskedCapabilities {
  const enabled = config.enabledCapabilities;
  const disabled = config.disabledCapabilities;

  if (capabilities === null || (!enabled && !disabled)) {
    return { capabilities, dropped: [] };
  }

  const denied = (path: string): boolean => !!disabled && anyMatches(disabled, path);
  const allowed = (path: string): boolean => !enabled || anyMatches(enabled, path);
  const keep = (path: string): boolean => !denied(path) && allowed(path);

  const dropped: string[] = [];

  /**
   * Mask one interior object node. Returns the surviving object, or
   * undefined when the node is pruned entirely. Falsy children are carried
   * through untouched (they advertise nothing, so there is nothing to mask).
   */
  const maskNode = (node: Record<string, unknown>, path: string): Record<string, unknown> | undefined => {
    if (denied(path)) {
      dropped.push(path);
      return undefined;
    }

    const survivors: Record<string, unknown> = {};
    let advertised = 0;
    let survived = 0;

    for (const [key, value] of Object.entries(node)) {
      if (value === undefined) continue;
      if (!value) {
        // false / 0 / '' advertise nothing — preserve for fidelity.
        survivors[key] = value;
        continue;
      }
      advertised++;
      const childPath = path ? `${path}.${key}` : key;

      if (isPlainObject(value)) {
        const masked = maskNode(value, childPath);
        if (masked !== undefined) {
          survivors[key] = masked;
          survived++;
        }
        continue;
      }

      // Truthy leaf.
      if (keep(childPath)) {
        survivors[key] = value;
        survived++;
      } else {
        dropped.push(childPath);
      }
    }

    if (advertised === 0) {
      // No truthy children: the object itself is the advert (e.g.
      // `inferenceRequest: {}`), so its own path decides.
      if (keep(path)) return survivors;
      dropped.push(path);
      return undefined;
    }
    if (survived > 0) {
      return survivors;
    }

    // Every advertised child was masked. An object-capability keeps its
    // (still-granted) hull; a namespace holds no authority of its own and
    // is pruned, recording the bare path for inbound enforcement.
    if (OBJECT_CAPABILITY_PATHS.has(path) && keep(path)) {
      return survivors;
    }
    dropped.push(path);
    return undefined;
  };

  const masked: Record<string, unknown> = {};
  const source = capabilities as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (UNMASKABLE_KEYS.has(key) || !value) {
      masked[key] = value;
      continue;
    }

    if (isPlainObject(value)) {
      const node = maskNode(value, key);
      if (node !== undefined) {
        masked[key] = node;
      }
      continue;
    }

    // Truthy leaf at the top level (booleans, or `channels: true` from
    // servers that advertise the boolean form).
    if (keep(key)) {
      masked[key] = value;
    } else {
      dropped.push(key);
    }
  }

  return { capabilities: masked as unknown as McplCapabilities, dropped };
}
