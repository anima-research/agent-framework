import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Heartbeat, reminderText, type HeartbeatWake } from '../src/heartbeat/heartbeat.js';
import { parseReminderTime } from '../src/heartbeat/reminder-time.js';

const T0 = Date.parse('2026-10-26T12:00:00Z');
let dir: string;
let errors: unknown[][];
const originalError = console.error;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heartbeat-'));
  errors = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
});
afterEach(() => {
  mock.timers.reset();
  console.error = originalError;
  rmSync(dir, { recursive: true, force: true });
});

function heartbeat(opts: Partial<ConstructorParameters<typeof Heartbeat>[0]> = {}) {
  const wakes: HeartbeatWake[] = [];
  const hb = new Heartbeat({
    statePath: join(dir, 'heartbeat.json'),
    timeZone: 'UTC',
    deliver: (w) => wakes.push(w),
    ...opts,
  });
  return { hb, wakes };
}
const call = (hb: Heartbeat, tool: string, input: Record<string, unknown> = {}) => hb.handleToolCall(`heartbeat--${tool}`, input);
const saved = () => JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf-8'));

describe('heartbeat: the tick', () => {
  it('starts on the defaults, saves them, and ticks each interval with a timestamped message', () => {
    const { hb, wakes } = heartbeat();
    hb.start();
    assert.equal(saved().settings.intervalSeconds, 14400);
    assert.equal(saved().nextFireAt, T0 + 14400_000);
    mock.timers.tick(14400_000 - 1);
    assert.equal(wakes.length, 0);
    mock.timers.tick(1);
    assert.equal(wakes.length, 1);
    const w = wakes[0]!;
    assert.equal(w.kind, 'heartbeat');
    assert.ok(w.kind === 'heartbeat' && !w.silent && w.reason === 'schedule');
    assert.match(w.text, /^\[current time: 2026-10-26T16:00:00\+00:00 \[UTC\]\] \[heartbeat\] Periodic self-check-in/);
    assert.equal(saved().nextFireAt, T0 + 2 * 14400_000);
    mock.timers.tick(14400_000);
    assert.equal(wakes.length, 2);
    hb.stop();
  });

  it('a silent heartbeat is delivered silent; a paused one not at all; trigger fires one now', () => {
    const { hb, wakes } = heartbeat();
    hb.start();
    assert.equal(call(hb, 'heartbeat_configure', { deliveryMode: 'silent', intervalMinutes: 1 }).success, true);
    mock.timers.tick(60_000);
    assert.ok(wakes[0]!.kind === 'heartbeat' && wakes[0]!.silent);
    call(hb, 'heartbeat_configure', { paused: true });
    mock.timers.tick(10 * 60_000);
    assert.equal(wakes.length, 1);
    const fired = call(hb, 'heartbeat_trigger');
    assert.equal(fired.success, true);
    assert.ok(wakes[1]!.kind === 'heartbeat' && wakes[1]!.reason === 'manual');
    hb.stop();
  });

  it('configure adds interval units, keeps the next tick on a message change, refuses what it can\'t apply', () => {
    const { hb } = heartbeat();
    hb.start();
    const r = call(hb, 'heartbeat_configure', { intervalMinutes: 1, intervalSeconds: 30 });
    assert.match(r.data!, /Updated\. Heartbeat ACTIVE \| mode=message \| interval=90s/);
    const next = saved().nextFireAt;
    mock.timers.tick(5_000);
    call(hb, 'heartbeat_configure', { message: 'check the garden' });
    assert.equal(saved().nextFireAt, next, 'a message change keeps the next tick');
    for (const [input, says] of [
      [{ intervalSeconds: 30 }, /under the heartbeat's 60-second floor/],
      [{ intervalMinutes: -1 }, /"intervalMinutes" is -1, where a number 0 or more is needed/],
      [{ deliveryMode: 'loud' }, /"deliveryMode" is "loud", where "message" or "silent" is needed/],
      [{ message: '  ' }, /"message" is "  "; give the text/],
    ] as const) {
      const refused = call(hb, 'heartbeat_configure', input);
      assert.equal(refused.success, false, JSON.stringify(input));
      assert.match(refused.error!, /^heartbeat--heartbeat_configure: nothing was changed\./);
      assert.match(refused.error!, says);
    }
    const slip = call(hb, 'heartbeat_configure', { intervalMinute: 5 });
    assert.equal(slip.success, false);
    assert.match(slip.error!, /"intervalMinute" \(did you mean "intervalMinutes"\?\)/);
    const unknown = call(hb, 'heartbeat_status', { verbose: true });
    assert.equal(unknown.success, true);
    assert.match(unknown.data!, /"verbose", which it doesn't take/);
    hb.stop();
  });
});

describe('heartbeat: reminders', () => {
  it('a one-off fires once with its header, then is gone', () => {
    const { hb, wakes } = heartbeat();
    hb.start();
    const r = call(hb, 'reminder_add', { message: 'water the tomatoes', inMinutes: 5 });
    assert.equal(r.success, true);
    const id = /Reminder (rem_\S+) set/.exec(r.data!)![1]!;
    mock.timers.tick(5 * 60_000);
    assert.equal(wakes.length, 1);
    const w = wakes[0]!;
    assert.ok(w.kind === 'reminder' && w.reminderId === id && !w.recurring);
    assert.equal(w.text, `[reminder ${id}, set 2026-10-26T12:00:00+00:00 [UTC] · current time: 2026-10-26T12:05:00+00:00 [UTC]] water the tomatoes`);
    assert.deepEqual(saved().reminders, []);
    assert.match(call(hb, 'reminder_list').data!, /No reminders set/);
    hb.stop();
  });

  it('a repeating one fires each interval and stays; cancel ends it', () => {
    const { hb, wakes } = heartbeat();
    hb.start();
    const id = /Reminder (rem_\S+) set/.exec(call(hb, 'reminder_add', { message: 'stretch', everyMinutes: 30 }).data!)![1]!;
    mock.timers.tick(30 * 60_000);
    mock.timers.tick(30 * 60_000);
    assert.equal(wakes.filter((w) => w.kind === 'reminder').length, 2);
    assert.match(wakes[0]!.text, /repeats every 1800s/);
    assert.match(call(hb, 'reminder_list').data!, new RegExp(`1 reminder\\(s\\):\\n${id} \\| due .* \\| repeats every 1800s \\| "stretch"`));
    assert.equal(call(hb, 'reminder_cancel', { id }).success, true);
    mock.timers.tick(60 * 60_000);
    assert.equal(wakes.filter((w) => w.kind === 'reminder').length, 2);
    assert.equal(call(hb, 'reminder_cancel', { id }).success, false);
    hb.stop();
  });

  it('reads atIso in the agent\'s zone and refuses what can\'t be scheduled', () => {
    const { hb, wakes } = heartbeat({ timeZone: 'America/New_York' });
    hb.start();
    assert.equal(call(hb, 'reminder_add', { message: 'call', atIso: '2026-10-26T09:30' }).success, true); // 13:30Z
    mock.timers.tick(90 * 60_000 - 1);
    assert.equal(wakes.length, 0);
    mock.timers.tick(1);
    assert.equal(wakes.length, 1);
    for (const [input, says] of [
      [{ message: 'x' }, /No time was given/],
      [{ message: 'x', inMinutes: 5, atIso: '2026-10-27T09:00' }, /"atIso" and a delay both say when it first fires/],
      [{ message: 'x', everySeconds: 2 }, /under the 5-second floor/],
      [{ message: '', inMinutes: 1 }, /"message" is missing; give the text to deliver when it fires\. heartbeat--reminder_add has "message" as "", so it's left out/],
      [{ message: 'x', atIso: '2026-03-08T02:30' }, /doesn't exist in America\/New_York/],
    ] as const) {
      const refused = call(hb, 'reminder_add', input);
      assert.equal(refused.success, false, JSON.stringify(input));
      assert.match(refused.error!, says);
    }
    hb.stop();
  });
});

describe('heartbeat: state across restarts', () => {
  it('keeps the next tick and the reminders; what fell due while down fires once, after a short grace', () => {
    const first = heartbeat();
    first.hb.start();
    call(first.hb, 'heartbeat_configure', { intervalHours: 1 });
    call(first.hb, 'reminder_add', { message: 'once', inMinutes: 30 });
    call(first.hb, 'reminder_add', { message: 'often', everyMinutes: 10 });
    first.hb.stop();
    // Down for two hours.
    mock.timers.tick(2 * 3600_000);
    assert.equal(first.wakes.length, 0);
    const second = heartbeat();
    second.hb.start();
    mock.timers.tick(9_999);
    assert.equal(second.wakes.length, 0, 'nothing before the grace');
    mock.timers.tick(1);
    const kinds = second.wakes.map((w) => (w.kind === 'reminder' ? w.text.replace(/^.*\] /, '') : 'tick'));
    assert.deepEqual(kinds.sort(), ['often', 'once', 'tick'], 'each overdue wake fires once');
    assert.match(second.wakes.find((w) => w.text.endsWith('once'))!.text, /, due 2026-10-26T12:30:00\+00:00 \[UTC\]/);
    assert.equal(saved().reminders.length, 1);
    second.hb.stop();
  });

  it("imports heartbeat-mcpl's files once, leaving them as they are", () => {
    const configPath = join(dir, 'heartbeat-config.json');
    const remindersPath = join(dir, 'heartbeat-reminders.json');
    writeFileSync(configPath, JSON.stringify({ intervalSeconds: 7200, paused: false, message: 'hello', deliveryMode: 'silent' }));
    const rem = { id: 'rem_abc', message: 'old one', createdAt: T0 - 1000, fireAt: T0 + 60_000, everySeconds: null };
    writeFileSync(remindersPath, JSON.stringify([rem, { junk: true }]));
    const { hb, wakes } = heartbeat({ importFrom: { configPath, remindersPath } });
    hb.start();
    assert.deepEqual(saved().settings, { intervalSeconds: 7200, paused: false, message: 'hello', deliveryMode: 'silent' });
    assert.deepEqual(saved().reminders, [rem]);
    assert.ok(existsSync(configPath) && existsSync(remindersPath));
    mock.timers.tick(60_000);
    assert.ok(wakes.some((w) => w.kind === 'reminder' && w.reminderId === 'rem_abc'));
    assert.ok(errors.some((e) => String(e[0]).includes('dropped reminder')));
    hb.stop();
  });

  it("imports heartbeat-mcpl's saved null interval as paused", () => {
    const configPath = join(dir, 'heartbeat-config.json');
    writeFileSync(configPath, JSON.stringify({ intervalSeconds: null, paused: false, message: 'm', deliveryMode: 'message' }));
    const { hb } = heartbeat({ importFrom: { configPath } });
    hb.start();
    assert.equal(saved().settings.paused, true);
    assert.equal(saved().settings.intervalSeconds, 14400);
    hb.stop();
  });

  it('moves an unreadable state file aside and starts from the defaults', () => {
    writeFileSync(join(dir, 'heartbeat.json'), '{ torn');
    const { hb } = heartbeat();
    hb.start();
    assert.ok(readdirSync(dir).some((f) => f.startsWith('heartbeat.json.unreadable-')));
    assert.equal(saved().settings.intervalSeconds, 14400);
    hb.stop();
  });
});

describe('heartbeat: upcoming wakes', () => {
  it('lists the next tick and each reminder, soonest first; none for a paused heartbeat', () => {
    const { hb } = heartbeat();
    hb.start();
    call(hb, 'reminder_add', { message: 'water the tomatoes', inMinutes: 20 });
    const wakes = hb.upcomingWakes();
    assert.deepEqual(wakes.map((w) => [w.at, w.what]), [
      [T0 + 20 * 60_000, 'its reminder "water the tomatoes"'],
      [T0 + 14400_000, 'its heartbeat (a check-in prompt, every 4 h)'],
    ]);
    call(hb, 'heartbeat_configure', { paused: true });
    assert.equal(hb.upcomingWakes().length, 1);
    hb.stop();
  });
});

describe('heartbeat: failures and old names', () => {
  it("answers a call by heartbeat-mcpl's name, saying the new one", () => {
    const { hb } = heartbeat();
    hb.start();
    assert.equal(hb.ownsTool('mcpl--heartbeat--reminder_list'), true);
    const r = hb.handleToolCall('mcpl--heartbeat--heartbeat_status', {});
    assert.equal(r.success, true);
    assert.match(r.data!, /^Heartbeat ACTIVE .*\(The heartbeat's tools are now heartbeat--…: this is heartbeat--heartbeat_status\. mcpl--heartbeat--… still reaches them\.\)$/);
    hb.stop();
  });

  it('a tick whose delivery throws is tried again a minute later, and trigger says it failed', () => {
    let fail = true;
    const wakes: HeartbeatWake[] = [];
    const { hb } = heartbeat({ deliver: (w) => { if (fail) throw new Error('store closed'); wakes.push(w); } });
    hb.start();
    const refused = call(hb, 'heartbeat_trigger');
    assert.equal(refused.success, false);
    assert.match(refused.error!, /no heartbeat was sent: its delivery failed/);
    mock.timers.tick(14400_000);
    assert.equal(wakes.length, 0);
    assert.equal(saved().nextFireAt, T0 + 14400_000 + 60_000, 'retried in a minute, not an interval');
    fail = false;
    mock.timers.tick(60_000);
    assert.equal(wakes.length, 1);
    assert.equal(saved().nextFireAt, T0 + 14400_000 + 60_000 + 14400_000);
    hb.stop();
  });

  it('a reminder whose delivery throws keeps its due time, for its header and its rhythm', () => {
    let fail = true;
    const wakes: HeartbeatWake[] = [];
    const { hb } = heartbeat({ deliver: (w) => { if (fail) { fail = false; throw new Error('store closed'); } wakes.push(w); } });
    hb.start();
    call(hb, 'reminder_add', { message: 'stretch', everyMinutes: 30 });
    mock.timers.tick(30 * 60_000);
    assert.equal(wakes.length, 0);
    assert.match(call(hb, 'reminder_list').data!, /its delivery failed; trying again in ~60s/);
    mock.timers.tick(60_000);
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!.text, /, due 2026-10-26T12:30:00\+00:00 \[UTC\] · current time: 2026-10-26T12:31:00\+00:00/);
    assert.equal(saved().reminders[0].fireAt, T0 + 60 * 60_000, 'the next period keeps its rhythm');
    assert.equal(saved().reminders[0].retryAt, undefined);
    hb.stop();
  });

  it('a later start that reads the state file saves again', () => {
    const path = join(dir, 'heartbeat.json');
    mkdirSync(path); // can't be read as a file
    const { hb } = heartbeat();
    hb.start();
    assert.match(call(hb, 'heartbeat_status').data!, /Not saved: .* couldn't be read/);
    hb.stop();
    rmSync(path, { recursive: true });
    hb.start();
    assert.equal(call(hb, 'heartbeat_configure', { intervalHours: 2 }).success, true);
    assert.equal(saved().settings.intervalSeconds, 7200);
    hb.stop();
  });

  it("an import that can't read one of heartbeat-mcpl's files saves nothing, so the next start finishes it", () => {
    const configPath = join(dir, 'heartbeat-config.json');
    const remindersPath = join(dir, 'heartbeat-reminders.json');
    writeFileSync(configPath, '{ torn');
    writeFileSync(remindersPath, JSON.stringify([{ id: 'rem_a', message: 'm', createdAt: T0, fireAt: T0 + 3600_000, everySeconds: null }]));
    const first = heartbeat({ importFrom: { configPath, remindersPath } });
    first.hb.start();
    assert.equal(existsSync(join(dir, 'heartbeat.json')), false);
    assert.match(call(first.hb, 'heartbeat_status').data!, /reminders=1 .*Not saved: heartbeat-mcpl's schedule at .* couldn't be read/);
    first.hb.stop();
    writeFileSync(configPath, JSON.stringify({ intervalSeconds: 600, paused: false, message: 'hi', deliveryMode: 'message' }));
    const second = heartbeat({ importFrom: { configPath, remindersPath } });
    second.hb.start();
    assert.equal(saved().settings.intervalSeconds, 600);
    assert.equal(saved().reminders.length, 1);
    second.hb.stop();
  });
});

describe('reminder text and time', () => {
  it('formats a late reminder with when it was due', () => {
    const text = reminderText({ id: 'rem_x', message: 'm', createdAt: T0, fireAt: T0 + 60_000, everySeconds: null }, T0 + 5 * 60_000, 'UTC');
    assert.equal(text, '[reminder rem_x, set 2026-10-26T12:00:00+00:00 [UTC], due 2026-10-26T12:01:00+00:00 [UTC] · current time: 2026-10-26T12:05:00+00:00 [UTC]] m');
  });

  it('reads offset-less times in the zone and refuses a repeated wall time, naming the offsets', () => {
    assert.equal(parseReminderTime('2024-07-15T09:00', 'America/New_York'), Date.parse('2024-07-15T13:00:00Z'));
    assert.equal(parseReminderTime('2024-07-15T09:00Z', 'America/New_York'), Date.parse('2024-07-15T09:00:00Z'));
    assert.throws(() => parseReminderTime('2024-11-03T01:30', 'America/New_York'), /happens twice in America\/New_York.*"2024-11-03T01:30-04:00" or "2024-11-03T01:30-05:00"/);
  });
});

describe('the framework\'s heartbeat', () => {
  it('offers the tools under heartbeat--, routes their calls, delivers a tick as a wake, and lists its wakes for the judge', async (t) => {
    mock.timers.reset();
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane, createMockResponse } = await import('./helpers/mock-membrane.js');
    const membrane = new MockMembrane();
    // Its own directory, removed once it has stopped: afterEach runs before t.after.
    const own = mkdtempSync(join(tmpdir(), 'heartbeat-fw-'));
    const framework = await AgentFramework.create({
      storePath: join(own, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      modules: [],
      heartbeat: { defaults: { intervalSeconds: 3600 } },
    });
    t.after(async () => { await framework.stop(); rmSync(own, { recursive: true, force: true }); });
    // Its own start, as framework.start() does: the loop that start() also
    // runs would race runUntilIdle here.
    (framework as unknown as { heartbeat: { start(): void } }).heartbeat.start();
    const names = framework.getAllTools().map((tool) => tool.name).filter((n) => n.startsWith('heartbeat--'));
    assert.deepEqual(names, [
      'heartbeat--heartbeat_status', 'heartbeat--heartbeat_configure', 'heartbeat--heartbeat_trigger',
      'heartbeat--reminder_add', 'heartbeat--reminder_list', 'heartbeat--reminder_cancel',
    ]);
    // A call through the agent's turn reaches the heartbeat.
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'st', name: 'heartbeat--heartbeat_status', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    assert.equal(framework.nudgeAgent('scout').ok, true);
    await framework.runUntilIdle();
    const [round] = membrane.lastStream!.receivedToolResults as Array<Array<{ content: string; isError: boolean }>>;
    assert.equal(round![0]!.isError, false, round![0]!.content);
    assert.match(round![0]!.content, /^Heartbeat ACTIVE \| mode=message \| interval=3600s/);
    // A tick stores its prompt and wakes the agent, which reads it in that turn.
    const internals = framework as unknown as {
      heartbeat: { handleToolCall(name: string, input: unknown): { success: boolean } };
      pendingRequests: Array<{ agentName: string; reason: string; source: string }>;
    };
    assert.equal(internals.heartbeat.handleToolCall('heartbeat--heartbeat_trigger', {}).success, true);
    assert.deepEqual(internals.pendingRequests.map((r) => [r.agentName, r.reason, r.source]), [['scout', 'heartbeat', 'heartbeat']]);
    const before = membrane.calls.length;
    membrane.pushResponse(createMockResponse([]));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, before + 1, 'the tick woke the agent for a turn');
    const text = membrane.calls.at(-1)!.messages.flatMap((m) => m.content).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    assert.match(text, /\[current time: .*\] \[heartbeat\] Periodic self-check-in/);
    const upcoming = (framework as unknown as { upcomingWakesFor(n: string): Array<{ what: string }> }).upcomingWakesFor('scout');
    assert.ok(upcoming.some((w) => w.what === 'its heartbeat (a check-in prompt, every 60 min)'), JSON.stringify(upcoming));
  });

  it('delivers a silent tick as a silent-heartbeat wake with prose suppressed, storing no prompt', async (t) => {
    mock.timers.reset();
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane } = await import('./helpers/mock-membrane.js');
    const own = mkdtempSync(join(tmpdir(), 'heartbeat-fw-'));
    const framework = await AgentFramework.create({
      storePath: join(own, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 's', proseRouting: 'disabled' }],
      modules: [],
      heartbeat: { defaults: { deliveryMode: 'silent' } },
    });
    t.after(async () => { await framework.stop(); rmSync(own, { recursive: true, force: true }); });
    const internals = framework as unknown as {
      heartbeat: { start(): void; handleToolCall(name: string, input: unknown): { success: boolean } };
      pendingRequests: Array<{ agentName: string; reason: string; suppressProse?: boolean; silentHeartbeat?: { eventId: string; serverId: string } }>;
    };
    internals.heartbeat.start();
    internals.heartbeat.handleToolCall('heartbeat--heartbeat_trigger', {});
    const [req] = internals.pendingRequests;
    assert.equal(req!.suppressProse, true);
    assert.equal(req!.silentHeartbeat!.serverId, 'heartbeat');
    assert.match(req!.silentHeartbeat!.eventId, /^heartbeat_/);
  });

  it('refuses heartbeat-mcpl beside it, by its id, a tool prefix like its own, or the command that runs it', async () => {
    mock.timers.reset();
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane } = await import('./helpers/mock-membrane.js');
    for (const server of [
      { id: 'heartbeat', command: 'node', args: ['nothing.js'] },
      { id: 'hb', command: 'node', args: ['x.js'], toolPrefix: 'mcpl--heartbeat' },
      { id: 'ticks', command: 'node', args: ['/opt/heartbeat-mcpl/dist/src/index.js', '--stdio'] },
    ]) {
      await assert.rejects(AgentFramework.create({
        storePath: join(dir, `store-${server.id}`),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 's', proseRouting: 'disabled' }],
        modules: [],
        heartbeat: true,
        mcplServers: [server],
      }), new RegExp(`beside the MCPL server "${server.id}", which is heartbeat-mcpl or names its tools as the heartbeat's`));
    }
  });

  it("starts and stops with the framework, and refuses a fork's change while showing it the schedule", async (t) => {
    mock.timers.reset();
    const { AgentFramework } = await import('../src/index.js');
    const { MockMembrane } = await import('./helpers/mock-membrane.js');
    const own = mkdtempSync(join(tmpdir(), 'heartbeat-fw-'));
    const framework = await AgentFramework.create({
      storePath: join(own, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 's', proseRouting: 'disabled' }],
      modules: [],
      heartbeat: true,
    });
    t.after(() => rmSync(own, { recursive: true, force: true }));
    const internals = framework as unknown as {
      heartbeat: { started: boolean; cancelTick: unknown };
      conversationAgentHomes: Map<string, unknown>;
      pushEvent(event: { type: string; result?: { isError?: boolean; error?: string; data?: unknown } }): void;
      dispatchHeartbeatToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
    };
    await framework.start();
    assert.equal(internals.heartbeat.started, true);
    assert.ok(internals.heartbeat.cancelTick, 'its tick is armed');
    assert.ok(existsSync(join(own, 'store', 'config', 'heartbeat.json')));
    const results: Array<{ isError?: boolean; error?: string; data?: unknown }> = [];
    const push = internals.pushEvent.bind(framework);
    internals.pushEvent = (event) => { if (event.type === 'tool-result') results.push(event.result!); else push(event); };
    internals.conversationAgentHomes.set('scout-conv-1', {});
    internals.dispatchHeartbeatToolCall('scout-conv-1', { id: 'a', name: 'heartbeat--reminder_add', input: { message: 'x', inMinutes: 1 } });
    internals.dispatchHeartbeatToolCall('scout-conv-1', { id: 'b', name: 'heartbeat--heartbeat_status', input: {} });
    internals.conversationAgentHomes.delete('scout-conv-1');
    assert.equal(results[0]!.isError, true);
    assert.match(String(results[0]!.error), /Nothing was changed: the heartbeat and its reminders are the agent's, and wake its residents, so this conversation can't change them/);
    assert.equal(results[1]!.isError, undefined);
    assert.match(String(results[1]!.data), /^Heartbeat ACTIVE/);
    await framework.stop();
    assert.equal(internals.heartbeat.started, false);
    assert.equal(internals.heartbeat.cancelTick, null, 'its tick is cleared');
  });
});
