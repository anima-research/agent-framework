import type { ContentBlock } from '@animalabs/membrane';
import { authorLine } from '../author-presentation.js';
import type { StoredMessage } from '@animalabs/context-manager';
import { appendAll } from '../append-all.js';
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

import type { AgentConfig, ToolDefinition } from '../types/index.js';

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
      'Deliver a summary into the resident\'s context: `text` arrives there ' +
      'verbatim (leading and trailing whitespace trimmed), under your own ' +
      'name.',
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
      'End the tune-out on a channel. The diverted backlog is delivered ' +
      'to the resident (capped), and the channel\'s traffic reaches them as ' +
      'it did before the tune-out, unless the all-except hold holds it too. ' +
      'A note in `text` arrives alongside the ' +
      'backlog, verbatim (leading and trailing whitespace trimmed), under ' +
      'your own name. Where the cancel has to wait (an operator\'s change to ' +
      'the store, say), its answer says so, and whether your note waits with ' +
      'it. If you were started to read ' +
      'one hold, you can end only that hold.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'A tuned-out channel, or a channel held by the all-except hold (which ends that hold, unless scope is "channel").' },
        scope: { type: 'string', enum: ['channel', 'all-except'], description: '"all-except" ends the all-except hold outright; "channel" ends only the channel\'s own tune-out.' },
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
      'Record a standing disposition: a durable note, kept under `key` ' +
      'across invocations and shown to the reader each time it runs (e.g. ' +
      'key "<sender>", text "<a note on their messages>"). Replaces any ' +
      'previous note under the same key.',
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
      'Post `text` into a tuned-out channel, as written (leading and trailing ' +
      'whitespace trimmed). It goes out through ' +
      'the resident\'s publish path, so the channel sees it under the ' +
      'resident\'s account; nothing in the post names you. If you were ' +
      'started to read one hold, you can post only into a channel that hold ' +
      'still holds, and a post made once it has ended is refused; your report ' +
      'can say it instead. Disabled unless the resident\'s configuration ' +
      'allows it.',
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
 * Who reads a tuned-out channel's traffic, as the text a resident reads
 * says it: the persistent subconscious by the name it runs under, or reader
 * forks. There is no hold without a reader (0.33.0) but one whose release
 * failed after the persistent reader ended, or at a start with none
 * configured: none runs then (`running: false`), the reader named as
 * configured, or by its default name, for tune_out's own text, and what a
 * held channel's messages are says that none reads them (tuneOutHeldWords,
 * tunedOutTrafficWords). A persistent reader's name is a value the host
 * supplied, marked as such (suppliedValue).
 */
export type TuneOutReader =
  | { readonly kind: 'persistent'; readonly name: string; readonly running?: false }
  | { readonly kind: 'forks' };

/**
 * What a tuned-out channel's messages are, as the words after "its
 * messages" in a refusal a resident reads (a channel tool's on a tuned-out
 * channel): held from it and read by `reader`, by the name it runs under or
 * as forks of the resident's context.
 */
export function tuneOutHeldWords(reader: TuneOutReader): string {
  if (reader.kind === 'persistent' && reader.running === false) {
    return "are held from you, with no reader running here to read them, until the tune-out's release, which failed, is tried again";
  }
  return reader.kind === 'persistent' ? `are held from you and read by ${reader.name}`
    : 'are held from you and read by forks of your context';
}

/**
 * What a tuned-out channel's traffic is, as the words after "its traffic"
 * in the [tuned out] note to a send there: held from the resident and read
 * by `reader` until the tune-out ends, or, where none runs, held until its
 * release is tried again (TuneOutReader).
 */
export function tunedOutTrafficWords(reader: TuneOutReader): string {
  if (reader.kind === 'persistent' && reader.running === false) {
    return "is still held from you, with no reader running here to read it, until the tune-out's release, which failed, is tried again.";
  }
  return reader.kind === 'persistent'
    ? `is still held from you, and read by ${reader.name}, until the tune-out ends.`
    : 'is still held from you, and read by forks of your context, until the tune-out ends.';
}

/**
 * Whether a tuned-out channel's messages get to its reader, as the words
 * after "its messages" in tune_out's answers about the channel's transport,
 * in the sentence's `form`: they reach `reader`, by the name it runs under
 * or as "the reader" (forks, as tuneOutTool says it). Where no reader runs,
 * those answers aren't given: tuneOutNoReaderAnswer is, in their place.
 */
