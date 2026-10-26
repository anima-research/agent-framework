/**
 * ReplyJudge — the small model a `judge` wake rule asks whether now is a good
 * time for the agent to reply (JudgeConfig).
 *
 * Per batch it takes the request the agent WOULD send if woken now (the
 * framework's previewActivation, a dry run that commits nothing), renders it
 * as one plain-text document (the newest of the agent's conversation, oldest
 * first, then its system prompt, abridged), and asks the model, with the
 * agent's own instructions and the batch, for one line: `REPLY: <reason>` or
 * `WAIT: <reason>`. The conversation shown, the system prompt and the batch's
 * listing each have a fixed size in characters, a few thousand tokens in all;
 * the newest message and the newest event are shown even past it.
 *
 * The judge reads; it never writes into the agent's context and never speaks.
 */

import { NativeFormatter } from '@animalabs/membrane';
import type { ContentBlock, DetailedUsage, Membrane, NormalizedMessage, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import type { JudgeEventSummary, JudgeFn, JudgeRequest, JudgeVerdict, ReplyJudgeOptions } from './types.js';

/** The judge's model when the host names none. */
export const DEFAULT_JUDGE_MODEL = 'claude-haiku-5-5';
const CONVERSATION_CHARS = 6_700;
const SYSTEM_CHARS = 850;
const EVENTS_CHARS = 2_160;
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
  /** The request the agent would send if woken now, as a dry run (previewActivation). */
  preview: (agentName: string) => Promise<NormalizedRequest>;
  /** Count a judge request's usage as the agent's, where its turns' usage is counted. */
  recordUsage?: (agentName: string, usage: DetailedUsage) => void;
}

/** A message as the document shows it: its participant, and each block as text. Thinking is the agent's own, and isn't shown. */
export function renderMessage(message: NormalizedMessage): string {
  const parts: string[] = [];
  for (const block of message.content as ContentBlock[]) {
    const line = renderBlock(block);
    if (line) parts.push(line);
  }
  if (parts.length === 0) return '';
  return cut(`[${message.participant}] ${parts.join('\n')}`, MAX_MESSAGE_CHARS);
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

/** The text of a system prompt, as membrane's request may hold it. */
function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  }
  return '';
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

/** The judge's own system prompt, the same for every request about one agent. */
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
    "Don't answer the messages yourself and don't speak as the agent. Answer with exactly one line:",
    '"REPLY: <a short reason>" to wake it, or "WAIT: <a short reason>" to let the events go by.',
  ].join('\n');
}

/**
 * The closing message: the batch, the agent's instructions, the question.
 * A server may not mark its mentions (`chat:addressed`); its mentions then
 * reach the judge, and the line's second sentence covers them.
 */
export function judgeQuestion(
  request: Pick<JudgeRequest, 'events' | 'instructions'>, agentName: string, now: number, maxEventChars = Infinity,
): string {
  // Newest first into the listing's share, shown oldest first; the rest are
  // counted, so a long held batch can't crowd out the context.
  const lines: string[] = [];
  let used = 0;
  let i = request.events.length;
  while (i > 0) {
    const e: JudgeEventSummary = request.events[i - 1]!;
    const where = e.channel ? ` in ${e.channel}` : '';
    const who = e.authorId ? ` from ${e.authorId}` : '';
    const addressed = e.addressed ? ' (addresses the agent)' : '';
    const line = `- ${ago(e.at, now)}${where}${who}${addressed}: ${e.content}`;
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
    ...(request.events.some((e) => e.addressed) ? [] : [
      '',
      `None of these events is a mention, a reply or a DM to ${agentName}: those wake it without asking you. `
        + 'A message can still ask it something by name.',
    ]),
  ];
  if (request.instructions && request.instructions.trim()) {
    parts.push('', `<instructions_from_${agentName.replace(/[^A-Za-z0-9_-]/g, '_')}>`, request.instructions.trim(), '</instructions_from_' + agentName.replace(/[^A-Za-z0-9_-]/g, '_') + '>');
  }
  parts.push('', `Should ${agentName} be woken now to respond? One line: "REPLY: <reason>" or "WAIT: <reason>".`);
  return parts.join('\n');
}

