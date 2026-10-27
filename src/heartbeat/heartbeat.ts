/**
 * The heartbeat: the agent's own schedule of wakes, in the framework.
 *
 * Two kinds of wake, both the agent's to set:
 * - the ambient heartbeat, one periodic tick (`intervalSeconds`, `paused`,
 *   `message`, `deliveryMode`): a message-mode tick is a timestamped prompt
 *   stored in the agent's window, a silent tick a private wake that stores
 *   no prompt and suppresses automatic prose (silent-heartbeat.ts);
 * - reminders, one-off (a delay or an `atIso` time) or repeating (an
 *   interval), each a stored message with a header naming it and the time.
 *
 * This was heartbeat-mcpl, an MCPL server; it moved here so the framework
 * knows when the agent's next scheduled wake is (the reply judge is told,
 * EventGate.upcomingWakes) and needs no server, policy exchange or push
 * delivery to keep it. Its tools are listed as `heartbeat--heartbeat_status`
 * and the rest, and calls by heartbeat-mcpl's names (`mcpl--heartbeat--…`)
 * reach them too. Its wakes go to the gate as that server's pushes did, a
 * push from the server id `heartbeat`, so the agent's rules decide them as
 * they decided those, and a sleep lets them through, as it let that server
 * id through.
 *
 * State (the schedule, when the next tick is due, and the reminders) is one
 * JSON file, by default `{storePath}/config/heartbeat.json`. A first start
 * with no file imports heartbeat-mcpl's two files when the host names them
 * (`importFrom`). The next tick's time is kept, so a restart doesn't push it
 * back; a tick or a reminder that fell due while the host was down fires
 * once, shortly after start, a repeating reminder once for the periods it
 * missed.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkToolInput, shownValue } from '../gate/event-gate.js';
import type { UpcomingWake } from '../gate/types.js';
import type { ToolDefinition } from '../types/events.js';
import type { ToolParameter } from '@animalabs/membrane';
import { FIRST_REMINDER_TIME, LAST_REMINDER_TIME, canHoldTime, parseReminderTime } from './reminder-time.js';

/** The prefix the heartbeat's tools carry. */
export const HEARTBEAT_TOOL_PREFIX = 'heartbeat--';
/** The prefix heartbeat-mcpl's tools carried under the server id `heartbeat`
 *  and the default tool prefix: a call by that name, as the agent's context
 *  may still show them, reaches the same tool. */
export const LEGACY_HEARTBEAT_TOOL_PREFIX = 'mcpl--heartbeat--';
/**
 * Whether an MCPL server is heartbeat-mcpl, or names its tools as the
 * heartbeat's: by its id, a tool prefix of `heartbeat` or `mcpl--heartbeat`,
 * or a command or argument that runs heartbeat-mcpl. The framework's
 * heartbeat refuses one beside it, at create and at a runtime connect.
 */
export function isHeartbeatMcplServer(server: { id: string; toolPrefix?: string }): boolean {
  if (server.id === 'heartbeat' || server.toolPrefix === 'heartbeat' || server.toolPrefix === 'mcpl--heartbeat') return true;
  const { command, args } = server as { command?: unknown; args?: unknown };
  const parts = [command, ...(Array.isArray(args) ? args : [])];
  return parts.some((part) => typeof part === 'string' && /heartbeat-mcpl/.test(part));
}

/** A heartbeat tool's name under the other prefix, for a name under one: the
 *  framework's `heartbeat--x` and heartbeat-mcpl's `mcpl--heartbeat--x` are
 *  one tool. Undefined for any other name. */
export function heartbeatToolAlias(name: string): string | undefined {
  if (name.startsWith(LEGACY_HEARTBEAT_TOOL_PREFIX)) return `${HEARTBEAT_TOOL_PREFIX}${name.slice(LEGACY_HEARTBEAT_TOOL_PREFIX.length)}`;
  if (name.startsWith(HEARTBEAT_TOOL_PREFIX)) return `${LEGACY_HEARTBEAT_TOOL_PREFIX}${name.slice(HEARTBEAT_TOOL_PREFIX.length)}`;
  return undefined;
}

/** The tools that change the schedule, as against the two that only show it. */
export const HEARTBEAT_CHANGING_TOOLS: readonly string[] = ['heartbeat_configure', 'heartbeat_trigger', 'reminder_add', 'reminder_cancel'];

export type HeartbeatDeliveryMode = 'message' | 'silent';

/** The ambient heartbeat's schedule. */
export interface HeartbeatSettings {
  intervalSeconds: number;
  paused: boolean;
  message: string;
  deliveryMode: HeartbeatDeliveryMode;
}

export const DEFAULT_HEARTBEAT: Readonly<HeartbeatSettings> = {
  intervalSeconds: 4 * 60 * 60,
  paused: false,
  deliveryMode: 'message',
  message: '[heartbeat] Periodic self-check-in. Review anything pending — reminders, schedules, follow-ups — and act if needed; otherwise a brief note to yourself is fine.',
};

/** A scheduled reminder. `everySeconds` null: one-off, dropped once it fires. */
export interface Reminder {
  id: string;
  message: string;
  /** When it was set (ms). */
  createdAt: number;
  /** When it's next due (ms). */
  fireAt: number;
  everySeconds: number | null;
  /** When a delivery that failed is tried again (ms); its `fireAt` stays the time it was due. */
  retryAt?: number;
}

