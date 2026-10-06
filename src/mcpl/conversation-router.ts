/**
 * ConversationRouter — routes incoming channel messages to per-channel
 * conversation agents ("forks") instead of the primary conversation.
 *
 * The router is a lookup table plus policy — deliberately no LLM in the
 * routing path. The framework consults it from handleMcplChannelIncoming:
 *
 * - A channel with an active binding routes to its bound agent. Whether the
 *   message *triggers* inference (vs. just landing in the fork's context) is
 *   a separate per-channel-kind rule: in a busy channel everything is case
 *   input but only mentions demand a reply.
 * - An unbound channel binds (→ the framework spawns a fork from the
 *   template/trunk agent) when the bind rule matches: by default any message
 *   in a DM, an explicit bot mention in a channel (`metadata.mentioned`,
 *   set server-side by the platform adapters).
 * - Everything else is left unrouted and dropped by the framework — the
 *   trunk is a dormant template, not a listener.
 *
 * Bindings expire after an idle TTL. Expiry runs a final closure turn on the
 * fork (see framework wiring) and unbinds; the next qualifying message on
 * that channel spawns a *fresh* fork (generation + 1) from the current
 * trunk, so handbook/template updates propagate between engagements.
 *
 * The binding table is in-memory — bindings are re-established by the next
 * qualifying message after a restart. The generation counters, by contrast,
 * are persisted by the framework (exportGenerations/hydrateGenerations):
 * a restarted host must NOT reuse generation 1's agent name, or it would
 * reopen the previous engagement's Chronicle namespace and re-seed the
 * template context on top of the old history.
 *
 * DEPRECATED (anima-research/agent-framework#235): per-channel conversation
 * routing is being retired. Behavior is unchanged for now; the framework
 * logs one `[deprecated]` line when it is configured. Removal is a
 * follow-up.
 */

import type { ContextStrategy } from '@animalabs/context-manager';
import type { ChannelDescriptor } from './types.js';

// ============================================================================
// Config & types
// ============================================================================

/** When an unbound channel acquires a fork. */
export type BindRule = 'always' | 'mention' | 'never';

/** When a message on a bound channel triggers inference (it always lands in
 * the fork's context). */
export type TriggerRule = 'always' | 'mention';

/** How a channel is classified for bind/trigger rules. Group DMs are their
 * own kind: the bot was added deliberately (so they bind like DMs) but they
 * host multi-human chatter (so they trigger like channels by default —
 * inferring on every message of a four-human group DM is a firehose). */
export type ChannelKind = 'dm' | 'groupDm' | 'channel';

/** Logged once by the framework when `FrameworkConfig.conversations` is set. */
export const CONVERSATION_ROUTING_DEPRECATION_NOTICE =
  'Per-channel conversation routing (FrameworkConfig.conversations) is deprecated and will ' +
  'be removed in a future release. Its \'mention\' bind/trigger rule reads ' +
  'metadata.mentioned, which not every channel server sets (discord-mcpl does not), so on ' +
  'such channels an @-mention neither binds a fork nor triggers a bound one. Routing still ' +
  'works for now. See anima-research/agent-framework#235.';

/**
 * @deprecated Per-channel conversation routing is deprecated and will be
 * removed (anima-research/agent-framework#235). Its 'mention' bind/trigger
 * rule reads `metadata.mentioned`, which not every channel server sets.
 * Behavior is unchanged for now.
 */
export interface ConversationRouterConfig {
  /** Agent whose context seeds new forks (the "trunk"/warm checkpoint). */
  templateAgent: string;

  /** Bind rules per channel kind.
   * Defaults: dm 'always', groupDm 'always', channel 'mention'. */
  bind?: { dm?: BindRule; groupDm?: BindRule; channel?: BindRule };

  /** Trigger rules per channel kind.
   * Defaults: dm 'always', groupDm 'mention', channel 'mention'. */
  trigger?: { dm?: TriggerRule; groupDm?: TriggerRule; channel?: TriggerRule };

