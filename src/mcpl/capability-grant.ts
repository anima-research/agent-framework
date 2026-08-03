/**
 * Capability grants — the MCPL 0.5 security boundary (SPEC §5.4).
 *
 * Three layers, kept deliberately distinct:
 *
 *  1. **Advertisement walk** — what the server *can* do, read from its
 *     initialize response by a generic recursive walk over the §6.2
 *     vocabulary. Boolean `true` at any level is shorthand for every leaf
 *     beneath it (§5.1). An unrecognized member name cannot mint a
 *     capability. Advertisement is an input, never an authorization.
 *
 *  2. **Config mask** — host policy from `enabledCapabilities` /
 *     `disabledCapabilities` (folded in from PR #75, Meganeuridae's
 *     capability-scoping work, semantics unchanged). This is the DENY
 *     direction, so a pattern matching a parent masks the whole subtree —
 *     deny-safe by construction.
 *
 *  3. **The grant** — the intersection, expressed as an explicit allowlist
 *     of full capability paths. `effectiveCapabilities` is the sole
 *     normative allowlist; **absence is denial and there is no unspecified
 *     state**. Matching here is NOT the mask's subtree matching: `*` matches
 *     exactly one segment, segment counts must agree, and a bare parent
 *     grants nothing beneath it (§5.4 as pinned 2026-08-02 — the suffix
 *     reading was implemented once and adjudicated out; see mcpl e869744).
 *
 * §13.4: `contextHooks.beforeInference.inject.system` is DENIED BY DEFAULT.
 * A server that needs it must be granted it explicitly via
 * `enabledCapabilities`. This is the one place the default is not
 * "everything advertised survives the mask", and it is loud when it fires.
 */

import type { McplCapabilities, McplServerConfig } from './types.js';

// ============================================================================
// §6.2 vocabulary
// ============================================================================

/**
 * The closed capability-path vocabulary (SPEC §6.2). A tree, not a flat
 * list, because the advertisement walk and boolean-shorthand expansion are
 * defined over the tree. Leaves are `null`; interior nodes that are
 * themselves grantable paths (e.g. `inferenceRequest`) appear as nodes whose
 * path is also emitted when advertised.
 */
const VOCABULARY: CapNode = {
  pushEvents: null,
  tools: null,
  modelInfo: null,
  inferenceRequest: { streaming: null },
  inferenceLifecycle: null,
  contextHooks: {
    beforeInference: {
      observe: null,
      inject: { system: null, beforeUser: null, afterUser: null },
    },
  },
  channels: {
    register: null,
    lifecycle: null,
    publish: null,
    incoming: null,
    streaming: null,
    acknowledge: null,
    typing: null,
  },
};

interface CapNodeMap {
  [key: string]: CapNode;
}
type CapNode = CapNodeMap | null;

/** Interior nodes that are grantable paths in their own right (§6.2 lists
 *  `inferenceRequest` alongside `inferenceRequest.streaming`). Namespaces
 *  (`contextHooks`, `channels`, `inject`) are not: they hold no authority. */
const SELF_GRANTABLE_INTERIOR = new Set(['inferenceRequest']);

/** Every full path in the vocabulary (leaves plus self-grantable interiors). */
export const ALL_CAPABILITY_PATHS: readonly string[] = (() => {
  const out: string[] = [];
  const walk = (node: CapNodeMap, prefix: string): void => {
    for (const [key, child] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child === null) {
        out.push(path);
      } else {
        if (SELF_GRANTABLE_INTERIOR.has(path)) out.push(path);
        walk(child, path);
      }
    }
  };
  walk(VOCABULARY, '');
  return out;
})();

const KNOWN_PATHS = new Set(ALL_CAPABILITY_PATHS);

/** Is this exact string a §6.2 capability path? (Used by §6.4 `uses`
 *  validation — `uses` MUST contain only these values.) */
export function isKnownCapabilityPath(path: string): boolean {
  return KNOWN_PATHS.has(path);
}

// ============================================================================
// Advertisement walk (§5.1)
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectSubtree(node: CapNode, path: string, out: Set<string>): void {
  if (node === null) {
    out.add(path);
    return;
  }
  if (SELF_GRANTABLE_INTERIOR.has(path)) out.add(path);
  for (const [key, child] of Object.entries(node)) {
    collectSubtree(child, path ? `${path}.${key}` : key, out);
  }
}

/**
 * The set of full capability paths a capabilities object advertises.
 * Generic recursive walk; `true` at any level advertises every leaf beneath
 * it; `false`/absent advertises nothing; unrecognized member names are
 * ignored — an unknown name cannot mint a capability.
 */
