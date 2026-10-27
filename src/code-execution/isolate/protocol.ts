/**
 * The messages between a script's parent and its child, and the checks that
 * turn a decoded frame from the child into one of them. Every frame from a
 * child is untrusted: the parent acts only on a
 * message `decodeChildMessage` accepts, and any other ends the script as
 * crashed.
 */

import { countJsonValues } from './frames.js';
import type { PreludeTool } from './prelude.js';

export { countJsonValues };

/**
 * The most tool calls a script has out at once, from the call until the
 * script has its answer. One past them waits in the script, in its own memory,
 * until one is answered, and is never refused, so a `Promise.all` over many
 * calls still works, only paced, and what waits is the script's to hold. A
 * child that sends more crashes its run. `wake_agent()` takes no place: its
 * answer holds nothing, and its own cap bounds it.
 */
export const MAX_CALLS_IN_FLIGHT = 16;

/**
 * The most JSON a tool call's arguments may be, in UTF-8 bytes: room for a
 * generated file of a few MB of ordinary text as one string (escaping takes
 * more room for quotes, backslashes and control characters). With MAX_ARGUMENT_VALUES it bounds
 * what the host holds for a call while it runs: its arguments' text and their
 * parsed value, at most about twice these bytes each (a string the runtime
 * keeps in two bytes a character) and about 92 bytes a value, the most a
 * value cost in a parse under Node 24 and Bun 1.4.
 */
export const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;

/** The most values a tool call's arguments may hold: each object, array and element counts. */
export const MAX_ARGUMENT_VALUES = 100_000;

/** The most JSON a `wake_agent()` payload may be, in UTF-8 bytes: a wake says what happened, and a longer result is written with a tool. */
export const MAX_WAKE_PAYLOAD_BYTES = 64 * 1024;

/** A cap as the tool's text says it, such as 4 MiB. */
export const capText = (bytes: number): string => (bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`);

/** A `wake_agent()` payload the host won't take, said to the script: nothing was sent. Null when it may go out. */
export function wakeRefusal(payloadJson: string): { name: 'WakeRefused'; message: string; bytes: number } | null {
  const bytes = Buffer.byteLength(payloadJson, 'utf8');
  if (bytes <= MAX_WAKE_PAYLOAD_BYTES) return null;
  return {
    name: 'WakeRefused',
    message: `wake_agent()'s payload is ${bytes} bytes of JSON, past the ${capText(MAX_WAKE_PAYLOAD_BYTES)} a wake can carry; nothing was sent. Write a longer result with a tool, and wake with where to find it.`,
    bytes,
  };
}

/**
 * The longest frame a child sends: a call frame carries its arguments escaped,
 * at most six bytes for each of the 4 MiB the script may send, with room for
 * its name and the rest. The child encodes its frames against it, and the
 * parent refuses a longer one before its body is kept, so one frame being
 * read costs the host at most this much as bytes, and its text and its parse
 * up to twice as much again each.
 */
export const MAX_CHILD_FRAME_BYTES = 6 * MAX_ARGUMENT_BYTES + 1024 * 1024;

/** A wake past the script's cap, said to the script: nothing was sent. */
export function wakeLimitRefusal(maxWakes: number): { name: 'WakeRefused'; message: string } {
  // A cap of 0 turns wakes off for every script, so a new one can't either.
  if (maxWakes === 0) {
    return {
      name: 'WakeRefused',
      message: "wake_agent() is off on this host: its operator set maxWakesPerScript to 0, so nothing was sent, and no script here can wake its agent.",
    };
  }
  return {
    name: 'WakeRefused',
    message:
      `wake limit reached: ${maxWakes} per script, set by the host's maxWakesPerScript; nothing was sent, and every later ` +
      'wake_agent() in this script is refused the same way. A new script can wake its agent again.',
  };
}

/** A call's arguments the host won't take, said to the script: nothing was sent. Null when they may go out. */
export function argumentsRefusal(tool: string, argsJson: string): { name: 'ArgumentsTooLarge'; message: string; bytes: number } | null {
  const bytes = Buffer.byteLength(argsJson, 'utf8');
  if (bytes > MAX_ARGUMENT_BYTES) {
    return {
      name: 'ArgumentsTooLarge',
      message: `${tool}'s arguments are ${bytes} bytes of JSON, past the ${capText(MAX_ARGUMENT_BYTES)} a call can take; nothing was sent. Send the data in parts, over several calls.`,
      bytes,
    };
  }
  if (countJsonValues(argsJson, MAX_ARGUMENT_VALUES) > MAX_ARGUMENT_VALUES) {
    return {
      name: 'ArgumentsTooLarge',
      message: `${tool}'s arguments hold more than ${MAX_ARGUMENT_VALUES.toLocaleString('en-US')} values, the most a call can take; nothing was sent. Send the data in parts, or as one string.`,
      bytes,
    };
  }
  return null;
}

/** The error a script gets for a call whose result was too large for its memory: the call took effect. */
export const RESULT_TOO_LARGE = 'ResultTooLarge';

