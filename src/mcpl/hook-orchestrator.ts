/**
 * HookOrchestrator — manages before/after inference fan-out to MCPL servers.
 *
 * This is the bridge between the MCPL protocol and the agent-framework inference
 * pipeline. It collects ContextInjection[] from MCPL servers via beforeInference
 * and feeds them into context-manager's compile(). Turn boundaries are announced
 * via metadata-only `inference/lifecycle` notifications (§10.5) —
 * context/afterInference and its modifiedResponse are removed in 0.5.0.
 *
 * Design principles:
 * - Fail-open: timeouts and errors never block inference
 * - Parallel fan-out with per-server timeouts
 * - Loop prevention: rejects inference/request while inside a hook
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { ContextInjection } from '@animalabs/context-manager';

import type {
  McplContentBlock,
  McplContextInjection,
  BeforeInferenceParams,
  BeforeInferenceResult,
  InferenceLifecycleParams,
} from './types.js';
import type { McplServerRegistry } from './server-registry.js';
import type { McplServerConnection } from './server-connection.js';
import type { FeatureSetManager } from './feature-set-manager.js';
import { CapabilityGrant } from './capability-grant.js';

/** Timeout for beforeInference per server (fail-open). */
const BEFORE_INFERENCE_TIMEOUT_MS = 5_000;

/** The three injection positions and their §6.2 capability paths. Position
 *  is the TYPED field on the injection — authorization never reads the
 *  response's featureSet (§5.4). */
const INJECT_LEAVES: ReadonlyArray<{ position: string; path: string }> = [
  { position: 'system', path: 'contextHooks.beforeInference.inject.system' },
  { position: 'beforeUser', path: 'contextHooks.beforeInference.inject.beforeUser' },
  { position: 'afterUser', path: 'contextHooks.beforeInference.inject.afterUser' },
];

/**
 * Races a promise against a timeout. Rejects with a descriptive error on timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ============================================================================
// Content conversion: McplContentBlock / McplContextInjection → membrane types
// ============================================================================

/**
 * Convert a single MCPL wire-format content block to a membrane ContentBlock.
 */
function convertBlock(block: McplContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'image':
      if (block.data && block.mimeType) {
        return {
          type: 'image',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        };
      }
      if (block.uri) {
        return {
          type: 'image',
          source: { type: 'url', url: block.uri },
        };
      }
      // Malformed image block — degrade to text
      return { type: 'text', text: '[Image: missing data]' };

    case 'audio':
      if (block.data && block.mimeType) {
        return {
          type: 'audio',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        };
      }
      // Audio without inline data — degrade to text
      return { type: 'text', text: `[Audio: ${block.uri ?? 'missing data'}]` };

    case 'resource':
      // Resources don't have a direct membrane equivalent — degrade to text
      return { type: 'text', text: `[Resource: ${block.uri}]` };
  }
}

/**
 * Convert MCPL injection content (string shorthand or block array) to membrane ContentBlock[].
 */
function convertContent(content: string | McplContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content.map(convertBlock);
}

/**
 * Convert an MCPL wire-format context injection to a context-manager ContextInjection.
 */
function convertMcplInjection(mcplInj: McplContextInjection): ContextInjection {
  return {
    namespace: mcplInj.namespace,
    position: mcplInj.position,
    content: convertContent(mcplInj.content),
    metadata: mcplInj.metadata,
  };
}

// ============================================================================
// HookOrchestrator
// ============================================================================

export class HookOrchestrator {
  private registry: McplServerRegistry;
  private featureSetManager: FeatureSetManager;
  private _isInHook = false;

  constructor(registry: McplServerRegistry, featureSetManager: FeatureSetManager) {
    this.registry = registry;
    this.featureSetManager = featureSetManager;
  }

  /**
   * Whether a hook is currently executing.
   * Used for loop prevention: inference/request from servers should be rejected
   * while this is true (enforced by Step 6's InferenceRouter).
   */
  get isInHook(): boolean {
    return this._isInHook;
  }

