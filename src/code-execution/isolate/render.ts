/**
 * What the model reads for a return of `code_execution`: how the script ended
 * or that it's still running, first, so no cut can drop it; then what became
 * of its calls, naming each whose effect is uncertain with a count of the
 * rest; then what it returned and what it wrote since the last return.
 */

import { fresh, toolRef, type CallSummary, type NamedCall } from './calls.js';
import type { Ending } from './runner.js';
import type { ScriptListing, ScriptReturn } from './scripts.js';
import { renderOutput } from './output.js';
import { quotedValue, suppliedValue } from '../../supplied-text.js';

/**
 * The most of a script's return value, or of a failure's message or stack,
 * that a return shows, as a head and a tail of half this each. The run keeps
 * them cut to this, so an ended run kept for a later wait holds no more.
 */
export const VALUE_CHARS = 8_000;

/** The most of a failure's name a return shows: a name is a word, so the message and the stack keep the room. */
export const NAME_CHARS = 200;

/**
 * The most a cut's marker adds to its text (bounded's, with a count of up to
 * 16 digits). A text bounded again with this much room past its first bound
 * keeps its first cut, and the count that cut gives, as they are.
 */
export const CUT_MARK_CHARS = 64;

/**
 * `text`, or its head and tail of about `max / 2` each with the count dropped
 * between, as copies of their own. Neither cut parts a surrogate pair.
 */
export function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return cutOf(text.slice(0, half), text.slice(text.length - half), text.length);
}

/**
 * bounded's cut of a text of `length` characters, past its bound, from its
 * first and its last `max / 2` characters, rounded down: `head` and `tail`,
 * of that one length. So a text that's never held whole, such as a stack's
 * frames as the agent reads them (scriptFrames), is cut as bounded cuts it.
 */
export function cutOf(head: string, tail: string, length: number): string {
  const half = head.length;
  let kept = half;
  const last = head.charCodeAt(kept - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept -= 1;
  const first = tail.charCodeAt(0);
  const skipped = first >= 0xdc00 && first <= 0xdfff ? 1 : 0;
  return `${fresh(head.slice(0, kept))}\n[… ${length - half + skipped - kept} characters dropped here …]\n${fresh(tail.slice(skipped))}`;
}

/** A duration as the settings give it: exactly, a fraction of a second included. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}

function endingLine(id: string, ending: Ending, lifetimeMs: number): string {
  switch (ending.how) {
    case 'finished':
      return `Script ${id} finished.`;
    case 'failed':
      // The run keeps the message cut to VALUE_CHARS, with room for the cut's marker.
      return `Script ${id} failed: ${ending.error.name ? `${suppliedValue(ending.error.name)}: ` : ''}${suppliedValue(ending.error.message)}`;
    case 'stopped': {
      const why = ending.reason === 'agent'
        ? `Script ${id} was stopped, as you asked.`
        : ending.why
          ? `Script ${id} was stopped: ${suppliedValue(glimpse(ending.why, 300))}.`
          : `Script ${id} was stopped at its limit of ${formatMs(lifetimeMs)}.`;
      return ending.short ? `${why} Its process didn't stop by itself and was ended, so its output may be short.` : why;
    }
    case 'crashed':
      // The detail is the host's account; what it means for the agent follows.
      return `Script ${id} crashed: ${suppliedValue(ending.detail)}. A crash is the script's process failing, not an error its code threw: a fault in the host or its runtime, or something the script's own data asked of the runtime that it couldn't do, such as reading values nested thousands deep, or code nested hundreds deep. Running it again may work; if the same script crashes again, change what it does with its data or its code.`;
  }
}

/**
 * The start of `text`, up to `max` characters and "…" when it goes on, never
 * parting a surrogate pair: a glimpse of a text that may already have been cut,
 * whose count a second cut would misstate.
 */
export function glimpse(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${fresh(text.slice(0, cut))}…`;
}

/** A named call as the agent wrote it, with its arguments. */
function namedRef(call: NamedCall): string {
  return call.tool === 'wake_agent' ? `wake_agent(${call.args})` : `${toolRef(call.tool)}(${call.args})`;
}

function namedLine(call: NamedCall): string {
  switch (call.state) {
    case 'uncertain':
      return `- still running when the script ended, so it may or may not take effect: ${namedRef(call)}`;
    case 'timed-out':
      return `- timed out in the script, and still running when the script ended, so it may still take effect: ${namedRef(call)}`;
    case 'timed-out-answered':
      return `- timed out in the script, and its answer came later: ${namedRef(call)}, answer ${quotedValue(call.answer ?? '')}`;
    case 'too-large':
      return `- answered with a result the script couldn't receive, too large for its memory or nested too deep, so it got an error instead: ${namedRef(call)}`;
    case 'unseen':
      return `- answered, but the script ended before it read the answer: ${namedRef(call)}`;
  }
}

/**
 * What became of the calls. At a yield, counts. At the end, counts, and each
 * call whose answer the script didn't see, named with its arguments, past
 * CALLS_NAMED counted by tool.
 */