/** Host options (`FrameworkConfig.heartbeat`). */
export interface HeartbeatOptions {
  /** The state file. Default `{storePath}/config/heartbeat.json`. */
  statePath?: string;
  /** The schedule a first start writes when there's nothing to import. */
  defaults?: Partial<HeartbeatSettings>;
  /**
   * heartbeat-mcpl's files (its HEARTBEAT_CONFIG_FILE and
   * HEARTBEAT_REMINDERS_FILE), read once, by a start that finds no state
   * file, so an agent moving off the server keeps its schedule and its
   * reminders. They're left as they are.
   */
  importFrom?: { configPath?: string; remindersPath?: string };
}

/** One of the heartbeat's scheduled wakes: its next tick or a pending reminder. */
export interface HeartbeatScheduledWake extends UpcomingWake {
  kind: 'heartbeat' | 'reminder';
  at: number;
  /** Whether it's a silent tick, delivered as one (HeartbeatWake's `silent`). */
  silent: boolean;
  /** The text it brings, as of its due time: so the gate can be asked about
   *  the event it will judge. */
  text: string;
}

/** A wake the heartbeat asks the framework to deliver. */
export type HeartbeatWake =
  | { kind: 'heartbeat'; reason: 'schedule' | 'manual'; silent: boolean; text: string; eventId: string }
  | { kind: 'reminder'; reminderId: string; recurring: boolean; text: string; eventId: string };

interface HeartbeatState {
  v: 1;
  settings: HeartbeatSettings;
  /** When the next tick is due (ms); null while paused. */
  nextFireAt: number | null;
  reminders: Reminder[];
}

const MIN_HEARTBEAT_SECONDS = 60;
const MIN_REMINDER_SECONDS = 5;
/** What fell due while the host was down fires this long after start, once the host's servers have connected. */
const START_GRACE_MS = 10_000;
/** A delivery that throws is tried again this much later. */
const RETRY_MS = 60_000;
/** A reminder delivered this late or later says when it was due. */
const LATE_MS = 60_000;
/** The longest wait a timer holds; longer ones are re-armed. */
const MAX_TIMEOUT_MS = 2_147_483_647;

const INTERVAL_UNITS = [['intervalSeconds', 1], ['intervalMinutes', 60], ['intervalHours', 3600]] as const;
const DELAY_UNITS = [['inSeconds', 1], ['inMinutes', 60], ['inHours', 3600]] as const;
const EVERY_UNITS = [['everySeconds', 1], ['everyMinutes', 60], ['everyHours', 3600]] as const;

type Units = typeof INTERVAL_UNITS | typeof DELAY_UNITS | typeof EVERY_UNITS;

const tool = (name: string, description: string, properties: Record<string, ToolParameter>, required?: string[]): ToolDefinition => ({
  name: `${HEARTBEAT_TOOL_PREFIX}${name}`,
  description,
  inputSchema: { type: 'object', properties, ...(required ? { required } : {}) },
});

function toolDefinitions(timeZone: string): ToolDefinition[] {
  return [
    tool('heartbeat_status',
      'Show your heartbeat schedule (interval, paused or not, when the next one is due, delivery mode, message) and how many reminders are pending.',
      {}),
    tool('heartbeat_configure',
      'Change your own ambient heartbeat. Give any of: the interval, in intervalSeconds, intervalMinutes and intervalHours, which add up, 60 seconds or more; paused; deliveryMode; message. It\'s saved, so it persists across restarts. Changing the interval or resuming starts the next interval now. With no arguments it changes nothing and shows the schedule. (Reminders are separate: see reminder_add.)',
      {
        intervalSeconds: { type: 'number', description: 'Wake interval in seconds. Adds to intervalMinutes and intervalHours; together, 60 seconds or more.' },
        intervalMinutes: { type: 'number', description: 'Wake interval in minutes. Adds to intervalSeconds and intervalHours.' },
        intervalHours: { type: 'number', description: 'Wake interval in hours. Adds to intervalSeconds and intervalMinutes.' },
        paused: { type: 'boolean', description: 'Pause (true) or resume (false) heartbeats.' },
        deliveryMode: { type: 'string', enum: ['message', 'silent'], description: 'message: a timestamped prompt in your window; silent: a private tick that stores no prompt and no automatic prose.' },
        message: { type: 'string', description: 'The text a message-mode heartbeat brings you.' },
      }),
    tool('heartbeat_trigger', 'Fire one ambient heartbeat now. The schedule doesn\'t change.', {}),
    tool('reminder_add',
      'Schedule a reminder that wakes you with a message. One-off: give a delay, in inSeconds, inMinutes and inHours, which add up, or a time, atIso. Repeating: give an interval, in everySeconds, everyMinutes and everyHours, which add up, 5 seconds or more; it first fires one interval out, or at the delay or atIso you also give. It\'s saved, so it survives restarts. Returns the reminder\'s id.',
      {
        message: { type: 'string', description: 'The text you get when it fires, after a header naming the reminder, when it was set (or its interval) and the current time: `[reminder <id>, set <time> · current time: <time>] <message>`.' },
        inSeconds: { type: 'number', description: 'Fire this many seconds from now. Adds to inMinutes and inHours.' },
        inMinutes: { type: 'number', description: 'Fire this many minutes from now. Adds to inSeconds and inHours.' },
        inHours: { type: 'number', description: 'Fire this many hours from now. Adds to inSeconds and inMinutes.' },
        atIso: { type: 'string', description: `When it fires, or first fires if it repeats: an ISO-8601 date/time. Without an offset it's read in ${timeZone}, and a date alone is midnight there; a wall time a clock change skips or repeats is refused, naming the offsets to choose from. Z or a numeric offset gives the instant directly (e.g. 2026-07-01T09:00:00-04:00). A past time fires at once.` },
        everySeconds: { type: 'number', description: 'Repeat every N seconds. Adds to everyMinutes and everyHours; together, 5 seconds or more.' },
        everyMinutes: { type: 'number', description: 'Repeat every N minutes. Adds to everySeconds and everyHours.' },
        everyHours: { type: 'number', description: 'Repeat every N hours. Adds to everySeconds and everyMinutes.' },
      },
      ['message']),
    tool('reminder_list', 'List your pending reminders: id, when each is due, whether it repeats, message.', {}),
    tool('reminder_cancel', 'Cancel a reminder by its id (from reminder_add or reminder_list).',
      { id: { type: 'string', description: 'The reminder\'s id, as reminder_add returned it and reminder_list shows it; it starts with rem_.' } },
      ['id']),
  ];
}

