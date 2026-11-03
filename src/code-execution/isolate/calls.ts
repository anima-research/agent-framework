/**
 * A script's call record, kept in the parent, outside the child, so losing
 * the child loses none of it. A call goes in at
 * dispatch, as running until it's answered. Answered calls are counted; those
 * whose answer the script didn't see are named, with their arguments, so an
 * agent can tell which effects may have taken place. A script can live a day,
 * so the record is bounded: it names at most CALLS_NAMED and counts the rest
 * by tool, and it holds a counted call only while it runs. A named call stays
 * until the script ends, and its state can still change after the call ends,
 * as when a timed-out call's answer comes.
 */

/** A call's arguments, or a later answer's start, as a return names it: at most this many characters. */
export const CALL_BRIEF_CHARS = 120;
/** How many calls whose answer the script didn't see a return names; it counts the rest by tool. */
export const CALLS_NAMED = 10;

/** How a return names a tool, as the agent writes it in a script. */
export const toolRef = (tool: string): string => (tool === 'wake_agent' ? 'wake_agent()' : `tools[${JSON.stringify(tool)}]`);

/**
 * A copy of `text` that shares no storage with it. A slice of a string can
 * keep the whole string it was cut from alive, in V8 and in JavaScriptCore, so
 * a short piece kept from a long text is copied first.
 */
export function fresh(text: string): string {
  return JSON.parse(JSON.stringify(text)) as string;
}

/** `text` cut to CALL_BRIEF_CHARS with "…", never between a surrogate pair's halves, as a copy of its own. */
export function callBrief(text: string): string {
  if (text.length <= CALL_BRIEF_CHARS) return fresh(text);
  let cut = CALL_BRIEF_CHARS - 1;
  const before = text.charCodeAt(cut - 1);
  if (before >= 0xd800 && before <= 0xdbff) cut -= 1;
  return fresh(`${text.slice(0, cut)}…`);
}

/** A call whose answer the script didn't see, as a return names it. */
export interface NamedCall {
  tool: string;
  /** Its arguments as the script sent them, cut to CALL_BRIEF_CHARS. */
  args: string;
  /**
   * - `uncertain`: still running when the script ended, so it may or may not take effect.
   * - `timed-out`: no answer came within the call's timeout, so it may still take effect. The script was given a TimeoutError, unless it ended before reading it.
   * - `timed-out-answered`: no answer came within the call's timeout, and one came later; `answer` is its start.
   * - `too-large`: answered, with a result the script couldn't receive (too large for its memory, or nested too deep), so it got ResultTooLarge in its place.
   * - `unseen`: answered, and the script was stopped or crashed before it read the answer.
   */
  state: 'uncertain' | 'timed-out' | 'timed-out-answered' | 'too-large' | 'unseen';
  /** For `timed-out-answered`: the answer's start, cut to CALL_BRIEF_CHARS. */
  answer?: string;
}

/** The record as a return reports it. */
export interface CallSummary {
  /** Calls the script made. */
  made: number;
  /** Answered while the script waited, with a result that wasn't an error. */
  answered: number;
  /** Answered while the script waited, with a result marked as an error. */
  failed: number;
  /** Refused before they ran: nothing was done. */
  refused: number;
  /** Never sent, so nothing was done: they timed out while they waited for room in the host, the run ended while they waited, or the host read them once the script's process had exited. */
  unsent: number;
  /** Still in flight, the script waiting on them. */
  running: number;
  /** Waiting their turn in the host, not sent yet: calls waiting for room, and wakes waiting for theirs. */
  waiting: number;
  /** Those whose answer the script didn't see, the first CALLS_NAMED of them, in the order each became so. */
  named: NamedCall[];
  /** The rest of those, counted by tool. */
  more: Record<string, number>;
}

/** How a call that the script waited on was answered. */
export type CallOutcome = 'answered' | 'failed' | 'refused' | 'too-large';