export function advertisedPaths(capabilities: McplCapabilities | null): Set<string> {
  const out = new Set<string>();
  if (!capabilities) return out;
  const walk = (vocab: CapNode, value: unknown, prefix: string): void => {
    if (vocab === null || !isPlainObject(value)) return;
    for (const [key, child] of Object.entries(vocab)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const v = value[key];
      if (v === true) {
        collectSubtree(child, path, out);
      } else if (isPlainObject(v)) {
        if (child !== null) {
          if (SELF_GRANTABLE_INTERIOR.has(path)) out.add(path);
          walk(child, v, path);
        }
      }
      // false / absent / non-object-non-true: advertises nothing.
    }
  };
  walk(VOCABULARY, capabilities as unknown as Record<string, unknown>, '');
  return out;
}

// ============================================================================
// Grant matching (§5.4) — one-segment wildcards, equal counts
// ============================================================================

/**
 * `*` matches exactly one dot-segment; literal segments match exactly;
 * segment counts MUST agree. A bare parent does not match its subtree and a
 * trailing `*` is not a suffix wildcard (SPEC §5.4, pinned 2026-08-02).
 */
export function capabilityPatternMatches(pattern: string, path: string): boolean {
  const p = pattern.split('.');
  const n = path.split('.');
  if (p.length !== n.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== '*' && p[i] !== n[i]) return false;
  }
  return true;
}

// ============================================================================
// The grant
// ============================================================================

/** §13.4: denied unless explicitly enabled by host config. */
const DENY_BY_DEFAULT: readonly string[] = ['contextHooks.beforeInference.inject.system'];

export class CapabilityGrant {
  /** Exact granted paths (already expanded — no patterns stored). */
  private readonly granted: ReadonlySet<string>;
  /** Advertised-but-denied paths, for the §5.3 diagnostic field only. */
  readonly deniedPaths: readonly string[];

  constructor(granted: Set<string>, deniedPaths: string[]) {
    this.granted = granted;
    this.deniedPaths = deniedPaths;
  }

  /** Sole authorization question. Absence is denial (§5.4). */
  has(path: string): boolean {
    return this.granted.has(path);
  }

  /** Sorted list for `effectiveCapabilities` (§5.3). */
  effectiveList(): string[] {
    return [...this.granted].sort();
  }

  /** True when nothing at all is granted. */
  isEmpty(): boolean {
    return this.granted.size === 0;
  }

  static empty(): CapabilityGrant {
    return new CapabilityGrant(new Set(), []);
  }

  /**
   * The grant carried by a connection-like object, failing CLOSED when the
   * object has none. Registry consumers receive whatever the registry holds
   * — including test stubs and objects created before the field existed —
   * and a missing grant must mean "nothing granted" (§5.4 absence is
   * denial), never a TypeError that takes the gate down open-ended.
   */
  static of(conn: { grant?: CapabilityGrant } | null | undefined): CapabilityGrant {
    return conn?.grant ?? CapabilityGrant.empty();
  }

  /**
   * A copy of this grant with the named paths removed — the reduction
   * primitive. §6.7's ordering contract lives at the call site: install the
   * narrowed grant (establishGrant) BEFORE sending the reducing
   * featureSets/update Request; security cannot wait on consent.
   */
  without(...paths: string[]): CapabilityGrant {
    const granted = new Set(this.granted);
    const denied = new Set(this.deniedPaths);
    for (const p of paths) {
      if (granted.delete(p)) denied.add(p);
    }
    return new CapabilityGrant(granted, [...denied].sort());
  }
}

/**
 * Compute the effective grant for a connection: the server's advertisement
 * (post config-mask — the mask runs first at handshake, so `capabilities`
 * here is already the masked object) intersected with the deny-by-default
 * floor. `enabledCapabilities` config patterns can re-grant a
 * deny-by-default path — that is the explicit decision §13.4 asks for.
 */
export function computeGrant(
  capabilities: McplCapabilities | null,
  config: Pick<McplServerConfig, 'enabledCapabilities'>,
): CapabilityGrant {
  const advertised = advertisedPaths(capabilities);
  const granted = new Set<string>();
  const denied: string[] = [];

  const explicitlyEnabled = (path: string): boolean =>
    !!config.enabledCapabilities?.some((pat) => capabilityPatternMatches(pat, path));

  for (const path of advertised) {
    if (DENY_BY_DEFAULT.includes(path) && !explicitlyEnabled(path)) {
      denied.push(path);
      console.error(
        `[mcpl] "${path}" advertised but DENIED BY DEFAULT (SPEC §13.4) — ` +
          `grant it explicitly via enabledCapabilities if intended`,
      );
      continue;
    }
    granted.add(path);
  }

  return new CapabilityGrant(granted, denied.sort());
}