  /**
   * Idle time before a binding expires and the fork is closed. Default 12h.
   *
   * Expiry is checked at most about once a minute, so the effective
   * granularity is ~60s: a short TTL can close its fork up to ~60s after it
   * elapses.
   */
  idleTtlMs?: number;

  /** Final system-initiated user message sent to a fork on expiry. */
  closurePrompt?: string;

  /** Prefix for generated fork agent names. Default 'conversation'. */
  agentPrefix?: string;

  /**
   * Fresh compression strategy per fork. Strategy instances are stateful and
   * must not be shared between ContextManagers, so the template agent's own
   * strategy is never reused — without a factory, forks get passthrough.
   */
  strategyFactory?: () => ContextStrategy;
}

export interface ConversationBinding {
  channelId: string;
  agentName: string;
  /** Engagement counter per channel — fresh forks get a new generation. */
  generation: number;
  boundAt: number;
  lastActivity: number;
}

/** The facts route() needs about one incoming message, pre-extracted by the
 * framework so the router stays free of event-shape knowledge. */
export interface IncomingMessageFacts {
  channelId: string;
  /** Personal mention of the bot (metadata.mentioned from the adapter). */
  mentioned: boolean;
  /** Channel classification (see classifyChannel). */
  kind: ChannelKind;
}

export type RoutingDecision =
  /** Channel already has a fork — deliver there. */
  | { kind: 'existing'; agentName: string; trigger: boolean }
  /** Bind rule matched — framework should spawn this agent, then bind(). */
  | { kind: 'spawn'; agentName: string; generation: number; trigger: boolean }
  /** No binding and bind rule didn't match — drop. */
  | { kind: 'unbound' };

const DEFAULT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

export const DEFAULT_CLOSURE_PROMPT =
  '[system] This engagement is closing due to inactivity. Finalize your ' +
  'work: post any promised results to the channel and record outstanding ' +
  'threads as unresolved. Do not ask follow-up questions.';

// ============================================================================
// ConversationRouter
// ============================================================================

/**
 * @deprecated Per-channel conversation routing is deprecated and will be
 * removed (anima-research/agent-framework#235). Behavior is unchanged for
 * now; the framework logs one `[deprecated]` line when it constructs a
 * router from `FrameworkConfig.conversations`.
 */
export class ConversationRouter {
  private config: ConversationRouterConfig;

  /** Active bindings, keyed by channelId. */
  private bindings = new Map<string, ConversationBinding>();

  /** Engagement counter per channel — survives unbind, so a re-bound channel
   * gets a distinct fork agent name. */
  private generations = new Map<string, number>();

  constructor(config: ConversationRouterConfig) {
    this.config = config;
  }

  get templateAgent(): string {
    return this.config.templateAgent;
  }

  get closurePrompt(): string {
    return this.config.closurePrompt ?? DEFAULT_CLOSURE_PROMPT;
  }