/** One call the record still follows, held by the caller between its start and its end. */
export interface CallEntry {
  readonly tool: string;
  readonly args: string;
  /** Set once the call has a place among the named, so a later answer can say what it was. */
  named: NamedCall | null;
  /** True once the call's timeout passed with no answer: the script is given a TimeoutError, unless it ended before reading it. */
  timedOut: boolean;
  /** True once the record holds the call's last word. */
  done: boolean;
}

export class CallLog {
  private made = 0;
  private readonly counts = { answered: 0, failed: 0, refused: 0, unsent: 0 };
  private readonly running = new Set<CallEntry>();
  /** Timed-out calls among the named whose answer hasn't come: it can still be named, until the script ends. */
  private readonly awaiting = new Set<CallEntry>();
  private readonly named: NamedCall[] = [];
  private readonly more = new Map<string, number>();

  /** A call went out: it's running until it's answered. */
  start(tool: string, argsJson: string): CallEntry {
    this.made += 1;
    const entry: CallEntry = { tool, args: callBrief(argsJson), named: null, timedOut: false, done: false };
    this.running.add(entry);
    return entry;
  }

  /**
   * A call or wake the script made was never sent, so nothing was done: a
   * call that timed out while it waited for room in the host, or that the run
   * ended, or its process exited, before it went out, and one read after the
   * process exited; a wake still waiting for its turn when the run ended, or
   * once a stop was asked or the process exited.
   */
  unsent(): void {
    this.made += 1;
    this.counts.unsent += 1;
  }

  /** The call's timeout passed with no answer, and the script is given a TimeoutError. Its answer may still come. */
  timedOut(entry: CallEntry): void {
    if (entry.done || entry.timedOut) return;
    entry.timedOut = true;
    this.running.delete(entry);
    entry.named = this.name(entry, 'timed-out');
    if (entry.named) this.awaiting.add(entry);
    else entry.done = true;
  }

  /** The call's answer came. `brief` is the start of what the tool answered, for a call the script stopped waiting for. */
  answered(entry: CallEntry, outcome: CallOutcome, brief: string): void {
    if (entry.done) return;
    entry.done = true;
    this.running.delete(entry);
    this.awaiting.delete(entry);
    if (entry.timedOut) {
      if (entry.named) {
        entry.named.state = 'timed-out-answered';
        entry.named.answer = callBrief(brief);
      }
      return;
    }
    if (outcome === 'too-large') this.name(entry, 'too-large');
    else this.counts[outcome] += 1;
  }

  /**
   * The call was answered, and the script ended before it read the answer: a
   * refusal did nothing, and is counted; any other answer is named.
   */
  unseen(entry: CallEntry, outcome: CallOutcome): void {
    if (entry.done) return;
    entry.done = true;
    this.running.delete(entry);
    this.awaiting.delete(entry);
    if (outcome === 'refused') this.counts.refused += 1;
    else this.name(entry, 'unseen');
  }

  /**
   * The script ended: every call still running may or may not take effect,
   * and the record stays as it stands, so it names the calls as the host saw
   * them when the script ended.
   */
  ended(): void {
    for (const entry of this.running) {
      entry.done = true;
      this.name(entry, 'uncertain');
    }
    this.running.clear();
    for (const entry of this.awaiting) entry.done = true;
    this.awaiting.clear();
  }

  /** The record, with `waiting` calls the host holds back, for room or a wake's turn, which the script has made too. */
  summary(waiting = 0): CallSummary {
    return {
      made: this.made + waiting,
      ...this.counts,
      running: this.running.size,
      waiting,
      named: this.named.map((c) => ({ ...c })),
      more: Object.fromEntries(this.more),
    };
  }

  /** A place among the named, or a count by tool past CALLS_NAMED. */
  private name(entry: CallEntry, state: NamedCall['state']): NamedCall | null {
    if (this.named.length < CALLS_NAMED) {
      const named: NamedCall = { tool: entry.tool, args: entry.args, state };
      this.named.push(named);
      return named;
    }
    this.more.set(entry.tool, (this.more.get(entry.tool) ?? 0) + 1);
    return null;
  }
}
