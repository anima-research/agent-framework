/**
 * The periodic review of what suppress rules hid (SuppressionReviewOptions).
 *
 * A suppress rule is the agent's own filter on its attention, and a filter
 * written a little too wide hides what the agent would have wanted to see,
 * with nothing in its context to show that it did. So every `intervalMs`
 * (two hours by default), for each rule that hid events since the last
 * review, a small model (Claude Haiku 5.5 by default) reads the rule's
 * description, its match and the events it hid (a sample spread across the
 * period, past `maxEventsPerRule`), and flags any that don't fit the
 * description or that the agent would plausibly need to see. The agent is
 * told, in a `[suppression review]` notice, what each rule hid and what was
 * flagged, with the flagged events shown; a flagged event wakes it.
 *
 * What was reviewed is kept in a small file beside gate.json
 * (`suppression-review.json`), written as the review starts and after each
 * review: the time reviewed through, so a restart picks up where the last
 * review stopped; for a rule the reviewer couldn't answer about, where its
 * events still to be reviewed begin, so the next review takes them again; and
 * each rule's description as last seen (the framework tells the review when a
 * rule hides a row), so the events a rule hid before it was removed are still
 * judged against it. The review reads a sample of each rule's events, each
 * cut short, not every event whole.
 * The reviewer reads; it never decides what's suppressed and never edits a
 * rule. The notice is the framework's own and is never suppressed.
 */
import { NativeFormatter } from '@animalabs/membrane';
import type { ContentBlock, DetailedUsage, Membrane, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NOTICE_TAG } from '../notice-tags.js';
import type { SuppressedEventRecord } from './suppression-stats.js';
import type { SuppressionReviewOptions } from './types.js';
import type { TraceEventInput } from '../types/trace.js';

export const DEFAULT_REVIEW_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const MIN_REVIEW_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_REVIEW_MODEL = 'claude-haiku-5-5';
export const DEFAULT_REVIEW_MAX_EVENTS = 60;
const MAX_REVIEW_EVENTS = 200;
const DEFAULT_REVIEW_TIMEOUT_MS = 60_000;
/** How long after a start the first review may run, at the soonest: the host settles first. */
const FIRST_REVIEW_DELAY_MS = 60_000;
/** Characters of each event's text the reviewer reads. */
const EVENT_TEXT_CHARS = 400;
/** Characters of a rule's script the reviewer reads. */
const SCRIPT_CHARS = 3_000;
/** Characters of a flagged event's text the notice shows. */
const NOTICE_EVENT_CHARS = 200;
/** Flagged events the notice shows per rule; the rest are counted. */
const NOTICE_FLAGGED_SHOWN = 5;
/** Output tokens a verdict may take, adaptive thinking included. */
const VERDICT_MAX_TOKENS = 4_096;
const REVIEW_PARTICIPANT = 'suppression-review';

/** A suppress rule as the review knows it. */
export interface ReviewRuleInfo {
  name: string;
  description: string;
  match?: unknown;
  /** The rule's script, which decides which matching events it hides. */
  script?: string;
}

/** One rule's review. */
export interface RuleReview {
  rule: string;
  /** The description judged against: the rule's own, or its last known one for a removed rule. */
  description?: string;
  /** Whether gate.json has the rule now. */
  inForce: boolean;
  /** Events it hid in the period. */
  suppressed: number;
  /** Of those, how many the reviewer read. */
  read: number;
  /** `fits`: nothing flagged; `flagged`: some events flagged; `error`: the reviewer couldn't answer; `unjudged`: no description to judge against. */
  verdict: 'fits' | 'flagged' | 'error' | 'unjudged';
  flagged: SuppressedEventRecord[];
  /** The reviewer's one-line note, or what went wrong. */
  note?: string;
}

export interface SuppressionReviewSummary {
  fromMs: number;
  toMs: number;
  rules: RuleReview[];
  total: number;
  flagged: number;
}