/** What a refused call left alone, by tool. */
const REFUSED: Record<string, string> = {
  heartbeat_status: 'nothing was shown',
  heartbeat_configure: 'nothing was changed',
  heartbeat_trigger: 'no heartbeat was sent',
  reminder_add: 'no reminder was set',
  reminder_list: 'nothing was listed',
  reminder_cancel: 'nothing was cancelled',
};

/**
 * A time as the heartbeat's texts show it, to the second, with its offset and
 * zone: `2026-10-26T09:00:00-07:00 [America/Los_Angeles]`, as heartbeat-mcpl
 * wrote it, so the agent reads its ticks and reminders as before.
 */
export function formatHeartbeatTime(value: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const rawOffset = get('timeZoneName');
  const offset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset} [${timeZone}]`;
}

/** A timer at an absolute time, re-armed past the longest wait a timer holds. */
function callAt(dueAt: number, now: () => number, onDue: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    const wait = Math.max(0, Math.min(dueAt - now(), MAX_TIMEOUT_MS));
    timer = setTimeout(() => (now() < dueAt ? arm() : onDue()), wait);
  };
  arm();
  return () => clearTimeout(timer);
}

/** The text a tick brings: the time, then its message. */
function tickText(now: number, message: string, timeZone: string): string {
  return `[current time: ${formatHeartbeatTime(now, timeZone)}] ${message}`;
}

/** The text a reminder brings: a header naming it, then its message. */
export function reminderText(rem: Reminder, now: number, timeZone: string): string {
  let schedule = rem.everySeconds !== null ? `, repeats every ${rem.everySeconds}s` : `, set ${formatHeartbeatTime(rem.createdAt, timeZone)}`;
  if (now - rem.fireAt >= LATE_MS) schedule += `, due ${formatHeartbeatTime(rem.fireAt, timeZone)}`;
  return `[reminder ${rem.id}${schedule} · current time: ${formatHeartbeatTime(now, timeZone)}] ${rem.message}`;
}

/** A length of time as the agent is shown it. */
function shownLength(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${+(seconds / 60).toFixed(1)} min`;
  return `${+(seconds / 3600).toFixed(2)} h`;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export class Heartbeat {
  private readonly statePath: string;
  private readonly defaults: HeartbeatSettings;
  private readonly importFrom: HeartbeatOptions['importFrom'];
  private readonly timeZone: string;
  private readonly deliver: (wake: HeartbeatWake) => void;
  private readonly now: () => number;
  private readonly tools: ToolDefinition[];
  private state: HeartbeatState;
  /** Why the state file can't be written now, when it can't (its text couldn't be read and set aside). */
  private unsaveable: string | null = null;
  /** What the last save's failure was, for the tool that made the change. */
  private lastSaveError: string | null = null;
  private cancelTick: (() => void) | null = null;
  private cancelReminders: (() => void) | null = null;
  /** Nothing fires before this (ms): a start's grace for what fell due while the host was down. */
  private notBefore = 0;
  private started = false;

  constructor(opts: {
    statePath: string;
    timeZone: string;
    deliver: (wake: HeartbeatWake) => void;
    defaults?: Partial<HeartbeatSettings>;
    importFrom?: HeartbeatOptions['importFrom'];
    now?: () => number;
  }) {
    this.statePath = opts.statePath;
    this.timeZone = opts.timeZone;
    this.deliver = opts.deliver;
    this.importFrom = opts.importFrom;
    this.now = opts.now ?? Date.now;
    this.defaults = { ...DEFAULT_HEARTBEAT, ...readSettings(opts.defaults ?? {}, DEFAULT_HEARTBEAT, (note) => log(`defaults: ${note}`)) };
    this.tools = toolDefinitions(this.timeZone);
    this.state = { v: 1, settings: { ...this.defaults }, nextFireAt: null, reminders: [] };
  }

  /** Load (or import, or create) the state and arm the timers. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.now();
    this.notBefore = now + START_GRACE_MS;
    this.state = this.load(now);
    const s = this.state;
    if (s.settings.paused) {
      s.nextFireAt = null;
    } else if (s.nextFireAt === null || !Number.isFinite(s.nextFireAt)) {
      s.nextFireAt = now + s.settings.intervalSeconds * 1000;
    }
    this.save();
    this.armTick();
    this.armReminders();
    log(`started: ${this.statusLine()}`);
  }

  /** Clear the timers; the state stays saved. */
  stop(): void {
    this.started = false;
    this.cancelTick?.();
    this.cancelTick = null;
    this.cancelReminders?.();
    this.cancelReminders = null;
  }

  /** The tools, named as agents call them (`heartbeat--…`). */
  getTools(): ToolDefinition[] {
    return this.tools;
  }

  /** Whether `name` is one of the heartbeat's tools, by its name or heartbeat-mcpl's. */
  ownsTool(name: string): boolean {
    return this.tools.some((t) => t.name === canonicalName(name));
  }

  /** What the heartbeat will wake the agent with, soonest first, for the reply judge (UpcomingWake). */
  upcomingWakes(): UpcomingWake[] {
    return this.scheduledWakes().map(({ at, certain, what }) => ({ at, certain, what }));
  }

  /**
   * The heartbeat's next tick and its pending reminders, soonest first, each
   * with its kind and the event it will bring, so the gate can be asked about
   * it. `whose` words each for the reply judge ("its heartbeat", as
   * upcomingWakes) or for the agent ("your heartbeat", as skip_reply's
   * confirmation names one due before its self-wake).
   */
  scheduledWakes(whose: 'its' | 'your' = 'its'): HeartbeatScheduledWake[] {
    const wakes: HeartbeatScheduledWake[] = [];
    const s = this.state;
    if (!s.settings.paused && s.nextFireAt !== null) {
      const at = Math.max(s.nextFireAt, this.notBefore);
      const silent = s.settings.deliveryMode === 'silent';
      wakes.push({
        kind: 'heartbeat',
        at,
        certain: true,
        what: `${whose} heartbeat (${silent ? 'a silent tick' : 'a check-in prompt'}, every ${shownLength(s.settings.intervalSeconds)})`,
        silent,
        // A host's interval can put the tick past the last time a date
        // shows (readSettings has no ceiling), and a time can't be shown there.
        text: canHoldTime(at) ? tickText(at, s.settings.message, this.timeZone) : s.settings.message,
      });
    }
    for (const r of s.reminders) {
      const message = r.message.length > 80 ? `${r.message.slice(0, 77)}...` : r.message;
      const at = Math.max(dueAt(r), this.notBefore);
      wakes.push({
        kind: 'reminder',
        at,
        certain: true,
        what: `${whose} reminder ${JSON.stringify(message)}${r.everySeconds !== null ? ` (repeats every ${shownLength(r.everySeconds)})` : ''}`,
        silent: false,
        text: reminderText(r, at, this.timeZone),
      });
    }
    return wakes.sort((a, b) => a.at - b.at);
  }

  /**
   * Handle a call to one of the tools, by its full name. Arguments are read
   * as a wake rule's are: a slip of a parameter's name, or a field given
   * outside the parameter it belongs to, refuses the call, naming it; an
   * unknown name is noted in the result.
   */
  handleToolCall(calledName: string, rawInput: unknown): { success: boolean; data?: string; error?: string; isError?: boolean } {
    const fullName = canonicalName(calledName);
    const def = this.tools.find((t) => t.name === fullName);
    const name = fullName.slice(HEARTBEAT_TOOL_PREFIX.length);
    if (!def) return { success: false, error: `There's no heartbeat tool named ${JSON.stringify(calledName)}.`, isError: true };
    const renamed = calledName !== fullName
      ? ` (The heartbeat's tools are now ${HEARTBEAT_TOOL_PREFIX}…: this is ${fullName}. ${LEGACY_HEARTBEAT_TOOL_PREFIX}… still reaches them.)`
      : '';
    const ignored: string[] = [];
    let args: Record<string, unknown>;
    try {
      args = checkToolInput(fullName, isObject(rawInput) ? rawInput : {}, def.inputSchema.properties as Record<string, unknown>, ignored);
    } catch (err) {
      return { success: false, error: (err as Error).message, isError: true };
    }
    const problems: string[] = [];
    let result: { text: string; error?: boolean };
    switch (name) {
      case 'heartbeat_configure': result = this.configure(args, problems); break;
      case 'heartbeat_trigger': result = this.trigger(); break;
      case 'reminder_add': result = this.addReminder(args, problems); break;
      case 'reminder_list': result = { text: this.listText() }; break;
      case 'reminder_cancel': result = this.cancelReminder(args, problems); break;
      default: result = { text: this.statusText() };
    }
    const text = `${ignored.length > 0 ? `${result.text} ${ignored.join(' ')}` : result.text}${renamed}`;
    return result.error ? { success: false, error: text, isError: true } : { success: true, data: text };
  }

  // ===========================================================================
  // Tools
  // ===========================================================================

  private refuse(tool: string, problems: readonly string[]): { text: string; error: true } {
    return { text: `${HEARTBEAT_TOOL_PREFIX}${tool}: ${REFUSED[tool]}. ${problems.join(' ')}`, error: true };
  }

  private statusLine(): string {
    const s = this.state.settings;
    const next = !s.paused && this.state.nextFireAt !== null
      ? ` | next in ~${Math.max(0, Math.round((Math.max(this.state.nextFireAt, this.notBefore) - this.now()) / 1000))}s`
      : '';
    return `Heartbeat ${s.paused ? 'PAUSED' : 'ACTIVE'} | mode=${s.deliveryMode} | interval=${s.intervalSeconds}s (${(s.intervalSeconds / 3600).toFixed(2)}h)`
      + `${next} | reminders=${this.state.reminders.length}`;
  }

  private statusText(): string {
    return `${this.statusLine()} | message="${this.state.settings.message}"${this.saveNote()}`;
  }

  private saveNote(): string {
    if (this.unsaveable) return ` (Not saved: ${this.unsaveable}.)`;
    if (this.lastSaveError) return ` (Not saved: writing ${this.statePath} failed: ${this.lastSaveError}.)`;
    return '';
  }

  private configure(args: Record<string, unknown>, problems: string[]): { text: string; error?: true } {
    const interval = addUnits(args, INTERVAL_UNITS, problems);
    if (interval !== null && interval < MIN_HEARTBEAT_SECONDS) {
      problems.push(`The interval comes to ${interval} s, under the heartbeat's ${MIN_HEARTBEAT_SECONDS}-second floor; give ${MIN_HEARTBEAT_SECONDS} seconds or more, or pause the heartbeat with "paused": true.`);
    } else if (interval !== null && !canHoldTime(this.now() + interval * 1000)) {
      problems.push(`The interval puts the next heartbeat past ${LAST_REMINDER_TIME}; give a shorter one, or pause the heartbeat with "paused": true.`);
    }
    if (args.paused !== undefined && typeof args.paused !== 'boolean') {
      problems.push(`"paused" is ${shownValue(args.paused)}, where true or false is needed.`);
    }
    if (args.deliveryMode !== undefined && args.deliveryMode !== 'message' && args.deliveryMode !== 'silent') {
      problems.push(`"deliveryMode" is ${shownValue(args.deliveryMode)}, where "message" or "silent" is needed.`);
    }
    if (args.message !== undefined && (typeof args.message !== 'string' || !args.message.trim())) {
      problems.push(`"message" is ${shownValue(args.message)}; give the text each heartbeat should bring, or leave it out to keep the one it has.`);
    }
    if (problems.length > 0) return this.refuse('heartbeat_configure', problems);
    const s = this.state.settings;
    let changed = false;
    let reschedule = false;
    if (interval !== null && interval !== s.intervalSeconds) { s.intervalSeconds = interval; changed = true; reschedule = true; }
    if (typeof args.paused === 'boolean' && args.paused !== s.paused) { s.paused = args.paused; changed = true; reschedule = true; }
    if ((args.deliveryMode === 'message' || args.deliveryMode === 'silent') && args.deliveryMode !== s.deliveryMode) {
      s.deliveryMode = args.deliveryMode;
      changed = true;
    }
    if (typeof args.message === 'string' && args.message !== s.message) { s.message = args.message; changed = true; }
    if (reschedule) {
      this.state.nextFireAt = s.paused ? null : this.now() + s.intervalSeconds * 1000;
      this.armTick();
    }
    if (changed) this.save();
    return { text: `${changed ? 'Updated.' : 'No changes.'} ${this.statusText()}` };
  }

  private trigger(): { text: string; error?: true } {
    if (!this.fireTick('manual')) {
      return { text: `${HEARTBEAT_TOOL_PREFIX}heartbeat_trigger: no heartbeat was sent: its delivery failed, as the log says. ${this.statusText()}`, error: true };
    }
    return { text: `Heartbeat fired. ${this.statusText()}` };
  }

  private addReminder(args: Record<string, unknown>, problems: string[]): { text: string; error?: true } {
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (typeof args.message !== 'string') problems.push(`"message" is ${shownValue(args.message)}; give the text to deliver when it fires.`);
    else if (!message) problems.push('"message" is blank; give the text to deliver when it fires.');
    const delay = addUnits(args, DELAY_UNITS, problems);
    const every = addUnits(args, EVERY_UNITS, problems);
    const atGiven = args.atIso !== undefined;
    if (every !== null && every < MIN_REMINDER_SECONDS) {
      problems.push(`The repeat interval comes to ${every} s, under the ${MIN_REMINDER_SECONDS}-second floor; give ${MIN_REMINDER_SECONDS} seconds or more, or leave it out and give a delay or atIso for a one-off.`);
    }
    if (atGiven && delay !== null) problems.push('"atIso" and a delay both say when it first fires; give one of them.');
    if (delay === null && !atGiven && every === null) {
      problems.push('No time was given: give a delay in inSeconds, inMinutes or inHours, a time in atIso, or an interval to repeat in everySeconds, everyMinutes or everyHours.');
    }
    let at: number | null = null;
    if (atGiven) {
      if (typeof args.atIso !== 'string') {
        problems.push(`"atIso" is ${shownValue(args.atIso)}, where an ISO-8601 date/time is needed.`);
      } else {
        try {
          at = parseReminderTime(args.atIso, this.timeZone);
        } catch (err) {
          problems.push((err as Error).message);
        }
      }
    }
    const now = this.now();
    const first = delay !== null ? now + delay * 1000 : at !== null ? at : every !== null ? now + every * 1000 : null;
    if (first !== null && !canHoldTime(first)) {
      problems.push(`That puts it past ${LAST_REMINDER_TIME}, the last time a reminder can hold; give a shorter delay or interval, or an earlier atIso.`);
    } else if (first !== null && every !== null && !canHoldTime(first + every * 1000)) {
      problems.push(`Its second fire would be past ${LAST_REMINDER_TIME}, the last time a reminder can hold; give a shorter interval.`);
    }
    if (problems.length > 0 || first === null) return this.refuse('reminder_add', problems);
    const rem: Reminder = {
      id: `rem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      message,
      createdAt: now,
      fireAt: first,
      everySeconds: every,
    };
    this.state.reminders.push(rem);
    this.save();
    this.armReminders();
    log(`added reminder ${rem.id} fireAt=${new Date(first).toISOString()} every=${rem.everySeconds ?? 'once'}`);
    return { text: `Reminder ${rem.id} set: ${this.describe(rem, now)}${this.saveNote()}` };
  }

  private describe(rem: Reminder, now: number): string {
    const when = rem.retryAt !== undefined
      ? `its delivery failed; trying again in ~${Math.max(0, Math.round((rem.retryAt - now) / 1000))}s`
      : rem.fireAt <= now ? 'overdue' : `~${Math.round((rem.fireAt - now) / 1000)}s`;
    const rec = rem.everySeconds !== null ? `repeats every ${rem.everySeconds}s` : 'one-shot';
    return `due ${formatHeartbeatTime(rem.fireAt, this.timeZone)} (${when}) | ${rec} | "${rem.message}"`;
  }

  private listText(): string {
    const reminders = [...this.state.reminders].sort((a, b) => a.fireAt - b.fireAt);
    if (reminders.length === 0) return `No reminders set.${this.saveNote()}`;
    const now = this.now();
    return `${reminders.length} reminder(s):\n${reminders.map((r) => `${r.id} | ${this.describe(r, now)}`).join('\n')}${this.saveNote()}`;
  }

  private cancelReminder(args: Record<string, unknown>, problems: string[]): { text: string; error?: true } {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (typeof args.id !== 'string' || !id) problems.push(`"id" is ${shownValue(args.id)}; give the reminder's id, as reminder_list shows it.`);
    if (problems.length > 0) return this.refuse('reminder_cancel', problems);
    const before = this.state.reminders.length;
    this.state.reminders = this.state.reminders.filter((r) => r.id !== id);
    if (this.state.reminders.length === before) {
      return this.refuse('reminder_cancel', [`No reminder has the id "${id}". If it was a one-off that has fired, or it was cancelled already, there's nothing more to do; otherwise reminder_list shows the pending ids.`]);
    }
    this.save();
    this.armReminders();
    log(`cancelled reminder ${id}`);
    return { text: `Cancelled ${id}. ${this.state.reminders.length} reminder(s) remain.${this.saveNote()}` };
  }

  // ===========================================================================
  // Timers and delivery
  // ===========================================================================

  private armTick(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    const at = this.state.nextFireAt;
    if (!this.started || this.state.settings.paused || at === null) return;
    this.cancelTick = callAt(Math.max(at, this.notBefore), this.now, () => {
      this.cancelTick = null;
      // A tick whose delivery threw is tried again shortly, not a whole interval later.
      const delivered = this.fireTick('schedule');
      this.state.nextFireAt = this.now() + (delivered ? this.state.settings.intervalSeconds * 1000 : RETRY_MS);
      this.save();
      this.armTick();
    });
  }

  /** Deliver one tick; false when delivery threw. */
  private fireTick(reason: 'schedule' | 'manual'): boolean {
    const now = this.now();
    const s = this.state.settings;
    const silent = s.deliveryMode === 'silent';
    try {
      this.deliver({
        kind: 'heartbeat',
        reason,
        silent,
        text: tickText(now, s.message, this.timeZone),
        eventId: `heartbeat_${now}_${Math.random().toString(36).slice(2, 8)}`,
      });
      log(`fired heartbeat (${reason}${silent ? ', silent' : ''})`);
      return true;
    } catch (err) {
      log(`heartbeat (${reason}) couldn't be delivered: ${(err as Error).message}`);
      return false;
    }
  }

  private armReminders(): void {
    this.cancelReminders?.();
    this.cancelReminders = null;
    if (!this.started || this.state.reminders.length === 0) return;
    const due = Math.min(...this.state.reminders.map(dueAt));
    this.cancelReminders = callAt(Math.max(due, this.notBefore), this.now, () => {
      this.cancelReminders = null;
      this.fireDueReminders();
    });
  }

  private fireDueReminders(): void {
    const now = this.now();
    const due = this.state.reminders.filter((r) => dueAt(r) <= now).sort((a, b) => dueAt(a) - dueAt(b));
    for (const rem of due) {
      const i = this.state.reminders.findIndex((r) => r.id === rem.id);
      if (i === -1) continue;
      try {
        this.deliver({
          kind: 'reminder',
          reminderId: rem.id,
          recurring: rem.everySeconds !== null,
          text: reminderText(rem, now, this.timeZone),
          eventId: `reminder_${now}_${Math.random().toString(36).slice(2, 8)}`,
        });
      } catch (err) {
        // Its due time stays, for its header's "due" and its repeat's rhythm.
        log(`reminder ${rem.id} couldn't be delivered (${(err as Error).message}); trying again in ${RETRY_MS / 1000}s`);
        this.state.reminders[i] = { ...rem, retryAt: now + RETRY_MS };
        continue;
      }
      if (rem.everySeconds === null) {
        this.state.reminders.splice(i, 1);
        log(`fired reminder ${rem.id} (one-shot)`);
        continue;
      }
      // A repeating reminder fires once for periods it missed, then keeps its rhythm from now.
      let next = rem.fireAt + rem.everySeconds * 1000;
      if (next <= now) next = now + rem.everySeconds * 1000;
      if (canHoldTime(next)) {
        const { retryAt: _retried, ...kept } = rem;
        this.state.reminders[i] = { ...kept, fireAt: next };
      } else {
        this.state.reminders.splice(i, 1);
        log(`ended repeating reminder ${rem.id}: its next time is past ${LAST_REMINDER_TIME}`);
      }
      log(`fired reminder ${rem.id} (repeating)`);
    }
    this.save();
    this.armReminders();
  }

  // ===========================================================================
  // State
  // ===========================================================================

  private load(now: number): HeartbeatState {
    // What an earlier start in this process couldn't read doesn't hold this one back.
    this.unsaveable = null;
    this.lastSaveError = null;
    if (existsSync(this.statePath)) {
      let text: string;
      try {
        text = readFileSync(this.statePath, 'utf-8');
      } catch (err) {
        this.unsaveable = `${this.statePath} couldn't be read (${(err as Error).message}), so nothing is written over it until a start reads it`;
        log(`${this.unsaveable}; running on the defaults meanwhile`);
        return { v: 1, settings: { ...this.defaults }, nextFireAt: null, reminders: [] };
      }
      const read = this.readState(text);
      if (read) return read;
      const aside = `${this.statePath}.unreadable-${now}`;
      try {
        renameSync(this.statePath, aside);
        log(`${this.statePath} isn't state this framework writes; moved it to ${aside} and starting from the defaults`);
      } catch (err) {
        this.unsaveable = `${this.statePath} isn't state this framework writes and couldn't be moved aside (${(err as Error).message})`;
        log(`${this.unsaveable}; running on the defaults meanwhile`);
      }
      return { v: 1, settings: { ...this.defaults }, nextFireAt: null, reminders: [] };
    }
    return this.imported() ?? { v: 1, settings: { ...this.defaults }, nextFireAt: null, reminders: [] };
  }

  /** The state a file holds, or undefined when it isn't state this framework writes. */
  private readState(text: string): HeartbeatState | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      return undefined;
    }
    if (!isObject(raw) || raw.v !== 1 || !isObject(raw.settings) || !Array.isArray(raw.reminders)) return undefined;
    const settings = { ...this.defaults, ...readSettings(raw.settings, this.defaults, (note) => log(`${this.statePath}: ${note}`)) };
    const nextFireAt = typeof raw.nextFireAt === 'number' && canHoldTime(raw.nextFireAt) ? raw.nextFireAt : null;
    return { v: 1, settings, nextFireAt, reminders: readReminders(raw.reminders, (note) => log(`${this.statePath}: ${note}`)) };
  }

  /** heartbeat-mcpl's files, read once when there's no state file and the host names them. */
  private imported(): HeartbeatState | undefined {
    const from = this.importFrom;
    if (!from?.configPath && !from?.remindersPath) return undefined;
    // A file that's there but can't be read leaves the import unfinished:
    // nothing is saved, so the next start tries it again, and meanwhile the
    // agent runs on what could be read, which its tools say isn't saved.
    const failed: string[] = [];
    const readJson = (path: string | undefined, what: string): unknown => {
      if (!path || !existsSync(path)) return undefined;
      try {
        const text = readFileSync(path, 'utf-8');
        return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      } catch (err) {
        failed.push(`heartbeat-mcpl's ${what} at ${path} couldn't be read (${(err as Error).message})`);
        return undefined;
      }
    };
    const config = readJson(from.configPath, 'schedule');
    const reminders = readJson(from.remindersPath, 'reminders');
    if (failed.length > 0) {
      this.unsaveable = `${failed.join(', and ')}, so the import isn't finished and nothing is saved until a start can read it`;
      log(this.unsaveable);
    }
    if (config === undefined && reminders === undefined) {
      return failed.length > 0 ? { v: 1, settings: { ...this.defaults }, nextFireAt: null, reminders: [] } : undefined;
    }
    const settings = { ...this.defaults };
    if (isObject(config)) {
      const stored = config.intervalSeconds;
      // heartbeat-mcpl saved an infinite interval as null, and loaded it paused.
      Object.assign(settings, readSettings(
        stored === null ? { ...config, intervalSeconds: undefined, paused: true } : config,
        this.defaults,
        (note) => log(`importing ${from.configPath}: ${note}`),
      ));
    }
    const rows = Array.isArray(reminders) ? readReminders(reminders, (note) => log(`importing ${from.remindersPath}: ${note}`)) : [];
    log(`imported heartbeat-mcpl's ${[config !== undefined ? `schedule (${from.configPath})` : '', reminders !== undefined ? `${rows.length} reminder(s) (${from.remindersPath})` : ''].filter(Boolean).join(' and ')}; the files are left as they are`);
    return { v: 1, settings, nextFireAt: null, reminders: rows };
  }

  private save(): void {
    if (this.unsaveable) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameSync(tmp, this.statePath);
      this.lastSaveError = null;
    } catch (err) {
      this.lastSaveError = (err as Error).message;
      log(`writing ${this.statePath} failed: ${this.lastSaveError}`);
    }
  }
}

