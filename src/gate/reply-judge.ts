/**
 * ReplyJudge — the small model a `judge` wake rule asks whether now is a good
 * time for the agent to reply (JudgeConfig).
 *
 * Per batch it takes the agent's context as a dry run of the request it would
 * send if woken now (the framework's previewActivation, which commits
 * nothing), without what modules' gatherContext and MCPL servers'
 * beforeInference would inject, since gathering those has side effects. It
 * renders that as one plain-text document (the agent's conversation, oldest
 * first, then its system prompt, abridged), in which participant text is
 * escaped and indented so it can't make the document's structure, keeps the
 * newest part that fits the judge's input budget, and asks the model, with
 * the agent's own instructions and the batch, for one line:
 * `REPLY: <reason>` or `WAIT: <reason>`.
 *
 * Cost and latency. The budget (`maxInputTokens`, default 90,000) is set to
 * keep each request under the 100,000-token line past which Claude Haiku 5.5
 * costs five times as much, but it's met by an estimate. Tokens are estimated
 * from characters, at a ratio the judge corrects from every response's
 * reported input, so the estimate tracks the model's tokenizer and the
 * context's mix of prose and code. Until a response has corrected it, a
 * request on text denser than three characters a token (code, or Chinese,
 * Japanese or Korean text) can carry more than the budget, and so can one whose
 * newest message alone is over it, since the newest message is always shown
 * (cut to its own cap). A request the provider refuses as too long is asked
 * once more with the ratio halved, to no less than one character a token;
 * refused again, it fails as any failed call does. The document is
 * sent as a run of chunks that start at an anchor, the first message shown,
 * which stays put while the window grows into its budget: the chunks before
 * the newest stay byte-identical from one request to the next, and a cache
 * breakpoint after the last full one lets every later request read them from
 * the prompt cache. Only when the window outgrows its budget does the anchor
 * move, to leave the window a share of the budget to grow into again.
 *
 * The judge reads; it never writes into the agent's context and never speaks.
 */