export interface SuppressionReviewDeps {
  /** The agent whose message slot is reviewed and who is told: the primary resident. */
  agentName(): string | undefined;
  /** The membrane the reviewer calls for that agent (the framework's judge membrane). */
  membraneFor(agentName: string): Membrane;
  /** The suppressed rows stored in the agent's slot, at or after `sinceMs` and before `untilMs`, oldest first. */
  records(agentName: string, sinceMs: number, untilMs: number): SuppressedEventRecord[];
  /** The suppress rules in force. */
  rules(): ReviewRuleInfo[];
  /** Tell the agent: store the notice, and wake it when `wake`. Throws when the notice can't be written. */
  deliver(agentName: string, text: string, wake: boolean, summary: SuppressionReviewSummary): void;
  recordUsage?(agentName: string, usage: DetailedUsage): void;
  emitTrace?(event: TraceEventInput): void;
  /** Where the review keeps what it reviewed through; left out, nothing is kept and a restart starts afresh. */
  statePath?: string;
  /** Whether a review may run now (not while the host is quiesced or stopping); a review not run waits for the next. */
  mayRun?(): boolean;
  /** Whether the agent has dump_suppressed (a workspace), for the notice to point at it. */
  dumpAvailable?(): boolean;
  now?(): number;
}

interface ReviewState {
  version: 1;
  reviewedThrough: number;
  /** Rules the reviewer couldn't answer about: where their events still to be reviewed begin (ms). */
  retryFrom: Map<string, number>;
  descriptions: Map<string, string>;
}

const entriesOf = (value: unknown): Array<[string, unknown]> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];

/** The review state a file holds, or null when there's none; one that can't be used is named in the log and read as none. */
function readState(path: string): ReviewState | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    if (raw?.version !== 1 || typeof raw.reviewedThrough !== 'number' || !Number.isFinite(raw.reviewedThrough)) {
      throw new Error('it holds no version 1 state with a reviewedThrough time');
    }
    const descriptions = new Map<string, string>();
    for (const [name, text] of entriesOf(raw.descriptions)) if (typeof text === 'string') descriptions.set(name, text);
    const retryFrom = new Map<string, number>();
    for (const [name, ms] of entriesOf(raw.retryFrom)) if (typeof ms === 'number' && Number.isFinite(ms)) retryFrom.set(name, ms);
    return { version: 1, reviewedThrough: raw.reviewedThrough, retryFrom, descriptions };
  } catch (error) {
    console.error(`[gate] the suppression review's progress in ${path} can't be read, so it reviews from now on:`, error);
    return null;
  }
}

/** The options as the review runs them: each at its default or within its bounds. */
export function reviewSettings(options: SuppressionReviewOptions = {}) {
  const interval = typeof options.intervalMs === 'number' && Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_REVIEW_INTERVAL_MS;
  const maxEvents = typeof options.maxEventsPerRule === 'number' && Number.isFinite(options.maxEventsPerRule)
    ? Math.round(options.maxEventsPerRule) : DEFAULT_REVIEW_MAX_EVENTS;
  return {
    intervalMs: Math.min(MAX_REVIEW_INTERVAL_MS, Math.max(MIN_REVIEW_INTERVAL_MS, interval)),
    model: options.model || DEFAULT_REVIEW_MODEL,
    notify: options.notify === 'flagged' ? 'flagged' as const : 'always' as const,
    wakeOnFlag: options.wakeOnFlag !== false,
    maxEventsPerRule: Math.min(MAX_REVIEW_EVENTS, Math.max(1, maxEvents)),
    timeoutMs: typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_REVIEW_TIMEOUT_MS,
    effort: options.effort ?? 'low',
  };
}

/** `max` of `items`, spread evenly from the first to the last; all of them when there are no more. */
export function spread<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  if (max === 1) return [items[items.length - 1]!];
  return Array.from({ length: max }, (_, k) => items[Math.round((k * (items.length - 1)) / (max - 1))]!);
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

const REVIEW_SYSTEM = [
  'You review a filter an AI agent set on its own attention. The agent wrote a rule that hides some incoming events',
  'from its context, and described in its own words what the rule is for. You are shown that description, the',
  "rule's match criteria, and events the rule hid, numbered.",
  '',
  'Flag an event when it falls outside what the description says the rule is for. Also flag one the agent would',
  'plausibly need to see whatever the description says: something said to the agent by name or asking it something,',
  "a warning, an error about the agent's own actions, or a person in distress or danger. Don't flag an event only",
  'because it is interesting, or because the rule hides many events.',
  '',
  'Answer with one JSON object and nothing else:',
  '{"fits": <true when you flag nothing>, "flagged": [<the numbers of the flagged events>], "note": "<one short sentence>"}',
].join('\n');