export function tuneOutReachWords(reader: TuneOutReader, form: 'reach' | 'may not reach' | "don't reach"): string {
  return `${form} ${reader.kind === 'persistent' ? reader.name : 'the reader'}`;
}

/**
 * tune_out's answer about a tuned-out channel's transport where no reader
 * runs (`running: false`, a hold left on record by a failed release): a
 * sentence of its own, given alone in place of each answer that says
 * whether the messages reach the reader and when (tuneOutReachWords), since
 * opening the channel doesn't change that none reads them. Undefined where
 * a reader runs. tune_out is refused with no reader, repeated for a channel
 * already tuned out too, so this answers a tune_out whose reader ended
 * while its channel's open was out.
 */
export function tuneOutNoReaderAnswer(reader: TuneOutReader): string | undefined {
  if (reader.kind !== 'persistent' || reader.running !== false) return undefined;
  return 'The tune-out is recorded, but its messages are held, with no reader running here to read them, until the '
    + "tune-out's release, which failed, is tried again; opening its channel doesn't change that.";
}

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
  /**
   * Allow speak_in_channel. Default false until the voice block has passed
   * its canary round. A reader's post goes out through the resident's own
   * publish path, so the channel sees it under the resident's account, in
   * the reader's words; nothing in the request names the reader. With it
   * off, a reader fork can post nowhere: every tool but its own is refused
   * at dispatch (the block it is shown stays the resident's, for the
   * shared prefix).
   */
  allowChannelSpeech?: boolean;
  /** The reader's model's context window, as AgentConfig.physicalWindowTokens,
   *  in place of the primary's. Left out or null, a reader on the primary's
   *  model has the primary's; on another model, the persistent reader has
   *  none and a fork has the primary's. */
  physicalWindowTokens?: AgentConfig['physicalWindowTokens'];
  /** The reader's model's thinking binding, as AgentConfig.thinkingBinding,
   *  in place of the primary's. Left out, null or false, a reader on the
   *  primary's model has the primary's; on another model, the persistent
   *  reader has none and a fork has the primary's. `{ binds: false }` gives
   *  a reader none. */
  thinkingBinding?: AgentConfig['thinkingBinding'];
}

/**
 * The name a persistent reader runs under: its configuration's `name`, or,
 * where the host gave none, `'Subconscious'` (PersistentReaderConfig.name).
 * The one place the framework names a reader the host didn't: everything
 * that needs the name of an unnamed reader asks this.
 */
export function persistentReaderName(config: { name?: string }): string {
  return config.name ?? 'Subconscious';
}

export interface PersistentReaderConfig extends SubconsciousConfigBase {
  reader?: 'persistent';
  /**
   * Registry + participant name. Default 'Subconscious' — following the
   * Context Manager precedent: a title-case functional voice, not an
   * agent-prefixed identifier. persistentReaderName applies the default.
   */
  name?: string;
  /** Model id; defaults to the primary agent's (same-model side-process).
   *  Another id, compared exactly, makes the subconscious leave out the
   *  fields that describe the primary's model, its window and its thinking
   *  binding (SUBCONSCIOUS_MODEL_FIELDS); `physicalWindowTokens` and
   *  `thinkingBinding` set its own. */
  model?: string;
  /**
   * The persistent reader's system prompt (its AgentConfig.systemPrompt).
   * Who writes it and what it says, a policy for the reader tools
   * included, are the host's choice. Canary before fleet use (issue #77).
   */
  systemPrompt: string;
  /** WindowedPassthroughStrategy re-anchor fraction (default 0.5). */
  reAnchorFraction?: number;
  /**
   * How a resident's rounds go out in the subconscious's requests once its
   * window follows the presentation index (#291, answer 13). Its own rounds go
   * as stored either way.
   *
   * - `'transcript'` (the default): a line per tool call (the tool's name and
   *   its input in brief) and per result (its outcome in brief), the text as
   *   stored, and none of the resident's thinking (foreign-rounds.ts).
   * - `'raw'`: as stored, as 0.30.0 sent them: the resident's thinking
   *   blocks, its tool calls and their results, in the subconscious's
   *   requests under the resident's name. A provider pairs tool blocks only
   *   in the turns of the agent that made the call, so it may refuse them, or
   *   the formatter may move them into the subconscious's own turns, where
   *   they read as calls it made.
   *
   * A thinking block's signature binds the block to the prefix the resident
   * was sent, so the block can't be sent as part of another agent's prefix;
   * its text could be. Leaving the text out is the transcript's choice, not
   * the provider's.
   */
  foreignRounds?: 'transcript' | 'raw';
}