export class ReplyJudge {
  private readonly membraneFor: ReplyJudgeDeps['membraneFor'];
  private readonly model: string;
  private readonly effort: 'low' | 'medium' | 'high' | 'none';
  private readonly chooseAgent: ReplyJudgeDeps['chooseAgent'];
  private readonly preview: ReplyJudgeDeps['preview'];
  private readonly recordUsage: ReplyJudgeDeps['recordUsage'];

  constructor(deps: ReplyJudgeDeps) {
    this.membraneFor = deps.membraneFor;
    this.model = deps.options?.model || DEFAULT_JUDGE_MODEL;
    this.effort = deps.options?.effort ?? 'low';
    this.chooseAgent = deps.chooseAgent;
    this.preview = deps.preview;
    this.recordUsage = deps.recordUsage;
  }

  /** The gate's judge function. */
  readonly judge: JudgeFn = async (request) => this.decide(request);

  /** Build the judge's request for one batch: the system prompt, the newest of the conversation, the agent's system prompt, the question. */
  async buildRequest(request: JudgeRequest, now = Date.now()): Promise<{ request: NormalizedRequest; agentName: string }> {
    const agentName = this.chooseAgent(request.agentNames);
    if (!agentName) throw new Error('no agent to judge for');
    const preview = await this.preview(agentName);
    if (request.signal.aborted) throw new Error('the judge was stopped before its request');

    const system = judgeSystemPrompt(agentName);
    const question = judgeQuestion(request, agentName, now, EVENTS_CHARS);
    const agentSystem = systemText(preview.system);
    const about = [
      `## ${agentName}'s system prompt${agentSystem.length > SYSTEM_CHARS ? ' (abridged)' : ''}`,
      '',
      agentSystem ? cut(agentSystem, SYSTEM_CHARS) : '(none)',
    ].join('\n');

    const rendered = preview.messages.map(renderMessage).filter((text) => text.length > 0);
    let start = rendered.length;
    let used = 0;
    while (start > 0 && used + rendered[start - 1]!.length + 2 <= CONVERSATION_CHARS) {
      used += rendered[start - 1]!.length + 2;
      start--;
    }
    // The newest message is shown even when it alone is over the size (it's cut to MAX_MESSAGE_CHARS already).
    start = Math.min(start, Math.max(0, rendered.length - 1));
    const header = `# ${agentName}'s context\n\n## Conversation (oldest shown first)`;
    const document = (start > 0 ? `${header}\n[…earlier messages not shown…]\n\n` : `${header}\n\n`)
      + rendered.slice(start).map((text) => `${text}\n\n`).join('');

    return {
      agentName,
      request: {
        system,
        messages: [document, about, question].map((text): NormalizedMessage => ({ participant: 'user', content: [{ type: 'text', text }] })),
        config: { model: this.model, maxTokens: VERDICT_MAX_TOKENS },
        assistantParticipant: JUDGE_PARTICIPANT,
        promptCaching: false,
        ...(this.effort !== 'none' ? { providerParams: { output_config: { effort: this.effort } } } : {}),
      },
    };
  }

  private async decide(request: JudgeRequest): Promise<JudgeVerdict> {
    const built = await this.buildRequest(request);
    // The native formatter whatever the host's agents use: an XML or
    // completions formatter would end the judge's request in a prefill, which
    // current Claude models refuse.
    const response = await this.membraneFor(built.agentName).complete(built.request, {
      signal: request.signal,
      formatter: new NativeFormatter(),
    });
    const usage = (response as NormalizedResponse).details?.usage;
    if (usage) this.recordUsage?.(built.agentName, usage);
    const inputTokens = (response.usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheCreationTokens ?? 0);
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