/** The reviewer's request for one rule's events. */
export function reviewRequest(
  rule: { name: string; description: string; match?: unknown; script?: string },
  events: readonly SuppressedEventRecord[],
  hidden: number,
  period: { fromMs: number; toMs: number },
  settings: ReturnType<typeof reviewSettings>,
): NormalizedRequest {
  const script = rule.script !== undefined
    ? `Of the events it matches, it hides those this script of the agent's returns true for (state is the rule's own memory between events):\n${cut(rule.script, SCRIPT_CHARS)}\n`
    : '';
  const listing = events.map((e, i) =>
    `#${i + 1} [${e.at}] ${e.eventType}${e.source ? ` · ${e.source}` : ''}${e.channel ? ` · ${e.channel}` : ''}${e.author ? ` · ${e.author}` : ''}: ${cut(oneLine(e.text), EVENT_TEXT_CHARS)}`,
  ).join('\n');
  const text = [
    `The agent's rule ${JSON.stringify(rule.name)} hides events from its context. The agent described it as:`,
    JSON.stringify(rule.description),
    rule.match !== undefined ? `The rule matches: ${JSON.stringify(rule.match)}` : '',
    script,
    `From ${new Date(period.fromMs).toISOString()} to ${new Date(period.toMs).toISOString()} it hid ${hidden} event${hidden === 1 ? '' : 's'}. `
      + (events.length < hidden ? `Here are ${events.length} of them, spread across that time:` : 'Here they are:'),
    '',
    listing,
    '',
    'Which of these, if any, should the agent have seen? Answer with the JSON object.',
  ].filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== '')).join('\n');
  return {
    system: REVIEW_SYSTEM,
    messages: [{ participant: 'user', content: [{ type: 'text', text }] }],
    config: { model: settings.model, maxTokens: VERDICT_MAX_TOKENS },
    assistantParticipant: REVIEW_PARTICIPANT,
    ...(settings.effort !== 'none' ? { providerParams: { output_config: { effort: settings.effort } } } : {}),
  } as NormalizedRequest;
}

/** The reviewer's answer read from its text, or undefined when it holds none this can use. */
export function parseReviewAnswer(text: string, count: number): { flagged: number[]; note: string } | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
  if (!raw || typeof raw !== 'object') return undefined;
  const { fits, flagged, note } = raw as { fits?: unknown; flagged?: unknown; note?: unknown };
  if (flagged !== undefined && !Array.isArray(flagged)) return undefined;
  const named = flagged ?? [];
  const numbers = [...new Set(named.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= count))].sort((a, b) => a - b);
  if (typeof fits !== 'boolean' && flagged === undefined) return undefined;
  // An answer that says they don't all fit, or names events, but names none
  // it was shown can't be taken as "they fit": it's no answer.
  if (numbers.length === 0 && (fits === false || named.length > 0)) return undefined;
  return { flagged: numbers, note: typeof note === 'string' ? cut(oneLine(note), 300) : '' };
}