export interface ForkReaderConfig extends SubconsciousConfigBase {
  reader: 'forks';
  /**
   * Whose weights run the fork. Required, never defaulted: a fork holds the
   * resident's whole prefix, and which model reads it is recorded on each
   * fork's `dendrite:agent-created` trace and is what a host's
   * `dendrite.beforeDerive` can decide on. The resident's own model, or
   * another model stated here. `create` refuses the omission.
   */
  model: string;
  /**
   * The reader's voice block: text the host supplies, handed to `framing`.
   * The default framing (defaultReaderFraming) puts it in the one message a
   * fork receives after the fork point, with the notice, the standing
   * dispositions and the held traffic; it is never a system prompt. Who
   * writes it and what it says, a policy for the reader tools included,
   * are the host's choice.
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
  /**
   * How a reader fork is prompted: the content of the one message it
   * receives after the fork point. Default `defaultReaderFraming`. The
   * framework stores whatever this returns as a user message with
   * `metadata.kind = 'tune-out-reader-framing'`; the notice, voice,
   * dispositions and held traffic are in the context, and nothing else
   * about the fork's prompt is fixed by the path. note_disposition tells a
   * reader that a disposition it records is shown to the reader each time
   * it runs, and a fork is shown them only as its framing puts them
   * (`dispositions`), so a framing that leaves them out makes that untrue.
   * Likewise the held traffic reaches the fork only as its framing puts it
   * (`backlog`): the fork's view, the residents', leaves the raw rows out,
   * as it leaves out all held traffic (the default framing shows them).
   */
  framing?: (context: ReaderFramingContext) => ContentBlock[];
}

/** What a reader fork's framing is built from. */
export interface ReaderFramingContext {
  /** The resident the fork was derived from. */
  resident: string;
  /** The fork's own name. */
  fork: string;
  /** `ForkReaderConfig.voice`. */
  voice: string;
  channelId: string;
  epochId: string;
  trigger: 'cadence' | 'wake' | 'cancel';
  /** The coordinator's notice for this invocation (`[Tune-out wake: …]` etc.). */
  notice: string;
  /** Standing dispositions recorded on the epoch, or null. */
  dispositions: string | null;
  /**
   * The traffic held since the last look, oldest first, as stored; empty
   * when nothing arrived. A held message is stored as it arrives, the
   * resident's turn alive or not (#291), so the stored rows are all of it,
   * but for one a surgery's hold or a manager awaiting recovery keeps in
   * memory: it isn't stored yet, and is in the first backlog after it is.
   */
  backlog: StoredMessage[];
  /**
   * Was how many of `backlog`'s last entries were still queued behind the
   * resident's turn. Since #291 nothing is queued, so the framework never
   * sets it.
   *
   * @deprecated Never set since #291; removed in a later release.
   */
  queuedCount?: number;
}

/**
 * The default reader-fork framing: a header naming the channel, epoch and
 * trigger; the notice; the voice block; standing dispositions if any; then
 * the held traffic as `author: text` lines with non-text blocks (images,
 * documents) preserved in order as the source supplied them.
 */
export function defaultReaderFraming(ctx: ReaderFramingContext): ContentBlock[] {
  const header =
    `[Tune-out reader — ${ctx.channelId}, epoch ${ctx.epochId.slice(0, 8)}, ${ctx.trigger}]\n` +
    `${ctx.notice}\n\n${ctx.voice}` +
    (ctx.dispositions ? `\n\n[Standing dispositions]\n${ctx.dispositions}` : '');
  const content: ContentBlock[] = [{ type: 'text', text: header }];
  if (ctx.backlog.length === 0) {
    content.push({ type: 'text', text: '\n[Nothing new has been held since your last look.]' });
    return content;
  }
  const n = ctx.backlog.length;
  const lines: string[] = [`\n[Held in ${ctx.channelId} since your last look: ${n} message${n === 1 ? '' : 's'}]`];
  const flush = () => {
    if (lines.length > 0) content.push({ type: 'text', text: lines.splice(0).join('\n') });
  };
  for (const message of ctx.backlog) {
    const author = (message.metadata as { author?: { name?: string } } | undefined)?.author?.name ?? message.participant;
    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    lines.push(authorLine(author, text));
    const media = message.content.filter((b) => b.type !== 'text');
    if (media.length > 0) {
      flush();
      appendAll(content, media);
    }
  }
  flush();
  return content;
}