/** Why a stop was asked for: by the agent, or at the script's limit. Only the parent knows it. */
export type StopReason = 'agent' | 'limit';

/** The first frame to the child: the script and everything it runs with. */
export interface StartMessage {
  t: 'start';
  script: string;
  tools: PreludeTool[];
  /** The WebAssembly memory's maximum: the child's budget. */
  memoryMaxBytes: number;
  maxStackBytes?: number;
  /** The file whose appearance stops the script: its content says nothing. */
  stopFile: string;
  /** How often, at most, waiting output is flushed while the guest runs. */
  flushMs: number;
  /** The most wakes the script may send: the child refuses one past them itself. */
  maxWakes: number;
  /** The parent's pid: the child ends its process once its parent is another, its parent having gone. */
  parentPid: number;
}

/**
 * A tool call's answer, as the child decodes a result frame: `ok` resolves the
 * guest's promise with the parsed `json`, otherwise rejects with it. The JSON
 * stays bytes, for the engine to parse in the guest.
 */
export type { ResultFrame as ResultMessage } from './frames.js';
import type { ResultFrame } from './frames.js';

/** A stop for a child whose guest is idle, waiting on calls; a computing guest sees the stop file instead. */
export interface StopMessage {
  t: 'stop';
}

export type ParentMessage = StartMessage | ResultFrame | StopMessage;

/** The guest called a tool, or `wake_agent()`, by the prelude's call name. */
export interface CallMessage {
  t: 'call';
  id: number;
  name: string;
  /** The arguments as the guest's JSON text. */
  args: string;
}

/** Output the guest wrote since the last such frame. */
export interface OutMessage {
  t: 'out';
  text: string;
}

/** An error as the guest describes it. */
export interface GuestError {
  name: string;
  message: string;
  /** The script's frames, one per line, as the agent reads them (scriptFrames): the name and message aren't in it. */
  stack?: string;
}

/**
 * The engine settled a call's result, so its place is free. `unfit` when the
 * result didn't fit the guest's memory, so the script got ResultTooLarge in
 * its place. The parent's record counts a call as the script saw it.
 */
export interface SeenMessage {
  t: 'seen';
  id: number;
  unfit?: true;
}

/**
 * How the script ended, as the child saw it. A crash is the parent's to see:
 * the child can't report it. A stop's reason is the parent's too, since it
 * asked for the stop.
 */
export type EndMessage =
  | { t: 'end'; how: 'finished'; value?: string }
  | { t: 'end'; how: 'failed'; error: GuestError; stalled?: boolean }
  | { t: 'end'; how: 'stopped' };

export type ChildMessage = CallMessage | OutMessage | SeenMessage | EndMessage;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A call's id: a result frame carries it as an unsigned 32-bit number, so a larger one couldn't name its call. */
const isCallId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

/** The longest tool name the parent takes from a child, in UTF-16 code units. Providers allow 64; this leaves room and bounds the error text. */
const MAX_NAME_CHARS = 256;

/**
 * A frame from a child, as a message the parent may act on, or the reason it
 * can't be one. Fields beyond those a message has are ignored.
 */
export function decodeChildMessage(value: unknown): ChildMessage | { invalid: string } {
  if (!isRecord(value)) return { invalid: 'a frame from the child was not an object' };
  switch (value.t) {
    case 'call': {
      if (!isCallId(value.id)) return { invalid: "a call's id was not a whole number from 0 to 4294967295" };
      if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > MAX_NAME_CHARS) {
        return { invalid: "a call's name was not a string of 1 to 256 UTF-16 code units" };
      }
      if (typeof value.args !== 'string') return { invalid: "a call's arguments were not text" };
      return { t: 'call', id: value.id, name: value.name, args: value.args };
    }
    case 'seen': {
      if (!isCallId(value.id)) return { invalid: "a seen frame's id was not a whole number from 0 to 4294967295" };
      return value.unfit === true ? { t: 'seen', id: value.id, unfit: true } : { t: 'seen', id: value.id };
    }
    case 'out': {
      if (typeof value.text !== 'string') return { invalid: 'an output frame did not hold text' };
      return { t: 'out', text: value.text };
    }
    case 'end': {
      if (value.how === 'finished') {
        if (value.value !== undefined && typeof value.value !== 'string') return { invalid: "a finished script's value was not JSON text" };
        return value.value === undefined ? { t: 'end', how: 'finished' } : { t: 'end', how: 'finished', value: value.value };
      }
      if (value.how === 'failed') {
        const error = value.error;
        if (!isRecord(error) || typeof error.name !== 'string' || typeof error.message !== 'string' || (error.stack !== undefined && typeof error.stack !== 'string')) {
          return { invalid: "a failed script's error did not hold a name and a message" };
        }
        return {
          t: 'end',
          how: 'failed',
          error: { name: error.name, message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) },
          ...(value.stalled === true ? { stalled: true } : {}),
        };
      }
      if (value.how === 'stopped') return { t: 'end', how: 'stopped' };
      return { invalid: 'an end frame named no ending' };
    }
    default:
      return { invalid: 'a frame from the child named no message' };
  }
}