const clockOf = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** How long a span is, in the words the notice uses. */
function spanOf(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** The `[suppression review]` notice the agent is told; `dump` when it has dump_suppressed to point at. */
export function reviewNoticeText(summary: SuppressionReviewSummary, opts: { dump?: boolean } = {}): string {
  const lines = [
    `[${NOTICE_TAG.suppressionReview}] Since ${clockOf(summary.fromMs)} (${spanOf(summary.toMs - summary.fromMs)}), `
      + `your suppress rules hid ${summary.total} event${summary.total === 1 ? '' : 's'}`
      + (summary.flagged > 0 ? `, and the reviewer flagged ${summary.flagged} that may not fit their rule:` : '.'),
  ];
  for (const r of summary.rules) {
    const named = `"${r.rule}"${r.description ? ` (${r.description})` : ''}${r.inForce ? '' : ', since removed,'}`;
    const read = r.read < r.suppressed ? `read ${r.read} of them` : 'read them';
    let said: string;
    if (r.verdict === 'fits') said = `The reviewer ${read} and found they fit.`;
    else if (r.verdict === 'flagged') said = `The reviewer ${read} and flagged ${r.flagged.length}${r.note ? `: ${r.note}` : '.'}`;
    else if (r.verdict === 'unjudged') said = 'There was no description to judge them against.';
    else said = "The reviewer couldn't answer this time; they'll be reviewed again next time.";
    lines.push(`- ${named} hid ${r.suppressed}. ${said}`);
    // The flagged events, each cut short: the first few, and how many more.
    for (const e of r.flagged.slice(0, NOTICE_FLAGGED_SHOWN)) {
      lines.push(`  · [${e.at}]${e.source ? ` ${e.source}` : ''}${e.author ? ` · ${e.author}` : ''}: ${JSON.stringify(cut(oneLine(e.text), NOTICE_EVENT_CHARS))} (id ${e.id})`);
    }
    if (r.flagged.length > NOTICE_FLAGGED_SHOWN) lines.push(`  · and ${r.flagged.length - NOTICE_FLAGGED_SHOWN} more`);
  }
  lines.push(`${opts.dump === false ? 'suppression_stats shows' : 'suppression_stats and dump_suppressed show'} what a rule hid; wake_add_rule edits a rule, and wake_remove_rule removes one.`);
  return lines.join('\n');
}

export class SuppressionReview {
  private readonly settings: ReturnType<typeof reviewSettings>;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<SuppressionReviewSummary | null> | null = null;
  private stopped = false;
  private readonly inFlight = new Set<AbortController>();
  private reviewedThrough: number;
  private readonly retryFrom: Map<string, number>;
  private readonly descriptions: Map<string, string>;

  constructor(private readonly deps: SuppressionReviewDeps, options: SuppressionReviewOptions = {}) {
    this.settings = reviewSettings(options);
    this.now = deps.now ?? Date.now;
    const state = deps.statePath ? readState(deps.statePath) : null;
    this.reviewedThrough = state?.reviewedThrough ?? this.now();
    this.retryFrom = state?.retryFrom ?? new Map();
    this.descriptions = state?.descriptions ?? new Map();
    // Where the review starts is kept at once, so a restart before the first
    // review still reviews from here.
    if (!state) this.saveState();
  }

  /** A rule's description as it stands when it hides a row: the one its rows are judged against later, though the rule be gone by then. */
  noteRule(name: string, description: string): void {
    if (this.descriptions.get(name) === description) return;
    this.descriptions.set(name, description);
  }

  get intervalMs(): number { return this.settings.intervalMs; }
  get nextReviewAfter(): number { return this.reviewedThrough + this.settings.intervalMs; }

  /** Schedule reviews: the first when the interval since the last review is up, and no sooner than a minute from now. */
  start(): void {
    if (this.stopped || this.timer) return;
    this.schedule(Math.max(FIRST_REVIEW_DELAY_MS, this.nextReviewAfter - this.now()));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.inFlight) controller.abort();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .catch((error) => console.error('[gate] the suppression review failed:', error))
        .finally(() => this.schedule(this.settings.intervalMs));
    }, Math.min(delayMs, 2_147_483_647));
    this.timer.unref?.();
  }

  /**
   * Review what was hidden since the last review, tell the agent, and record
   * how far it reviewed. Null when no review ran: one is already running, no
   * agent is registered, or the host isn't taking one now (mayRun). A review
   * whose notice couldn't be written throws, and the next review covers its
   * period again.
   */
  runOnce(): Promise<SuppressionReviewSummary | null> {
    if (this.running) return this.running;
    this.running = this.review().finally(() => { this.running = null; });
    return this.running;
  }

  private async review(): Promise<SuppressionReviewSummary | null> {
    const agentName = this.deps.agentName();
    if (!agentName || this.stopped || (this.deps.mayRun && !this.deps.mayRun())) return null;
    const fromMs = this.reviewedThrough;
    const toMs = this.now();
    const inForce = new Map(this.deps.rules().map((r) => [r.name, r]));
    for (const rule of inForce.values()) this.descriptions.set(rule.name, rule.description);
    // A rule the reviewer couldn't answer about last time is reviewed from
    // where its unreviewed events begin.
    const fromOf = (name: string): number => Math.min(this.retryFrom.get(name) ?? fromMs, fromMs);
    const earliest = Math.min(fromMs, ...this.retryFrom.values());

    const byRule = new Map<string, SuppressedEventRecord[]>();
    for (const record of this.deps.records(agentName, earliest, toMs)) {
      if (Date.parse(record.at) < fromOf(record.rule)) continue;
      const list = byRule.get(record.rule) ?? [];
      list.push(record);
      byRule.set(record.rule, list);
    }
    const rules: RuleReview[] = [];
    for (const [name, records] of byRule) {
      if (this.stopped) return null;
      const rule = inForce.get(name);
      const description = rule?.description ?? this.descriptions.get(name);
      const base = { rule: name, ...(description ? { description } : {}), inForce: rule !== undefined, suppressed: records.length };
      if (!description) {
        rules.push({ ...base, read: 0, verdict: 'unjudged', flagged: [] });
        continue;
      }
      const sample = spread(records, this.settings.maxEventsPerRule);
      rules.push(await this.judge(agentName, { name, description, ...(rule ?? {}) }, sample, records.length, { fromMs: fromOf(name), toMs }, base));
    }
    const summary: SuppressionReviewSummary = {
      fromMs, toMs, rules,
      total: rules.reduce((n, r) => n + r.suppressed, 0),
      flagged: rules.reduce((n, r) => n + r.flagged.length, 0),
    };
    // Stopped while the reviewer was asked: nothing is told and nothing
    // recorded, so a later start reviews this period again.
    if (this.stopped) return null;
    const tell = summary.total > 0 && (this.settings.notify === 'always' || summary.flagged > 0);
    if (tell) {
      this.deps.deliver(agentName, reviewNoticeText(summary, { dump: this.deps.dumpAvailable?.() ?? true }), summary.flagged > 0 && this.settings.wakeOnFlag, summary);
    }
    this.deps.emitTrace?.({
      type: 'gate:suppression-review',
      agentName, fromMs: earliest, toMs, total: summary.total, flagged: summary.flagged, delivered: tell,
      rules: rules.map((r) => ({ rule: r.rule, suppressed: r.suppressed, read: r.read, verdict: r.verdict, flagged: r.flagged.length })),
    });
    for (const r of rules) {
      if (r.verdict === 'flagged' || r.verdict === 'error') {
        console.error(`[gate] suppression review: "${r.rule}" hid ${r.suppressed}, ${r.verdict}${r.verdict === 'flagged' ? ` ${r.flagged.length}` : ''}${r.note ? `: ${r.note}` : ''}`);
      }
    }
    this.reviewedThrough = toMs;
    // The rules the reviewer couldn't answer about keep where their events
    // begin; every other rule is reviewed through now.
    for (const r of rules) {
      // Kept for at most a week of events, so a reviewer that keeps failing doesn't read back without end.
      if (r.verdict === 'error') this.retryFrom.set(r.rule, Math.max(fromOf(r.rule), toMs - MAX_REVIEW_INTERVAL_MS));
      else this.retryFrom.delete(r.rule);
    }
    // Descriptions are kept for the rules in force and the ones with events
    // still to review; the rest have nothing left to be judged.
    for (const name of [...this.descriptions.keys()]) {
      if (!inForce.has(name) && !this.retryFrom.has(name)) this.descriptions.delete(name);
    }
    this.saveState();
    return summary;
  }

  private async judge(
    agentName: string,
    rule: ReviewRuleInfo,
    sample: SuppressedEventRecord[],
    hidden: number,
    period: { fromMs: number; toMs: number },
    base: Pick<RuleReview, 'rule' | 'description' | 'inForce' | 'suppressed'>,
  ): Promise<RuleReview> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    timer.unref?.();
    try {
      const request = reviewRequest(rule, sample, hidden, period, this.settings);
      const response = await this.deps.membraneFor(agentName).complete(request, { signal: controller.signal, formatter: new NativeFormatter() });
      const usage = (response as NormalizedResponse).details?.usage;
      if (usage) this.deps.recordUsage?.(agentName, usage);
      const text = response.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const answer = parseReviewAnswer(text, sample.length);
      if (!answer) {
        return { ...base, read: sample.length, verdict: 'error', flagged: [], note: `its answer held no verdict (stop: ${response.stopReason})` };
      }
      const flagged = answer.flagged.map((n) => sample[n - 1]!);
      return {
        ...base, read: sample.length, verdict: flagged.length > 0 ? 'flagged' : 'fits', flagged,
        ...(answer.note ? { note: answer.note } : {}),
      };
    } catch (error) {
      const message = controller.signal.aborted && !this.stopped
        ? `no answer within ${Math.round(this.settings.timeoutMs / 1000)} s`
        : cut(oneLine(error instanceof Error ? error.message : String(error)), 160);
      return { ...base, read: 0, verdict: 'error', flagged: [], note: message };
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }

  private saveState(): void {
    const path = this.deps.statePath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      const state = {
        version: 1, reviewedThrough: this.reviewedThrough,
        retryFrom: Object.fromEntries(this.retryFrom), descriptions: Object.fromEntries(this.descriptions),
      };
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(temp, path);
    } catch (error) {
      console.error(`[gate] the suppression review couldn't record its progress in ${path}, so a restart reviews from its start time:`, error);
    }
  }
}