/** A schedule's fields as a file or the host gives them: each one usable, read; any other, noted and left to `fallback`. */
function readSettings(raw: Record<string, unknown>, fallback: HeartbeatSettings, note: (text: string) => void): Partial<HeartbeatSettings> {
  const out: Partial<HeartbeatSettings> = {};
  const interval = raw.intervalSeconds;
  if (interval !== undefined) {
    if (typeof interval !== 'number' || !Number.isFinite(interval)) {
      note(`intervalSeconds ${shownValue(interval)} isn't a number of seconds; using ${fallback.intervalSeconds}`);
    } else if (interval < MIN_HEARTBEAT_SECONDS) {
      note(`intervalSeconds ${interval} is under the ${MIN_HEARTBEAT_SECONDS}-second floor; using ${MIN_HEARTBEAT_SECONDS}`);
      out.intervalSeconds = MIN_HEARTBEAT_SECONDS;
    } else {
      out.intervalSeconds = interval;
    }
  }
  if (raw.paused !== undefined) {
    if (typeof raw.paused === 'boolean') out.paused = raw.paused;
    else note(`paused ${shownValue(raw.paused)} isn't true or false; using ${fallback.paused}`);
  }
  if (raw.deliveryMode !== undefined) {
    if (raw.deliveryMode === 'message' || raw.deliveryMode === 'silent') out.deliveryMode = raw.deliveryMode;
    else note(`deliveryMode ${shownValue(raw.deliveryMode)} isn't "message" or "silent"; using ${fallback.deliveryMode}`);
  }
  if (raw.message !== undefined) {
    if (typeof raw.message === 'string' && raw.message.trim()) out.message = raw.message;
    else note(`message ${shownValue(raw.message)} isn't text; using the default`);
  }
  return out;
}

