/**
 * Trace bridge: framework inference traces → relay wire messages.
 *
 * Translation (keyed by the `channelId` carried on inference:* traces):
 *   inference:started               → activation_start
 *   inference:tokens                → chunk
 *   inference:content_block         → block_start / block_complete
 *   inference:completed/turn_ended  → activation_end (complete)
 *   inference:aborted               → activation_end (abort)
 *   inference:failed                → activation_end (error)
 *
 * Traces without a channelId (channel-less turns: heartbeats, timers, or a
 * host with no channel registry) have no channel to route to and are dropped
 * with a debug log.
 *
 * The wire protocol's `visible` flag is derived as `blockType === 'text'`:
 * the tokens trace does not carry membrane's per-chunk visible bit, and for
 * every current blockType the two agree (thinking / tool content is never
 * voiced). block_complete's `content` is accumulated from the block's chunk
 * traces, matching the reference relay where bots send the full block text.
 */

import type { TraceEvent } from '../../types/trace.js';
import type { ModuleContext } from '../../types/module.js';
import type {
  ActivationEndReason,
  BlockType,
  RelayLogger,
  RelayToVoiceClientMessage,
} from './types.js';

/** Fan-out callback the module hands the bridge: send a relay message to a channel's subscribers. */
export type ChannelBroadcastFn = (channelId: string, msg: RelayToVoiceClientMessage) => void;

/**
 * Resolve the relay identity for a framework agent. `userId`/`username` are
 * display fields (e.g. from voice config). `botId` overrides the outgoing
 * botId (default: agentName) — the outbound relay client uses this, because
 * the relay rejects any message whose botId differs from the identity the
 * connection authenticated as.
 */
export type AgentIdentityResolver = (
  agentName: string,
) => { botId?: string; userId?: string; username?: string } | undefined;

export interface TraceBridge {
  /** Subscribe to the framework trace bus. Called from the module's start(). */
  start(ctx: ModuleContext): void;
  /** Unsubscribe. Called from the module's stop(). */
  stop(): void;
}

/**
 * Placeholder bridge: subscribes (validating the seam end to end) but drops
 * every event. Kept for tests that need an inert bridge.
 */
export class NoopTraceBridge implements TraceBridge {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly broadcast: ChannelBroadcastFn) {}

  start(ctx: ModuleContext): void {
    this.unsubscribe = ctx.onTrace((_event: TraceEvent) => {
      // Intentionally inert.
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/**
 * Real translator: framework-hosted agents produce the same relay wire
 * messages as relay-connected bots, with agentName as the default botId.
 */
export class InferenceTraceBridge implements TraceBridge {
  private unsubscribe: (() => void) | null = null;
  /** Per-agent, per-blockIndex text accumulation for block_complete.content. */
  private blockText: Map<string, Map<number, string>> = new Map();

  constructor(
    private readonly broadcast: ChannelBroadcastFn,
    private readonly resolveIdentity: AgentIdentityResolver = () => undefined,
    private readonly logger?: RelayLogger,
  ) {}

  start(ctx: ModuleContext): void {
    this.unsubscribe = ctx.onTrace((event: TraceEvent) => {
      try {
        this.translate(event);
      } catch (error) {
        this.logger?.error('Trace bridge translation failed', {
          error: String(error),
          traceType: event.type,
        });
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.blockText.clear();
  }

  private identity(agentName: string): { botId: string; userId: string; username: string } {
    const resolved = this.resolveIdentity(agentName);
    return {
      botId: resolved?.botId ?? agentName,
      userId: resolved?.userId ?? agentName,
      username: resolved?.username ?? agentName,
    };
  }

  private drop(event: TraceEvent): void {
    this.logger?.debug('Trace without channelId dropped (channel-less turn)', {
      traceType: event.type,
    });
  }

  private endActivation(
    agentName: string,
    channelId: string,
    reason: ActivationEndReason,
    timestamp: number,
  ): void {
    this.blockText.delete(agentName);
    this.broadcast(channelId, {
      type: 'activation_end',
      ...this.identity(agentName),
      channelId,
      reason,
      timestamp,
    });
  }

  private translate(event: TraceEvent): void {
    switch (event.type) {
      case 'inference:started': {
        if (!event.channelId) return this.drop(event);
        this.blockText.delete(event.agentName);
        this.broadcast(event.channelId, {
          type: 'activation_start',
          ...this.identity(event.agentName),
          channelId: event.channelId,
          timestamp: event.timestamp,
        });
        return;
      }

      case 'inference:tokens': {
        if (!event.channelId) return this.drop(event);
        let blocks = this.blockText.get(event.agentName);
        if (!blocks) {
          blocks = new Map();
          this.blockText.set(event.agentName, blocks);
        }
        blocks.set(event.blockIndex, (blocks.get(event.blockIndex) ?? '') + event.content);
        this.broadcast(event.channelId, {
          type: 'chunk',
          ...this.identity(event.agentName),
          channelId: event.channelId,
          text: event.content,
          blockIndex: event.blockIndex,
          blockType: event.blockType as BlockType,
          visible: event.blockType === 'text',
          timestamp: event.timestamp,
        });
        return;
      }

      case 'inference:content_block': {
        if (!event.channelId) return this.drop(event);
        if (event.phase === 'block_start') {
          this.blockText.get(event.agentName)?.delete(event.blockIndex);
          this.broadcast(event.channelId, {
            type: 'block_start',
            ...this.identity(event.agentName),
            channelId: event.channelId,
            blockIndex: event.blockIndex,
            blockType: event.blockType as BlockType,
            timestamp: event.timestamp,
          });
        } else {
          const content = this.blockText.get(event.agentName)?.get(event.blockIndex) ?? '';
          this.broadcast(event.channelId, {
            type: 'block_complete',
            ...this.identity(event.agentName),
            channelId: event.channelId,
            blockIndex: event.blockIndex,
            blockType: event.blockType as BlockType,
            content,
            timestamp: event.timestamp,
          });
        }
        return;
      }

      // Terminal signals are mutually exclusive per turn: a plain turn emits
      // `completed`, an endTurn-tool turn emits `turn_ended`, a user abort
      // emits `aborted` (from abortInference — the stream's follow-up
      // `exhausted` is deliberately NOT bridged to avoid a double
      // activation_end), and a provider error emits `failed`.
      case 'inference:completed':
      case 'inference:turn_ended': {
        if (!event.channelId) return this.drop(event);
        this.endActivation(event.agentName, event.channelId, 'complete', event.timestamp);
        return;
      }

      case 'inference:aborted': {
        if (!event.channelId) return this.drop(event);
        this.endActivation(event.agentName, event.channelId, 'abort', event.timestamp);
        return;
      }

      case 'inference:failed': {
        if (!event.channelId) return this.drop(event);
        this.endActivation(event.agentName, event.channelId, 'error', event.timestamp);
        return;
      }

      default:
        return;
    }
  }
}
