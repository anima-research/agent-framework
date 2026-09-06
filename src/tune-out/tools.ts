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
  /** Model id; defaults to the primary agent's (same-model side-process). */
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
}