  get idleTtlMs(): number {
    return this.config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  get strategyFactory(): (() => ContextStrategy) | undefined {
    return this.config.strategyFactory;
  }

  /**
   * Decide where an incoming message goes without changing router state.
   * The framework calls bind() after a fork exists and touch() after a
   * message is delivered. Queries and failed deliveries leave idle clocks
   * unchanged; a failed spawn doesn't leave a dangling route.
   */
  route(facts: IncomingMessageFacts): RoutingDecision {
    const existing = this.bindings.get(facts.channelId);

    if (existing) {
      return {
        kind: 'existing',
        agentName: existing.agentName,
        trigger: this.shouldTrigger(facts),
      };
    }

    const bindRule = this.config.bind?.[facts.kind]
      ?? (facts.kind === 'channel' ? 'mention' : 'always');

    const binds =
      bindRule === 'always' || (bindRule === 'mention' && facts.mentioned);
    if (!binds) {
      return { kind: 'unbound' };
    }

    const generation = (this.generations.get(facts.channelId) ?? 0) + 1;
    return {
      kind: 'spawn',
      agentName: this.forkAgentName(facts.channelId, generation),
      generation,
      trigger: this.shouldTrigger(facts),
    };
  }

  /**
   * Record a binding after the framework successfully spawned the fork.
   * Returns the new binding.
   */
  bind(channelId: string, agentName: string, generation: number, now = Date.now()): ConversationBinding {
    this.generations.set(channelId, generation);
    const binding: ConversationBinding = {
      channelId,
      agentName,
      generation,
      boundAt: now,
      lastActivity: now,
    };
    this.bindings.set(channelId, binding);
    return binding;
  }

  /** Record delivered activity on an existing binding. Does not bind a
   * channel or advance its generation. Call after successful delivery, not
   * when previewing a route. The optional clock supports deterministic use. */
  touch(channelId: string, now = Date.now()): void {
    const binding = this.bindings.get(channelId);
    if (binding) binding.lastActivity = now;
  }

  unbind(channelId: string): void {
    this.bindings.delete(channelId);
  }

  getBinding(channelId: string): ConversationBinding | undefined {
    return this.bindings.get(channelId);
  }

  /** Reverse lookup: the channel an agent is bound to, if any. */
  channelForAgent(agentName: string): string | undefined {
    for (const binding of this.bindings.values()) {
      if (binding.agentName === agentName) return binding.channelId;
    }
    return undefined;
  }

  getBindings(): ConversationBinding[] {
    return Array.from(this.bindings.values());
  }

  /** Bindings whose idle TTL has elapsed. Does not unbind — the framework
   * runs the closure turn first, then calls unbind(). */
  expired(now = Date.now()): ConversationBinding[] {
    const ttl = this.idleTtlMs;
    return this.getBindings().filter((b) => now - b.lastActivity >= ttl);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Classify a channel from its descriptor and/or message metadata. Slack
   * marks DMs/group DMs with is_im/is_mpim on the channel descriptor and
   * channel_type on each message; other platforms can adopt either
   * convention.
   */
  static classifyChannel(
    descriptor?: ChannelDescriptor,
    messageMetadata?: Record<string, unknown>,
  ): ChannelKind {
    const meta = descriptor?.metadata as Record<string, unknown> | undefined;
    if (meta?.is_im === true) return 'dm';
    if (meta?.is_mpim === true) return 'groupDm';
    const channelType = messageMetadata?.channel_type;
    if (channelType === 'im') return 'dm';
    if (channelType === 'mpim') return 'groupDm';
    return 'channel';
  }

  /** Export the per-channel engagement counters for persistence — they must
   * survive restarts, or a re-engaged channel reuses generation 1's name and
   * reopens (and re-seeds) the previous engagement's Chronicle namespace. */
  exportGenerations(): Record<string, number> {
    return Object.fromEntries(this.generations);
  }

  /** Restore persisted engagement counters (see exportGenerations). */
  hydrateGenerations(generations: Record<string, number>): void {
    for (const [channelId, generation] of Object.entries(generations)) {
      if (typeof generation === 'number' && generation > (this.generations.get(channelId) ?? 0)) {
        this.generations.set(channelId, generation);
      }
    }
  }

  private shouldTrigger(facts: IncomingMessageFacts): boolean {
    const rule = this.config.trigger?.[facts.kind]
      ?? (facts.kind === 'dm' ? 'always' : 'mention');
    return rule === 'always' || facts.mentioned;
  }

  /** `conversation-slack-C123-g2` — agent names double as Chronicle
   * namespace components, so the channel id is sanitized. */
  private forkAgentName(channelId: string, generation: number): string {
    const prefix = this.config.agentPrefix ?? 'conversation';
    const safe = channelId.replace(/[^A-Za-z0-9_-]+/g, '-');
    return `${prefix}-${safe}-g${generation}`;
  }
}
