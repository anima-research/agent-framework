/**
 * The subconscious's tool surface (issue #77).
 *
 * Deliberately small and channel-scoped: the subconscious observes the
 * merged timeline, judges wakes, and reports — it is not a general agent.
 * Names and results carry no credential/config vocabulary; everything it
 * says to the resident is its own text (never host-templated), delivered
 * under its own participant name. Prose is never auto-routed
 * (proseRouting: 'explicit' on its AgentConfig): speaking into a channel
 * happens only through speak_in_channel, so a timer-triggered turn can
 * never leak bare prose to the default locus.
 */

import type { ToolDefinition } from '../types/index.js';

export const SUBCONSCIOUS_TOOL_NAMES = [
  'deliver_summary',
  'cancel_tuneout',
  'note_disposition',
  'speak_in_channel',
] as const;

export type SubconsciousToolName = (typeof SUBCONSCIOUS_TOOL_NAMES)[number];

export const SUBCONSCIOUS_TOOLS: ToolDefinition[] = [
  {
    name: 'deliver_summary',
    description:
      'Deliver a summary into the resident\'s context, in your own voice, ' +
      'addressed to them (second person). Use at cadence when the diverted ' +
      'traffic merits it; staying silent is always allowed — an empty ' +
      'period needs no report.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The summary, verbatim as the resident will read it.',
        },
        channelId: {
          type: 'string',
          description: 'The tuned-out channel this summary covers.',
        },
      },
      required: ['text', 'channelId'],
    },
  },
  {
    name: 'cancel_tuneout',
    description:
      'End the tune-out on a channel now — use when something needs the ' +
      'resident\'s full attention. The diverted backlog is delivered to ' +
      'them (capped), and normal attention resumes. Add your own note in ' +
      '`text`; it arrives alongside the backlog, in your voice.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        text: {
          type: 'string',
          description: 'Your accompanying note to the resident (optional).',
        },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'note_disposition',
    description:
      'Record a standing disposition for yourself — a durable note that ' +
      'shapes how you treat future traffic ("antra\'s pings always ' +
      'escalate", "ignore release-bot"). Replaces any previous note under ' +
      'the same key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short stable identifier.' },
        text: {
          type: 'string',
          description: 'The disposition. Empty string deletes the key.',
        },
      },
      required: ['key', 'text'],
    },
  },
  {
    name: 'speak_in_channel',
    description:
      'Post a message into a tuned-out channel, clearly as yourself (not ' +
      'as the resident). Use sparingly — e.g. to tell someone the resident ' +
      'is tuned out and when to expect them. Disabled unless the resident\'s ' +
      'configuration allows it.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['channelId', 'text'],
    },
  },
];

/**
 * Configuration for the subconscious (FrameworkConfig.subconscious). Two
 * shapes, by `reader`:
 *
 * - `'persistent'` (default): one persistent side-agent with an isolated
 *   slot and a windowed read-only view of the residents' timeline, as
 *   issue #77 built it. Its `systemPrompt` is a system prompt.
 * - `'forks'`: a succession of forks of the resident (Dendrite). Each
 *   cadence tick, coalesced wake and cancel derives a short-lived fork at
 *   the resident's head — the resident's whole prefix, its refusals
 *   included, ending with it — hands it the traffic held since the last
 *   look as the first message after the fork point, and lets it report
 *   back as attributed mail. No agent persists between invocations;
 *   dispositions do, in the coordinator's state. Its `voice` is framing,
 *   not a system prompt, and residents are shown the reader's four tools
 *   in their tool block (refused at dispatch), so the fork's request is
 *   the resident's up to the fork point.
 */
export type SubconsciousConfig = PersistentReaderConfig | ForkReaderConfig;

interface SubconsciousConfigBase {
  /** Master switch. */
  enabled: boolean;
  /** Allow speak_in_channel. Default false until the voice block has
   *  passed its canary round. */
  allowChannelSpeech?: boolean;
}

export interface PersistentReaderConfig extends SubconsciousConfigBase {
  reader?: 'persistent';
  /**
   * Registry + participant name. Default 'Subconscious' — following the
   * Context Manager precedent: a title-case functional voice, not an
   * agent-prefixed identifier.
   */
  name?: string;
  /** Model id; defaults to the primary agent's (same-model side-process). */
  model?: string;
  /**
   * The voice/criteria mode block — recipe-side and co-authored with the
   * resident (it is an aspect of their attention). Report-shaped, second
   * person toward the resident. Canary before fleet use (issue #77).
   */
  systemPrompt: string;
  /** WindowedPassthroughStrategy re-anchor fraction (default 0.5). */
  reAnchorFraction?: number;
}

export interface ForkReaderConfig extends SubconsciousConfigBase {
  reader: 'forks';
  /**
   * Whose weights run the fork. Required, never defaulted: a fork holds the
   * resident's whole prefix, and which model reads it is the one fact the
   * resident's consent names. The resident's own model is the copy; another
   * model is allowed when stated here. `create` refuses the omission.
   */
  model: string;
  /**
   * The reader's voice block — report-shaped, second person toward the
   * resident, co-authored with them. Delivered as the first message after
   * the fork point, with the notice, the standing dispositions and the held
   * traffic; never a system prompt.
   */
  voice: string;
  /**
   * A fresh context strategy instance for each fork, same class and
   * configuration as the resident's, so the fork reuses the resident's fold
   * state and rendering. Required unless the resident runs a passthrough
   * strategy.
   */
  strategyFactory?: () => import('@animalabs/context-manager').ContextStrategy;
  /** Idle timeout for one reader fork (default 10 minutes). */
  forkIdleTimeoutMs?: number;
}
