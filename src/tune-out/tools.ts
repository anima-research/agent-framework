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
 * Configuration for the subconscious resident (FrameworkConfig.subconscious).
 */
export interface SubconsciousConfig {
  /** Master switch. */
  enabled: boolean;
  /**
   * Registry + participant name. Default 'Subconscious' — following the
   * Context Manager precedent: a title-case functional voice, not an
   * agent-prefixed identifier.
   */
  name?: string;
  /**
   * Model id; defaults to the primary agent's (same-model side-process).
   * With `reader: 'forks'` a fork holds the resident's whole prefix, so it
   * runs on the resident's weights: a different `model` is refused at
   * `create`, never silently applied or silently ignored.
   */
  model?: string;
  /**
   * The voice/criteria mode block — recipe-side and co-authored with the
   * resident (it is an aspect of their attention). Report-shaped, second
   * person toward the resident. Canary before fleet use (issue #77).
   */
  systemPrompt: string;
  /** Allow speak_in_channel. Default false until the voice block has
   *  passed its canary round. */
  allowChannelSpeech?: boolean;
  /** WindowedPassthroughStrategy re-anchor fraction (default 0.5). */
  reAnchorFraction?: number;
  /**
   * How the reader is realised.
   *
   * - `'persistent'` (default): one persistent side-agent with an isolated
   *   slot and a windowed read-only view of the residents' timeline, as
   *   issue #77 built it.
   * - `'forks'`: a succession of forks of the resident (Dendrite). Each
   *   cadence tick, coalesced wake and cancel derives a short-lived fork at
   *   the resident's head — same prefix, the resident's refusals included,
   *   ending with the resident — hands it the traffic held since the last
   *   look as ordinary framing, and lets it report back as attributed
   *   mail. No agent persists between invocations; dispositions do, in the
   *   coordinator's state. `systemPrompt` becomes the first framing message
   *   rather than the system prompt, so the resident's provider prefix is
   *   shared. Residents are shown the reader's four tools in their tool
   *   block (refused at dispatch) for the same reason.
   */
  reader?: 'persistent' | 'forks';
  /**
   * `reader: 'forks'`: a fresh context strategy instance for each fork,
   * same class and configuration as the resident's, so the fork reuses the
   * resident's fold state and rendering. Required unless the resident runs
   * a passthrough strategy.
   */
  strategyFactory?: () => import('@animalabs/context-manager').ContextStrategy;
  /** `reader: 'forks'`: idle timeout for one reader fork (default 10 minutes). */
  forkIdleTimeoutMs?: number;
}
