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
 */

import type { McplCapabilities, McplServerConfig } from './types.js';

/** Result of masking: the surviving capabilities plus what was dropped. */
export interface MaskedCapabilities {
  capabilities: McplCapabilities | null;
  /**
   * Dotted paths of advertised capabilities removed by the mask (e.g.
   * `contextHooks.afterInference`). When an entire multi-flag capability is
   * removed (`channels` advertised as a boolean, or every advertised channel
   * flag masked), the bare parent path (`channels`) is included so inbound
   * enforcement can key on it.
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
 * `contextHooks` (or `*`) covers `contextHooks.afterInference`, so masking a
 * parent masks everything beneath it.
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

/** Object-valued capabilities whose flags are maskable one level down. */
const NESTED_KEYS = new Set(['contextHooks', 'channels']);

/**
 * Intersect a server's advertised MCPL capabilities with the host config's
 * `enabledCapabilities` / `disabledCapabilities`.
 *
 * Semantics mirror enabledTools/disabledTools: if `enabledCapabilities` is
 * set, only advertised capabilities matching at least one pattern survive;
 * `disabledCapabilities` removes matches and wins on conflict. Patterns are
 * dotted paths with `*` matching one segment, and a pattern that matches a
 * parent (`contextHooks`) covers every flag beneath it. `version` and
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

  const keep = (path: string): boolean => {
    if (disabled && anyMatches(disabled, path)) return false;
    if (enabled) return anyMatches(enabled, path);
    return true;
  };

  const masked: Record<string, unknown> = {};
  const dropped: string[] = [];
  const source = capabilities as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (UNMASKABLE_KEYS.has(key)) {
      masked[key] = value;
      continue;
    }

    // Object-valued capability with individually maskable flags.
    if (NESTED_KEYS.has(key) && typeof value === 'object' && value !== null) {
      const flags = value as Record<string, unknown>;
      const survivors: Record<string, unknown> = {};
      let advertisedFlags = 0;

      for (const [flag, flagValue] of Object.entries(flags)) {
        if (flagValue === undefined || flagValue === false) continue;
        advertisedFlags++;
        const path = `${key}.${flag}`;
        if (keep(path)) {
          survivors[flag] = flagValue;
        } else {
          dropped.push(path);
        }
      }

      if (Object.keys(survivors).length > 0) {
        masked[key] = survivors;
      } else if (advertisedFlags > 0) {
        // Whole capability removed — record the bare parent for inbound
        // enforcement (channels/* rejection keys on `channels`).
        dropped.push(key);
      }
      continue;
    }

    // Leaf capability (boolean or opaque object, e.g. inferenceRequest,
    // or `channels: true` from servers that advertise the boolean form).
    if (value === false) {
      masked[key] = value;
      continue;
    }
    if (keep(key)) {
      masked[key] = value;
    } else {
      dropped.push(key);
    }
  }

  return { capabilities: masked as unknown as McplCapabilities, dropped };
}