  /**
   * Fan out `context/beforeInference` to all capable MCPL servers in parallel.
   *
   * Returns aggregated ContextInjection[] ready for context-manager's compile().
   * Fail-open: servers that time out or error are silently skipped.
   */
  async beforeInference(params: BeforeInferenceParams): Promise<ContextInjection[]> {
    // §5.4: the GRANT decides fan-out, not the raw advertisement — which
    // also fixes selection for the recursive §5.1 shape, where
    // `beforeInference: {observe: true, …}` is an object, not `true`. A
    // server granted any inject.* leaf but not observe is still CALLED
    // (§10.1 — the hook is how injection happens) and receives
    // `userMessage: null` instead of the user's text.
    const servers = this.registry.getAllServers().filter((s) =>
      CapabilityGrant.of(s).has('contextHooks.beforeInference.observe')
      || INJECT_LEAVES.some((leaf) => CapabilityGrant.of(s).has(leaf.path)),
    );
    if (servers.length === 0) {
      return [];
    }

    this._isInHook = true;
    try {
      return await this.fanOutBeforeInference(servers, params);
    } finally {
      this._isInHook = false;
    }
  }

  /**
   * Fan out `inference/lifecycle` (§10.5) — the metadata-only replacement
   * for context/afterInference. Notifications, fire-and-forget, gated on the
   * inferenceLifecycle grant. BEST-EFFORT by design: the host attempts one
   * terminal per `started` on every exit path it controls; consumers dedupe
   * by inferenceId and keep a safety timeout. Never blocks the turn.
   */
  emitLifecycle(params: InferenceLifecycleParams): void {
    for (const server of this.registry.getAllServers()) {
      if (!CapabilityGrant.of(server).has('inferenceLifecycle')) continue;
      try {
        server.sendInferenceLifecycle(params);
      } catch {
        /* best-effort — a failed notify never disturbs the turn */
      }
    }
  }

  // ==========================================================================
  // Private: beforeInference fan-out
  // ==========================================================================

  private async fanOutBeforeInference(
    servers: McplServerConnection[],
    params: BeforeInferenceParams,
  ): Promise<ContextInjection[]> {
    const results = await Promise.allSettled(
      servers.map((server) => {
        // §10.1: a server not granted observe MUST receive
        // `userMessage: null` — the field is ABSENT authority, not merely
        // discouraged — while the hook is still invoked so granted
        // injection positions keep working (write-without-read).
        const perServer: BeforeInferenceParams =
          CapabilityGrant.of(server).has('contextHooks.beforeInference.observe')
            ? params
            : { ...params, userMessage: null };
        return withTimeout(
          server.sendBeforeInference(perServer),
          BEFORE_INFERENCE_TIMEOUT_MS,
          `beforeInference to "${server.id}"`,
        ).then((result) => ({ server, result }));
      }),
    );

    const injections: ContextInjection[] = [];

    for (const settled of results) {
      if (settled.status === 'rejected') {
        // Fail-open: timeout or transport error — skip this server
        continue;
      }

      const { server, result } = settled.value;

      // Feature-set discipline (diagnostics; §5.4 forbids using the
      // response-supplied featureSet as AUTHORIZATION — that is the
      // position check below).
      try {
        this.featureSetManager.validateInbound(server.id, result.featureSet);
      } catch {
        // Feature set not enabled or unknown — skip injections from this server
        continue;
      }

      // §5.4/§10.8: authorize EACH injection by its typed position against
      // the grant CURRENT NOW, at response receipt — not when the request
      // was sent. A revocation that landed while the hook was in flight is
      // enforced here without extra machinery.
      if (result.contextInjections && result.contextInjections.length > 0) {
        for (const mcplInj of result.contextInjections) {
          const leaf = INJECT_LEAVES.find((l) => l.position === mcplInj.position);
          if (!leaf || !CapabilityGrant.of(server).has(leaf.path)) {
            console.error(
              `[mcpl] ${server.id}: dropped beforeInference injection at position ` +
                `"${mcplInj.position}" — not in the effective grant (§10.8)`,
            );
            continue;
          }
          injections.push(convertMcplInjection(mcplInj));
        }
      }
    }

    return injections;
  }

}