function callsLines(calls: CallSummary, running: boolean): string {
  if (calls.made === 0) return running ? 'It has made no tool calls yet.' : 'It made no tool calls.';
  const unseen = calls.named.length + Object.values(calls.more).reduce((sum, n) => sum + n, 0);
  const parts: string[] = [];
  const add = (n: number, words: string) => {
    if (n > 0) parts.push(`${n} ${words}`);
  };
  add(calls.answered, 'answered');
  add(calls.failed, 'answered with an error');
  add(calls.refused, calls.refused === 1 ? 'refused before it ran, so nothing was done' : 'refused before they ran, so nothing was done');
  add(calls.unsent, 'never sent, so nothing was done');
  add(calls.running, 'still running');
  add(calls.waiting, 'waiting their turn in the host');
  // Timed out, answered with a result too large for the script's memory,
  // still running when the script ended (uncertain), or answered after the
  // script stopped reading (unseen): either way the script went on without
  // the answer.
  add(unseen, unseen === 1 ? "whose answer it didn't see" : "whose answers it didn't see");
  const head = `${running ? 'Its calls so far' : 'Its calls'}: ${calls.made}${parts.length ? ` (${parts.join('; ')})` : ''}`;
  if (running || unseen === 0) return `${head}.`;
  const lines = [`${head}:`, ...calls.named.map(namedLine)];
  const more = Object.entries(calls.more);
  if (more.length > 0) {
    lines.push(`- and ${unseen - calls.named.length} more: ${more.map(([tool, n]) => `${toolRef(tool)} ×${n}`).join(', ')}`);
  }
  return lines.join('\n');
}

export interface RenderOptions {
  /** The bound the return was made at, for a yield's line. */
  boundMs: number;
  lifetimeMs: number;
  /**
   * The agent's inline cap for tool results, which the return is stored
   * under: the output is cut to the room the rest of the return leaves in
   * it. None when left out.
   */
  maxChars?: number;
}

/** The text a return gives the model. */
export function renderReturn(r: ScriptReturn, options: RenderOptions): string {
  const lines: string[] = [];
  if (r.ending === null) {
    lines.push(`Script ${r.scriptId} is still running after ${formatMs(options.boundMs)}.`);
    lines.push(
      r.stopsAtTurnEnd
        ? `It will be stopped when your turn ends if it's still running, since only the primary agent's scripts outlive a turn. ` +
            `Wait for it with {"action": "wait", "script_id": "${r.scriptId}"} to see it finish, or stop it with {"action": "stop", "script_id": "${r.scriptId}"}.`
        : `Wait for it with {"action": "wait", "script_id": "${r.scriptId}"}, stop it with {"action": "stop", "script_id": "${r.scriptId}"}, ` +
            'or leave it running: it can wake you with wake_agent(), and you are woken if it fails, crashes or reaches its limit.',
    );
  } else {
    lines.push(endingLine(r.scriptId, r.ending, options.lifetimeMs));
  }
  // The ending's line gave the name and message; the script's frames follow (GuestError.stack).
  if (r.ending?.how === 'failed' && r.ending.error.stack) lines.push(r.ending.error.stack);
  lines.push(callsLines(r.calls, r.ending === null));
  // The run keeps the value cut to VALUE_CHARS, with room for the cut's marker.
  if (r.ending?.how === 'finished' && r.ending.value !== undefined) lines.push(`It returned: ${r.ending.value}`);
  const { head, tail, dropped } = r.output;
  if (head.length + tail.length + dropped === 0) {
    lines.push(r.first ? 'No output.' : 'No output since the last return.');
    return lines.join('\n');
  }
  // The output comes last, and past the agent's inline cap the framework's
  // cut would take its tail first: it gets the room the rest leaves, its head
  // and tail cut alike.
  const label = `${r.first ? 'Its output' : 'Its output since the last return'}:\n`;
  const rest = lines.join('\n').length + 1 + label.length;
  lines.push(label + renderOutput(r.output, (options.maxChars ?? Infinity) - rest));
  return lines.join('\n');
}

function minutesAgo(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? 'under a minute' : `${minutes} min`;
}

/** How a listed script stands, in a few words. */
function listingState(s: ScriptListing, now: number): string {
  if (s.running) return `running for ${minutesAgo(now - s.startedAt)}`;
  const when = s.endedAt === null ? '' : ` ${minutesAgo(now - s.endedAt)} ago`;
  const e = s.ending;
  switch (e?.how) {
    case 'finished':
      return `finished${when}`;
    case 'failed':
      return `failed${when}: ${e.error.name ? `${suppliedValue(e.error.name)}: ` : ''}${suppliedValue(glimpse(e.error.message, 300))}`;
    case 'crashed':
      return `crashed${when}`;
    case 'stopped':
      return e.reason === 'agent' ? `stopped by you${when}` : e.why ? `stopped${when}: ${suppliedValue(glimpse(e.why, 300))}` : `stopped at its limit${when}`;
    default:
      return 'ended';
  }
}

/** A `list` of an agent's scripts: each one's id and how it stands, with how to see more. */
export function renderList(scripts: ScriptListing[], now: number): string {
  if (scripts.length === 0) return 'You have no scripts.';
  const lines = scripts.map((s) => `- ${s.scriptId}: ${listingState(s, now)}${s.wakes > 0 ? ` (${s.wakes} wake${s.wakes === 1 ? '' : 's'} delivered)` : ''}`);
  return [
    'Your scripts:',
    ...lines,
    '{"action": "wait", "script_id": ...} gives a script\'s output since its last return, or its result once it has ended.',
  ].join('\n');
}
