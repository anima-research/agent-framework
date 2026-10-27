/**
 * How `skip_reply` reads its `wake_in_seconds`, for every site that acts on
 * it: the framework arms the EventGate's timer or refuses the call, the turn's
 * bookkeeping of a refused round asks whether it was refused, and the channel
 * registry words the confirmation. One reading, so a value can't arm a timer
 * at one site and read as no wake at another, and the confirmation names the
 * seconds the timer is set for.
 */
import { safeSlice } from '../safe-slice.js';

/** The range the tool's schema offers, in seconds: a larger number waits the most. */
export const SKIP_REPLY_WAKE_MIN_SECONDS = 1;
export const SKIP_REPLY_WAKE_MAX_SECONDS = 3600;

/**
 * What a `skip_reply` call's `wake_in_seconds` asks for:
 * - `none`: absent or `null`, an ordinary skip;
 * - `wake`: a number of at least 1, or a string that `Number()` reads as one,
 *   in whole seconds and at most 3600, so 90.7 waits 90 s and anything over
 *   3600, Infinity included, waits 3600 s;
 * - `invalid`: anything else, which asks for no number of seconds the host can
 *   set: a number below 1, such as 0, a negative or 0.5, and "soon", "",
 *   `true`, an array or an object. Below 1 is refused rather than raised to 1:
 *   0 is a value a model may write when it fills an optional number with a
 *   default, and as a 1 s wake it would wake the agent again a second after
 *   each turn, for as long as it kept skipping with 0.
 */
export type SkipReplyWake =
  | { kind: 'none' }
  | { kind: 'wake'; seconds: number }
  | { kind: 'invalid'; value: unknown };

export function readSkipReplyWake(input: unknown): SkipReplyWake {
  const value = input !== null && typeof input === 'object'
    ? (input as Record<string, unknown>).wake_in_seconds
    : undefined;
  if (value === undefined || value === null) return { kind: 'none' };
  // A blank string reads as 0, so it's refused as a number below 1.
  const seconds = typeof value === 'number' ? value
    : typeof value === 'string' ? Number(value)
    : Number.NaN;
  if (Number.isNaN(seconds) || seconds < SKIP_REPLY_WAKE_MIN_SECONDS) return { kind: 'invalid', value };
  return { kind: 'wake', seconds: Math.floor(Math.min(SKIP_REPLY_WAKE_MAX_SECONDS, seconds)) };
}

/**
 * A wake the host knows will come before a skip_reply's self-wake: the
 * heartbeat's next tick or a reminder, as the agent's rules let it wake the
 * agent. `what` names it to the agent ("your heartbeat (…)"); `inSeconds` is
 * how far off it is as the self-wake is armed.
 */
export interface SkipReplyFirstWake {
  inSeconds: number;
  what: string;
}

/**
 * The note a skip_reply's result carries: that the turn ended, and when the
 * agent is next woken, if it set a wake. When the heartbeat comes first, the
 * note says so, and that the self-wake goes with that wake: any turn start
 * cancels a pending self-wake (EventGate.onInferenceStarted), so a timer the
 * agent still wants after the heartbeat's turn is one it sets again then.
 */
export function skipReplyNote(selfWakeSeconds: number | undefined, first?: SkipReplyFirstWake): string {
  if (selfWakeSeconds === undefined) return 'Turn ended; nothing sent.';
  if (first === undefined) {
    return `Turn ended; nothing sent. Self-wake in ~${selfWakeSeconds}s unless something wakes you first.`;
  }
  const what = first.what.charAt(0).toUpperCase() + first.what.slice(1);
  return `Turn ended; nothing sent. ${what} wakes you first, in ~${first.inSeconds}s, `
    + `and that wake cancels your ~${selfWakeSeconds}s self-wake: set it again then if you still want it.`;
}

/** The refusal the model reads when its host has no EventGate to set a timer. */
export const SKIP_REPLY_WAKE_NO_GATE_REFUSAL =
  "Your turn didn't end, and no wake was set: this host can't wake you on a timer, so skip_reply can't take wake_in_seconds here. To end the turn and wait for the next message, call skip_reply without it. Anything you meant to come back to, do now.";

/**
 * Why a `skip_reply` call is refused, as the model will read it, or undefined
 * when it isn't: without an EventGate, any `wake_in_seconds` but absent or
 * `null`, since the host offers none; with one, a value that isn't a number of
 * seconds. A refused call arms nothing and doesn't end the turn.
 */
export function skipReplyWakeRefusal(wake: SkipReplyWake, gatePresent: boolean): string | undefined {
  if (wake.kind === 'none') return undefined;
  if (!gatePresent) return SKIP_REPLY_WAKE_NO_GATE_REFUSAL;
  if (wake.kind === 'wake') return undefined;
  return `Your turn didn't end, and no wake was set: wake_in_seconds takes a number of seconds from ${SKIP_REPLY_WAKE_MIN_SECONDS} to ${SKIP_REPLY_WAKE_MAX_SECONDS}, and ${describeValue(wake.value)} isn't one. Call skip_reply with a number of seconds to come back on your own, or without wake_in_seconds to end the turn and wait for the next message.`;
}

/**
 * A value as the model wrote it, as JSON, cut to keep the refusal short,
 * never between the halves of a surrogate pair. A tool call's input is parsed
 * JSON, so it always has a JSON text, but JSON writes a number that isn't
 * finite as `null`, and `-1e400` parses as -Infinity, so a number prints as
 * `String()` of it.
 */
function describeValue(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : JSON.stringify(value);
  return text.length > 80 ? `${safeSlice(text, 0, 80)}…` : text;
}