/** Reminder rows as a file holds them: each one this framework (or heartbeat-mcpl) writes, read; any other, noted and dropped. */
function readReminders(rows: unknown[], note: (text: string) => void): Reminder[] {
  const out: Reminder[] = [];
  for (const row of rows) {
    if (!isObject(row) || typeof row.id !== 'string' || typeof row.message !== 'string' || typeof row.createdAt !== 'number'
      || typeof row.fireAt !== 'number' || !canHoldTime(row.fireAt)
      || !(row.everySeconds === null || (typeof row.everySeconds === 'number' && Number.isFinite(row.everySeconds)))) {
      note(`dropped reminder ${shownValue(row)}: it isn't a reminder this reads, or its time is outside ${FIRST_REMINDER_TIME} to ${LAST_REMINDER_TIME}`);
      continue;
    }
    let every = row.everySeconds as number | null;
    if (every !== null && every <= 0) {
      note(`reminder ${row.id}: interval ${every}s is no interval; it fires once`);
      every = null;
    } else if (every !== null && every < MIN_REMINDER_SECONDS) {
      note(`reminder ${row.id}: interval ${every}s is under the ${MIN_REMINDER_SECONDS}-second floor; using ${MIN_REMINDER_SECONDS}`);
      every = MIN_REMINDER_SECONDS;
    }
    out.push({
      id: row.id, message: row.message, createdAt: row.createdAt, fireAt: row.fireAt, everySeconds: every,
      ...(typeof row.retryAt === 'number' && canHoldTime(row.retryAt) ? { retryAt: row.retryAt } : {}),
    });
  }
  return out;
}

/** A tool's name as the heartbeat lists it, for a call by either prefix. */
function canonicalName(name: string): string {
  return name.startsWith(LEGACY_HEARTBEAT_TOOL_PREFIX)
    ? `${HEARTBEAT_TOOL_PREFIX}${name.slice(LEGACY_HEARTBEAT_TOOL_PREFIX.length)}`
    : name;
}

/** When a reminder is next tried: its retry, after a delivery that failed, or its due time. */
function dueAt(rem: Reminder): number {
  return rem.retryAt ?? rem.fireAt;
}

/** A length given in units that add up (seconds, minutes, hours), in seconds; null when none was given. */
function addUnits(args: Record<string, unknown>, units: Units, problems: string[]): number | null {
  let total = 0;
  let given = false;
  for (const [name, factor] of units) {
    const value = args[name];
    if (value === undefined) continue;
    given = true;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`"${name}" is ${shownValue(value)}, where a number 0 or more is needed.`);
      continue;
    }
    total += value * factor;
  }
  return given ? Math.round(total * 1000) / 1000 : null;
}

function log(text: string): void {
  console.error(`[heartbeat] ${text}`);
}