import { NativeFormatter } from '@animalabs/membrane';
import type { ContentBlock, DetailedUsage, Membrane, NormalizedMessage, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { normalizeLineBreaks, oneLine } from '../supplied-text.js';
import type { FailedLastTurn, JudgeEventSummary, JudgeFn, JudgeRequest, JudgeVerdict, ReplyJudgeOptions, UpcomingWake } from './types.js';

/** The judge's model when the host names none. */
export const DEFAULT_JUDGE_MODEL = 'claude-haiku-5-5';
/** The judge's input budget when the host names none: under Haiku 5.5's 100K price line, with margin. */
export const DEFAULT_JUDGE_MAX_INPUT_TOKENS = 90_000;
/** The smallest input budget the judge takes: its instructions, the batch and a little context. A
 *  host that wants only the newest few messages read (a short tail, cheaper and quicker, with less
 *  of the room's history to weigh) sets a budget near it. */
export const MIN_JUDGE_INPUT_TOKENS = 4_000;

/** Characters per token the judge assumes before any response has told it better. */
const INITIAL_CHARS_PER_TOKEN = 3;
/** The share of each measured ratio the running estimate takes: more when the
 *  text proved denser than estimated (more tokens a character), which is the
 *  side that overruns the budget, less when sparser. */
const CALIBRATION_WEIGHT_DENSER = 0.6;
const CALIBRATION_WEIGHT_SPARSER = 0.2;
/** The share of the budget the system prompt (the agent's, abridged) may fill. */
const SYSTEM_SHARE = 0.08;
/** The share of the document budget a fresh window starts at, leaving the rest to grow into before the anchor moves. */
const FRESH_WINDOW_SHARE = 0.65;
/** Estimated tokens per cached chunk of the document: above every model's minimum cacheable prefix. */
const CHUNK_TOKENS = 6_000;
/** Tokens held back for the judge's own instructions, the batch and the question. */
const FIXED_TOKENS_RESERVE = 3_000;
/** Longest text block (characters) a message renders whole; a longer one keeps its head and tail. */
const MAX_TEXT_CHARS = 6_000;
/** Longest message (characters) rendered, all its blocks together. */
const MAX_MESSAGE_CHARS = 12_000;
/** Longest tool call input / tool result (characters) rendered. */
const MAX_TOOL_CHARS = 600;
/** Output tokens a verdict may take, adaptive thinking included: room enough
 *  that thinking at the model's default effort doesn't crowd out the line.
 *  Only what's generated is billed. */
const VERDICT_MAX_TOKENS = 4_096;
/** The share of the budget the batch's listing may fill; past it the oldest events are counted, not listed. */
const EVENTS_SHARE = 0.1;
/** The participant the judge's request names as the assistant: none of its messages is one. */
const JUDGE_PARTICIPANT = 'reply-judge';

/** What the framework gives the judge. */
export interface ReplyJudgeDeps {
  /** The membrane the judge calls for an agent. The framework's binds the
   *  judge as it binds compression, refusing a call rather than waiting under
   *  a hold, and never waits on the agent's turn. */
  membraneFor: (agentName: string) => Membrane;
  options?: ReplyJudgeOptions;
  /** Which of the batch's agents the judge reads the context of. */
  chooseAgent: (agentNames: string[]) => string | undefined;
  /** The request the agent would send if woken now, as a dry run (previewActivation), without its injections. */
  preview: (agentName: string) => Promise<NormalizedRequest>;
  /** Count a judge request's usage as the agent's, where its turns' usage is counted. */
  recordUsage?: (agentName: string, usage: DetailedUsage) => void;
  /** What else will wake the agent with no new event, beyond the gate's own
   *  timers the request carries: wakes the framework has queued or holds. A
   *  provider that throws counts as knowing of none. */
  upcomingWakes?: (agentName: string) => UpcomingWake[] | Promise<UpcomingWake[]>;
  /** The agent's last turn, when it failed and no turn has completed since:
   *  the judge then says what woke it may be unanswered. A provider that
   *  throws counts as no failed turn. */
  failedLastTurn?: (agentName: string) => FailedLastTurn | undefined;
}

/** One message of the agent's context, rendered. */
interface Entry {
  text: string;
  key: string;
}

/** Where the last request's window started, per agent. */
interface Anchor {
  /** The keys of the window's first few entries, to find it again. */
  keys: string[];
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quoted(text: string): string {
  return escapeText(normalizeLineBreaks(text)).replace(/\n/g, '\n  ');
}

function field(text: string): string {
  return escapeText(oneLine(text)).replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

/** A message as the document shows it: its participant, and each block as
 *  text, quoted (see `quoted`). Thinking is the agent's own, and isn't shown. */
export function renderMessage(message: NormalizedMessage): string {
  const parts: string[] = [];
  for (const block of message.content as ContentBlock[]) {
    const line = renderBlock(block);
    if (line) parts.push(line);
  }
  if (parts.length === 0) return '';
  return cut(`[${field(message.participant)}] ${quoted(parts.join('\n'))}`, MAX_MESSAGE_CHARS);
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return cut(block.text, MAX_TEXT_CHARS);
    case 'image':
    case 'generated_image':
      return '[image]';
    case 'document':
      return '[document]';
    case 'audio':
      return '[audio]';
    case 'video':
      return '[video]';
    case 'tool_use':
      return `[calls ${block.name}] ${cut(safeJson(block.input), MAX_TOOL_CHARS)}`;
    case 'tool_result': {
      const body = typeof block.content === 'string'
        ? block.content
        : block.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
      return `[${block.toolName ?? 'tool'} ${block.isError ? 'failed' : 'returned'}] ${cut(body, MAX_TOOL_CHARS)}`;
    }
    default:
      // thinking, redacted thinking, system changes: not the conversation.
      return '';
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Text no longer than `max` characters: a longer one keeps its head and tail, the middle named as cut. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 40) / 2);
  return `${text.slice(0, keep)} […${text.length - 2 * keep} characters cut…] ${text.slice(-keep)}`;
}

/** A cheap, stable key for an entry (FNV-1a over its text, with its length). */
function keyOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}:${text.length}`;
}

/** The text of a system prompt, as membrane's request may hold it. */
function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  }
  return '';
}

/** In how long, as the judge is told an upcoming wake. */
function inWhile(at: number | undefined, now: number): string {
  if (at === undefined) return 'as soon as it is free';
  const s = Math.max(0, Math.round((at - now) / 1000));
  if (s < 90) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return `in ${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/**
 * The agent's last turn, when it failed: what woke it may be unanswered,
 * whether or not the turn sent part of an answer, and whether a wake of the
 * agent's is on its way without a new event.
 */
export function failedTurnLine(failed: FailedLastTurn, agentName: string, now: number): string {
  const opening = `${agentName}'s last turn, ${ago(failed.at, now)}, failed and may not have answered all of what woke it.`;
  switch (failed.again.kind) {
    case 'queued':
      return `${opening} A wake for ${agentName} is already queued.`;
    case 'held':
      return `${opening} A wake for ${agentName} is held, ${failed.again.until !== undefined ? `due to be let go ${inWhile(failed.again.until, now)}` : 'and is let go when the hold on it is released'}.`;
    default:
      return `${opening} Nothing runs it again: if you answer WAIT, what woke it stays unanswered until something wakes ${agentName}.`;
  }
}

/**
 * What waiting would leave the agent with: whether its last turn failed, and
 * what wakes it anyway, soonest first, or that nothing the host knows of is
 * scheduled. A server's own timers (a heartbeat, a reminder) are listed only
 * where the host was told of them, so the empty case says so.
 */
export function ifYouWait(wakes: readonly UpcomingWake[], agentName: string, now: number, failed?: FailedLastTurn): string {
  const due = (w: UpcomingWake): number => (w.when !== undefined ? Infinity : w.at ?? now);
  const sorted = [...wakes].sort((a, b) => (due(a) === due(b) ? 0 : due(a) - due(b)));
  const listed = sorted.slice(0, 8).map((w) => `- ${w.when !== undefined ? field(w.when) : inWhile(w.at, now)}${w.certain ? '' : ', maybe'}: ${field(w.what)}`);
  const rest = sorted.slice(8);
  const maybe = rest.filter((w) => !w.certain).length;
  const more = rest.length > 0 ? [`- and ${rest.length} more${maybe > 0 ? `, ${maybe === rest.length ? 'each' : `${maybe} of them`} only maybe` : ''}`] : [];
  return [
    '<if_you_wait>',
    ...(failed ? [failedTurnLine(failed, agentName, now)] : []),
    ...(listed.length > 0
      ? [`If you answer WAIT and nothing new arrives, ${agentName} is next woken by:`, ...listed, ...more]
      : [`Nothing the host knows of is scheduled to wake ${agentName}: if you answer WAIT, it isn't woken until a new event arrives (a server's own timers, such as a heartbeat, may not be listed).`]),
    '</if_you_wait>',
  ].join('\n');
}

/** Seconds or minutes ago, as the batch shows each event. */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 120 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

/**
 * The verdict in a response's text: its last line that starts with REPLY or
 * WAIT in capitals followed by a colon or a dash, as the judge is asked to
 * write it. A capital word without one, or a lower-case "reply" or "wait" in
 * the judge's reasoning ("Wait, they did ask"), isn't a verdict.
 */
export function parseVerdict(text: string): { reply: boolean; reason: string } | undefined {
  const re = /^[\s*_>`#]*(REPLY|WAIT)[*_`]*\s*[:\-–—]\s*(.*)$/gm;
  let last: RegExpExecArray | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return undefined;
  return { reply: last[1] === 'REPLY', reason: last[2]!.trim().replace(/^[*_`]+|[*_`]+$/g, '').trim() };
}

/** The judge's own system prompt: stable per agent, so it caches. */
export function judgeSystemPrompt(agentName: string): string {
  return [
    `You are the reply judge for an AI agent named ${agentName}. The agent isn't woken for every message: when new`,
    'events arrive, you decide whether now is a good time to wake it so it can respond. Waking it costs it a turn;',
    "letting the events go by means it won't act on them until something else wakes it (they stay in its context,",
    'so it will see them then).',
    '',
    "You're given the agent's context as a document: its conversation, oldest first, cut from the oldest end to",
    "fit, then its system prompt (abridged). The agent's own messages are those from the participant named",
    `${agentName}. Then you're given the new events and, when it has written them, the agent's own instructions to you.`,
    "Its instructions are its preferences about its own attention and come first. Where they don't decide, wake it",
    'when it is addressed or asked something, when a reply from it is expected or would clearly help, or when',
    'something it is following needs it; let events go by when the talk is between others and does not need it,',
    'when it has already answered, or when replying would only add noise.',
    '',
    "You're also told what will wake the agent anyway if you let the events go by. Waiting costs little when it",
    "will be woken soon regardless; when nothing is scheduled, waiting means it may not see these events for a",
    'long time, so weigh how much they matter.',
    '',
    "Don't answer the messages yourself and don't speak as the agent. Answer with exactly one line:",
    '"REPLY: <a short reason>" to wake it, or "WAIT: <a short reason>" to let the events go by.',
  ].join('\n');
}

/** The closing message: the batch, the agent's instructions, the question. */
export function judgeQuestion(
  request: Pick<JudgeRequest, 'events' | 'instructions' | 'upcomingWakes'>, agentName: string, now: number, maxEventChars = Infinity,
  failed?: FailedLastTurn,
): string {
  // Newest first into the listing's share, shown oldest first; the rest are
  // counted, so a long held batch can't crowd out the context.
  const lines: string[] = [];
  let used = 0;
  let i = request.events.length;
  while (i > 0) {
    const e: JudgeEventSummary = request.events[i - 1]!;
    const where = e.channel ? ` in ${field(e.channel)}` : '';
    const who = e.authorId ? ` from ${field(e.authorId)}` : '';
    const addressed = e.addressed ? ' (addresses the agent)' : '';
    const line = `- ${ago(e.at, now)}${where}${who}${addressed}: ${quoted(e.content)}`;
    if (lines.length > 0 && used + line.length > maxEventChars) break;
    lines.unshift(line);
    used += line.length + 1;
    i--;
  }
  const parts = [
    `<new_events count="${request.events.length}">`,
    ...(i > 0 ? [`- (${i} earlier ${i === 1 ? 'event' : 'events'} in this batch not listed)`] : []),
    ...lines,
    '</new_events>',
  ];
  parts.push('', ifYouWait(request.upcomingWakes ?? [], agentName, now, failed));
  if (request.instructions && request.instructions.trim()) {
    parts.push('', `<instructions_from_${agentName.replace(/[^A-Za-z0-9_-]/g, '_')}>`, request.instructions.trim(), '</instructions_from_' + agentName.replace(/[^A-Za-z0-9_-]/g, '_') + '>');
  }
  parts.push('', `Should ${agentName} be woken now to respond? One line: "REPLY: <reason>" or "WAIT: <reason>".`);
  return parts.join('\n');
}

export class ReplyJudge {
  private readonly membraneFor: ReplyJudgeDeps['membraneFor'];
  private readonly cacheTtl: '5m' | '1h';
  private readonly model: string;
  private readonly maxInputTokens: number;
  private readonly effort: 'low' | 'medium' | 'high' | 'none';
  private readonly chooseAgent: ReplyJudgeDeps['chooseAgent'];
  private readonly preview: ReplyJudgeDeps['preview'];
  private readonly recordUsage: ReplyJudgeDeps['recordUsage'];
  private readonly extraWakes: ReplyJudgeDeps['upcomingWakes'];
  private readonly failedLastTurn: ReplyJudgeDeps['failedLastTurn'];
  /** Characters per token, corrected from each response's reported input. */
  private charsPerToken = INITIAL_CHARS_PER_TOKEN;
  private readonly anchors = new Map<string, Anchor>();

  constructor(deps: ReplyJudgeDeps) {
    this.membraneFor = deps.membraneFor;
    this.cacheTtl = deps.options?.cacheTtl === '1h' ? '1h' : '5m';
    this.model = deps.options?.model || DEFAULT_JUDGE_MODEL;
    const max = deps.options?.maxInputTokens;
    if (max === undefined) {
      this.maxInputTokens = DEFAULT_JUDGE_MAX_INPUT_TOKENS;
    } else if (typeof max !== 'number' || !Number.isFinite(max)) {
      this.maxInputTokens = DEFAULT_JUDGE_MAX_INPUT_TOKENS;
      console.error(`[gate] the reply judge's maxInputTokens isn't a number, so it's read as ${DEFAULT_JUDGE_MAX_INPUT_TOKENS}`);
    } else if (max < MIN_JUDGE_INPUT_TOKENS) {
      // At its nearest bound, as the gate reads a value out of range: a small
      // budget set to save money stays small.
      this.maxInputTokens = MIN_JUDGE_INPUT_TOKENS;
      console.error(`[gate] the reply judge's maxInputTokens is ${max}, under the ${MIN_JUDGE_INPUT_TOKENS} minimum, so it's read as ${MIN_JUDGE_INPUT_TOKENS}`);
    } else {
      this.maxInputTokens = Math.floor(max);
    }
    this.effort = deps.options?.effort ?? 'low';
    this.chooseAgent = deps.chooseAgent;
    this.preview = deps.preview;
    this.recordUsage = deps.recordUsage;
    this.extraWakes = deps.upcomingWakes;
    this.failedLastTurn = deps.failedLastTurn;
  }

  /** The gate's judge function. */
  readonly judge: JudgeFn = async (request) => this.decide(request);

  /** The ratio the judge estimates tokens by now (for tests and status). */
  estimateRatio(): number {
    return this.charsPerToken;
  }

  private tokens(chars: number): number {
    return Math.ceil(chars / this.charsPerToken);
  }

  /** Build the judge's request for one batch: the system prompt, the document in chunks, the question. */
  async buildRequest(request: JudgeRequest, now = Date.now()): Promise<{ request: NormalizedRequest; agentName: string; chars: number }> {
    const agentName = this.chooseAgent(request.agentNames);
    if (!agentName) throw new Error('no agent to judge for');
    const preview = await this.preview(agentName);
    if (request.signal.aborted) throw new Error('the judge was stopped before its request');

    let extra: UpcomingWake[] = [];
    try {
      extra = (await this.extraWakes?.(agentName)) ?? [];
    } catch {
      extra = [];
    }
    const upcoming = [...(request.upcomingWakes ?? []), ...extra];
    let failed: FailedLastTurn | undefined;
    try {
      failed = this.failedLastTurn?.(agentName);
    } catch {
      failed = undefined;
    }

    const system = judgeSystemPrompt(agentName);
    const question = judgeQuestion(
      { ...request, upcomingWakes: upcoming }, agentName, now, Math.floor(this.maxInputTokens * EVENTS_SHARE * this.charsPerToken), failed,
    );
    const fixedChars = system.length + question.length;

    // The budget the document may fill, in characters at the current ratio.
    const docTokens = Math.max(1_000, this.maxInputTokens - FIXED_TOKENS_RESERVE - this.tokens(fixedChars));
    const docChars = Math.floor(docTokens * this.charsPerToken);

    // The agent's system prompt comes after the conversation, just before the
    // question: a system prompt that changes between requests (a host that
    // writes the time or a status into it) then costs only its own tokens,
    // not the cached conversation before it.
    const agentSystem = systemText(preview.system);
    const systemChars = Math.floor(docChars * SYSTEM_SHARE);
    const about = [
      `## ${agentName}'s system prompt${agentSystem.length > systemChars ? ' (abridged)' : ''}`,
      '',
      agentSystem ? cut(agentSystem, systemChars) : '(none)',
    ].join('\n');
    const header = `# ${agentName}'s context\n\n## Conversation (oldest shown first)`;

    const entries: Entry[] = [];
    for (const message of preview.messages) {
      const text = renderMessage(message);
      if (text) entries.push({ text, key: keyOf(text) });
    }

    const windowChars = Math.max(0, docChars - header.length - about.length);
    const start = this.windowStart(agentName, entries, windowChars);
    const shown = entries.slice(start);
    if (shown.length > 0) {
      this.anchors.set(agentName, { keys: shown.slice(0, 3).map((e) => e.key) });
    }

    // Chunks of whole messages from the anchor, each closed at CHUNK_TOKENS:
    // the same entries from the same anchor make the same chunks, so every
    // chunk before the open one is the same bytes as last time.
    const chunkChars = CHUNK_TOKENS * INITIAL_CHARS_PER_TOKEN;
    const chunks: string[] = [];
    let current = start > 0 ? `${header}\n[…earlier messages not shown…]\n\n` : `${header}\n\n`;
    for (const entry of shown) {
      if (current.length + entry.text.length > chunkChars && current.length > 0) {
        chunks.push(current);
        current = '';
      }
      current += `${entry.text}\n\n`;
    }
    const open = current;

    const messages: NormalizedMessage[] = chunks.map((text, i) => ({
      participant: 'user',
      content: [{ type: 'text', text }],
      // After the last closed chunk: the prefix every later request shares.
      ...(i === chunks.length - 1 ? { cacheBreakpoint: true } : {}),
    }));
    if (open) messages.push({ participant: 'user', content: [{ type: 'text', text: open }] });
    messages.push({ participant: 'user', content: [{ type: 'text', text: about }] });
    messages.push({ participant: 'user', content: [{ type: 'text', text: question }] });

    const chars = system.length + messages.reduce((n, m) => n + (m.content[0] as { text: string }).text.length, 0);
    return {
      agentName,
      chars,
      request: {
        system,
        messages,
        config: { model: this.model, maxTokens: VERDICT_MAX_TOKENS },
        assistantParticipant: JUDGE_PARTICIPANT,
        promptCaching: true,
        cacheTtl: this.cacheTtl,
        ...(this.effort !== 'none' ? { providerParams: { output_config: { effort: this.effort } } } : {}),
      },
    };
  }

  /**
   * Where the window starts: at last request's anchor, while the window from
   * there fits; otherwise where the newest messages fill FRESH_WINDOW_SHARE
   * of the budget, leaving room to grow before it moves again.
   */
  private windowStart(agentName: string, entries: Entry[], windowChars: number): number {
    const tailFrom = (budget: number): number => {
      let used = 0;
      let i = entries.length;
      while (i > 0 && used + entries[i - 1]!.text.length + 2 <= budget) {
        used += entries[i - 1]!.text.length + 2;
        i--;
      }
      // The newest message is shown even when it alone is over budget (it's cut to MAX_MESSAGE_CHARS already).
      return Math.min(i, Math.max(0, entries.length - 1));
    };
    const anchor = this.anchors.get(agentName);
    if (anchor && anchor.keys.length > 0) {
      const at = this.findAnchor(entries, anchor.keys);
      if (at !== undefined) {
        let size = 0;
        for (let i = at; i < entries.length; i++) size += entries[i]!.text.length + 2;
        if (size <= windowChars) return at;
      }
    }
    return tailFrom(Math.floor(windowChars * FRESH_WINDOW_SHARE));
  }

  private findAnchor(entries: Entry[], keys: string[]): number | undefined {
    for (let i = 0; i + keys.length <= entries.length; i++) {
      let all = true;
      for (let k = 0; k < keys.length; k++) {
        if (entries[i + k]!.key !== keys[k]) { all = false; break; }
      }
      if (all) return i;
    }
    return undefined;
  }

  /** Learn the tokenizer's ratio from one response, leaning conservative after an overshoot. */
  private calibrate(chars: number, inputTokens: number): void {
    if (!(inputTokens > 0) || !(chars > 0)) return;
    const measured = chars / inputTokens;
    const weight = measured < this.charsPerToken ? CALIBRATION_WEIGHT_DENSER : CALIBRATION_WEIGHT_SPARSER;
    const next = this.charsPerToken * (1 - weight) + measured * weight;
    // Over budget: take the measured ratio at once, with a margin, rather than drift toward it.
    this.charsPerToken = inputTokens > this.maxInputTokens ? Math.min(next, measured * 0.9) : next;
    this.charsPerToken = Math.min(6, Math.max(1, this.charsPerToken));
  }

  private ask(built: { agentName: string; request: NormalizedRequest }, signal: AbortSignal): Promise<NormalizedResponse> {
    // The native formatter whatever the host's agents use: an XML or
    // completions formatter would end the judge's request in a prefill, which
    // current Claude models refuse. (A membrane whose own formatter is OpenAI
    // Responses', on that adapter outside its subscription mode, keeps it
    // whatever a request asks: membrane's resolveActiveFormatter.)
    return this.membraneFor(built.agentName).complete(built.request, {
      signal,
      formatter: new NativeFormatter(),
    }) as Promise<NormalizedResponse>;
  }

  private async decide(request: JudgeRequest): Promise<JudgeVerdict> {
    let built = await this.buildRequest(request);
    let response: NormalizedResponse;
    try {
      response = await this.ask(built, request.signal);
    } catch (err) {
      if ((err as { type?: unknown } | null)?.type !== 'context_length' || this.charsPerToken <= 1) throw err;
      const was = this.charsPerToken;
      this.charsPerToken = Math.max(1, was / 2);
      console.error(
        `[gate] the reply judge's request of ${built.chars} characters was refused as too long; its estimate goes from `
        + `${was.toFixed(2)} to ${this.charsPerToken.toFixed(2)} characters a token, and the batch is asked once more`,
      );
      built = await this.buildRequest(request);
      response = await this.ask(built, request.signal);
    }
    const usage = (response as NormalizedResponse).details?.usage;
    if (usage) this.recordUsage?.(built.agentName, usage);
    const inputTokens = (response.usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheCreationTokens ?? 0);
    this.calibrate(built.chars, inputTokens);
    if (inputTokens > this.maxInputTokens) {
      console.error(
        `[gate] the reply judge's request carried ${inputTokens} input tokens, over its ${this.maxInputTokens} budget; `
        + `its estimate is now ${this.charsPerToken.toFixed(2)} characters a token`,
      );
    }
    const text = response.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const verdict = parseVerdict(text);
    if (!verdict) {
      const stop = response.stopReason;
      throw new Error(`the judge's answer held no verdict (stop: ${stop}${text ? `, text: ${JSON.stringify(cut(text, 120))}` : ''})`);
    }
    return {
      ...verdict,
      model: response.details?.model?.actual || this.model,
      inputTokens,
      ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      outputTokens: response.usage?.outputTokens,
    };
  }
}
