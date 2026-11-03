/**
 * Event suppression end to end: a suppress rule's events are stored with the
 * record, never rendered (compile, tool-boundary injection), never woken
 * for, and counted by suppression_stats; the rule is edited with
 * wake_add_rule / wake_remove_rule, and an edit changes only what arrives
 * after it.
 *
 * Harness: the RFC-006 loopback MCPL server (server id "editor") and a
 * mocked model, the event loop driven explicitly (admission helpers).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, TS } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { WorkspaceModule } from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMockResponse } from './helpers/mock-membrane.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/types/index.js';
import { type Stored, textOf, stored, find, has, internals, MENTION, incoming, registerOpen, settle, blockInTool } from './helpers/admission.js';
import { eventually } from './helpers/coalescing-fixture.js';
import { GateModule } from './helpers/dendrite.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const suppressedOf = (m: Stored): unknown => (m.metadata as { suppressed?: unknown } | undefined)?.suppressed;
const compiledTexts = async (f: Fixture): Promise<string[]> =>
  (await f.framework.getAgent('agent')!.getContextManager().compile()).messages.map((m) => textOf(m as Stored));
const inView = async (f: Fixture, text: string) => (await compiledTexts(f)).some((t) => t.includes(text));
const tool = (f: Fixture, name: string, input: Record<string, unknown>) =>
  f.framework.executeToolCall({ id: `c-${name}-${Math.random().toString(36).slice(2)}`, name, input, callerAgentName: 'agent' } as ToolCall);

/** A push event from the loopback server, not addressed, on no channel. */
const ping = (f: Fixture, eventId: string, text: string, tags = ['chat:ambient']) => f.send('push/event', {
  featureSet: 'doc', eventId, timestamp: TS, payload: { content: [{ type: 'text', text }] }, origin: { source: 'editor' }, tags,
});

/** A module whose `notes:new` events each add one message and ask for a wake. */
class NotesModule implements Module {
  readonly name = 'notes';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'none', isError: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    const e = event as { type: string; content?: string };
    if (e.type !== 'notes:new') return {};
    return { addMessages: [{ participant: 'user', content: [{ type: 'text', text: String(e.content) }] }], requestInference: true };
  }
}

/** A host module that writes a row of its own for a server's push event. */
class EchoPushes implements Module {
  readonly name = 'echo-pushes';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'none', isError: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return (event as { type: string }).type === 'mcpl:push-event' ? { addMessages: [{ participant: 'user', content: [{ type: 'text', text: 'echoed by a module' }] }] } : {};
  }
}

/** A module that only asks for a wake on `notes:new`, as a second module answering the same event might. */
class WakeOnNotes implements Module {
  readonly name = 'wake-on-notes';
  handled = 0;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'none', isError: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if ((event as { type: string }).type !== 'notes:new') return {};
    this.handled++;
    return { requestInference: true };
  }
}

// A generous script timeout, so a loaded CI machine doesn't fail a script that answers.
const GATE = (policies: unknown[] = []) => ({ gate: { onboarding: false, suppressScriptTimeoutMs: 2_000, config: { default: 'always', policies } } }) as Partial<FrameworkConfig>;
const S = (description: string) => ({ description });
const HIDE_NOISY = { name: 'hide-noisy', match: { source: 'editor', channel: 'noisy' }, behavior: 'defer', suppress: S('chatter in #noisy') };

describe('event suppression', () => {
  it('a suppressed channel message is stored with its record, never rendered or woken for; an addressed one in the same channel is', async () => {
    const f = await fixture({ framework: GATE([HIDE_NOISY]) });
    try {
      await registerOpen(f, 'noisy');
      await incoming(f, 'noisy', 'n1', 'noise one');
      await settle(f);
      const row = find(f, 'noise one');
      assert.deepEqual(suppressedOf(row), { rule: 'hide-noisy', eventType: 'mcpl:channel-incoming', source: 'editor' });
      assert.equal(await inView(f, 'noise one'), false, 'not in the compiled view');

      await incoming(f, 'noisy', 'n2', 'agent, look at this', MENTION);
      await f.turn();
      assert.equal(suppressedOf(find(f, 'agent, look')), undefined, 'an addressed message is never suppressed');
      assert.equal(await inView(f, 'agent, look'), true);
      const lastRequest = f.lastRequest();
      assert.ok(lastRequest.includes('agent, look'), 'the wake sent the mention');
      assert.ok(!lastRequest.includes('noise one'), 'and not the suppressed message');

      const status = (await tool(f, 'gate_status', {})).data as { policies: Array<{ name: string; matchCount: number; suppress?: unknown }> };
      const rule = status.policies.find((p) => p.name === 'hide-noisy')!;
      assert.deepEqual(rule.suppress, { description: 'chatter in #noisy' });
      assert.equal(rule.matchCount, 1, 'gate_status counts what it suppressed since start');
    } finally { await f.close(); }
  });

  it('a suppressed message arriving mid-turn is stored, not injected into the live turn; one not suppressed is', async () => {
    const gate = new GateModule();
    const f = await fixture({ framework: { ...GATE([HIDE_NOISY]), modules: [gate] } });
    try {
      await registerOpen(f, 'work', 'noisy');
      const { loop } = await blockInTool(f, gate);
      await incoming(f, 'noisy', 'n1', 'hidden while acting');
      await incoming(f, 'work', 'w2', 'shown while acting');
      const arrived = (text: string) => () =>
        internals(f).deferredMessages.some((m) => textOf(m as Stored).includes(text)) || has(f, text);
      await eventually(arrived('hidden while acting'), 'the suppressed message arrived');
      await eventually(arrived('shown while acting'), 'the control arrived');
      f.alwaysRespond();
      gate.release('g1');
      await loop;
      assert.ok(suppressedOf(find(f, 'hidden while acting')), 'stored with the suppression record');
      const injected = f.membrane.calls.length > 0
        ? (f.membrane.lastStream?.receivedToolResultOptions ?? []).flatMap((o) => o?.injectedMessages ?? []).map((m) => JSON.stringify(m.content))
        : [];
      assert.ok(injected.some((t) => t.includes('shown while acting')), 'control: the message not suppressed was injected');
      assert.ok(!injected.some((t) => t.includes('hidden while acting')), 'the live turn never saw the suppressed one');
      assert.equal(await inView(f, 'hidden while acting'), false, 'nor does the next compile');
    } finally { await f.close(); }
  });

  it('a suppressed push event wakes nobody, and leaves no clock row behind', async () => {
    const f = await fixture({
      framework: GATE([{ name: 'hide-pings', match: { scope: ['mcpl:push-event'], filter: { type: 'text', pattern: 'ping' } }, behavior: 'defer', suppress: S('pings') }]),
    });
    try {
      const before = stored(f).length;
      await ping(f, 'p1', 'ping 1');
      await settle(f);
      const rows = stored(f).slice(before);
      assert.deepEqual(rows.map((m) => textOf(m)), ['ping 1'], 'one row stored, and nothing ahead of it');
      assert.deepEqual(suppressedOf(rows[0]), { rule: 'hide-pings', eventType: 'mcpl:push-event', source: 'editor' });
      assert.equal(await inView(f, 'ping 1'), false);

      // An event the rule doesn't match still wakes (default "always").
      await ping(f, 'p2', 'hello there');
      await f.turn();
      assert.equal(await inView(f, 'hello there'), true);
    } finally { await f.close(); }
  });

  it('a module\'s event is suppressed with all its messages, and its wake is not queued', async () => {
    const f = await fixture({
      framework: { ...GATE([{ name: 'hide-notes', match: { scope: ['notes:new'], filter: { type: 'regex', pattern: '^chatter' } }, behavior: 'defer', suppress: S('chatter notes') }]), modules: [new NotesModule()] },
    });
    try {
      f.framework.pushEvent({ type: 'notes:new', source: 'notes', content: 'chatter: nothing to see' } as unknown as ProcessEvent);
      await settle(f);
      assert.deepEqual(suppressedOf(find(f, 'chatter: nothing')), { rule: 'hide-notes', eventType: 'notes:new', source: 'notes' });
      assert.equal(await inView(f, 'chatter: nothing'), false);

      f.framework.pushEvent({ type: 'notes:new', source: 'notes', content: 'important: read me' } as unknown as ProcessEvent);
      await f.turn();
      assert.equal(await inView(f, 'important: read me'), true);
    } finally { await f.close(); }
  });

  it('a second module that only asks for a wake on a suppressed event wakes nobody, whichever answers first', async () => {
    const rule = { name: 'hide-notes', match: { scope: ['notes:new'] }, behavior: 'defer', suppress: S('every note') };
    for (const first of [true, false]) {
      const waker = new WakeOnNotes();
      const modules = first ? [waker, new NotesModule()] : [new NotesModule(), waker];
      const f = await fixture({ framework: { ...GATE([rule]), modules } });
      try {
        f.framework.pushEvent({ type: 'notes:new', source: 'notes', content: 'a hidden note' } as unknown as ProcessEvent);
        await settle(f);
        assert.equal(waker.handled, 1, 'the wake-only module answered');
        assert.ok(suppressedOf(find(f, 'a hidden note')));
        const stats = (await tool(f, 'suppression_stats', {})).data as { rules: Array<{ bySource: Record<string, number> }> };
        assert.deepEqual(stats.rules[0].bySource, { notes: 1 }, 'a module\'s row is counted under its source');
      } finally { await f.close(); }
    }
  });

  it('API input is never suppressed, and a suppress rule doesn\'t defer its wake; nor a tagged addressed module event', async () => {
    const f = await fixture({ framework: { ...GATE([
      { name: 'hide-api', match: { scope: ['api:message'] }, behavior: 'defer', suppress: S('api chatter') },
      { name: 'hide-notes', match: { scope: ['notes:new'] }, behavior: 'defer', suppress: S('every note') },
    ]), modules: [new NotesModule()] } });
    try {
      const gate = (f.framework as unknown as { eventGate: { evaluate(i: unknown): { trigger: boolean } } }).eventGate;
      assert.equal(gate.evaluate({ content: 'hi', eventType: 'api:message', serverId: 'api', channelId: '', suppressionAsked: true }).trigger, true);
      f.framework.pushEvent({ type: 'notes:new', source: 'notes', content: 'a note for you', tags: ['chat:addressed'] } as unknown as ProcessEvent);
      await f.turn();
      assert.equal(suppressedOf(find(f, 'a note for you')), undefined, 'an addressed module event isn\'t suppressed');
      assert.equal(await inView(f, 'a note for you'), true);
    } finally { await f.close(); }
  });

  it('a module reading a suppressed row is told it\'s held from the residents', async () => {
    const { asModuleRow } = await import('../src/held-writes.js');
    assert.equal(asModuleRow({ metadata: { suppressed: { rule: 'r', eventType: 'x' } } }).heldFromResidents, true);
    assert.equal(asModuleRow({ metadata: {} }).heldFromResidents, undefined);
  });

  it('a response that only wakes an agent it names isn\'t decided: the named wake stands', async () => {
    class NamedWake extends WakeOnNotes {
      override async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
        return (event as { type: string }).type === 'notes:new' ? { requestInference: ['agent'] } : {};
      }
    }
    const f = await fixture({ framework: { ...GATE([{ name: 'hide-notes', match: { scope: ['notes:new'] }, behavior: 'defer', suppress: S('every note') }]), modules: [new NamedWake()] } });
    try {
      const before = f.membrane.calls.length;
      f.framework.pushEvent({ type: 'notes:new', source: 'notes' } as unknown as ProcessEvent);
      await f.turn();
      assert.ok(f.membrane.calls.length > before, 'the agent it named was woken');
    } finally { await f.close(); }
  });

  it('a server\'s [toolsets] notice is suppressed as its "mcpl:tool-changes" event', async () => {
    const f = await fixture({ framework: GATE([{ name: 'hide-tool-flaps', match: { source: 'editor', scope: ['mcpl:tool-changes'] }, behavior: 'defer', suppress: S('tool flaps') }]) });
    try {
      const told = (f.framework as unknown as { recordToolsetNotice(serverId: string, text: string, opts: { invite: boolean }): boolean })
        .recordToolsetNotice('editor', 'eye: left your tool list', { invite: false });
      assert.equal(told, true);
      const row = find(f, 'eye: left your tool list');
      assert.deepEqual(suppressedOf(row), { rule: 'hide-tool-flaps', eventType: 'mcpl:tool-changes', source: 'editor' });
      assert.equal(await inView(f, 'eye: left your tool list'), false);
    } finally { await f.close(); }
  });

  it('wake_add_rule adds a suppress rule (saved with behavior "defer"); wake_remove_rule stops it for what arrives next, and what it hid stays hidden', async () => {
    const f = await fixture({ framework: GATE() });
    try {
      await registerOpen(f, 'noisy');
      const refused = await tool(f, 'wake_add_rule', { name: 'x', match: { channel: 'noisy' }, suppress: S('noise'), debounceMs: 1000 });
      assert.equal(refused.isError, true);
      assert.match(String(refused.error), /suppress with debounceMs/);
      const loud = await tool(f, 'wake_add_rule', { name: 'x', match: { channel: 'noisy' }, suppress: S('noise'), behavior: 'always' });
      assert.equal(loud.isError, true);
      assert.match(String(loud.error), /suppress with behavior "always"/);
      const undescribed = await tool(f, 'wake_add_rule', { name: 'x', match: { channel: 'noisy' }, suppress: true });
      assert.equal(undescribed.isError, true);
      assert.match(String(undescribed.error), /suppress is true, where an object/);
      const loose = await tool(f, 'wake_add_rule', { name: 'x', match: { channel: 'noisy' }, script: '() => true', suppress: S('noise') });
      assert.equal(loose.isError, true);
      assert.match(String(loose.error), /"script", a field of "suppress".*Put it in "suppress"/, 'a suppress field given on its own is refused, naming where it goes');
      const everything = await tool(f, 'wake_add_rule', { name: 'x', suppress: S('everything') });
      assert.equal(everything.isError, true);
      assert.match(String(everything.error), /names nothing it hides/);

      const added = await tool(f, 'wake_add_rule', { name: 'hide-noisy', match: { channel: 'noisy' }, suppress: S('chatter in #noisy') });
      assert.equal(added.success, true, String(added.error));
      const gateJson = JSON.parse(readFileSync(join(f.dir, 'store', 'config', 'gate.json'), 'utf-8')) as { policies: unknown[] };
      assert.deepEqual(gateJson.policies, [{ name: 'hide-noisy', match: { channel: 'noisy' }, behavior: 'defer', suppress: { description: 'chatter in #noisy' } }]);

      await incoming(f, 'noisy', 'n1', 'before removal');
      await settle(f);
      assert.ok(suppressedOf(find(f, 'before removal')));

      const removed = await tool(f, 'wake_remove_rule', { name: 'hide-noisy' });
      assert.equal(removed.success, true);
      await incoming(f, 'noisy', 'n2', 'after removal');
      await f.turn();
      assert.equal(suppressedOf(find(f, 'after removal')), undefined);
      const texts = await compiledTexts(f);
      assert.ok(texts.some((t) => t.includes('after removal')), 'what arrives after the removal renders');
      assert.ok(!texts.some((t) => t.includes('before removal')), 'what the rule hid stays hidden');
    } finally { await f.close(); }
  });

  it('suppression_stats counts the stored rows per rule, across rules removed since, with previews', async () => {
    const f = await fixture({ framework: GATE([
      HIDE_NOISY,
      { name: 'hide-pings', match: { scope: ['mcpl:push-event'], filter: { type: 'text', pattern: 'ping' } }, behavior: 'defer', suppress: S('pings') },
      { name: 'unused', match: { source: 'nobody' }, behavior: 'defer', suppress: S('nothing yet') },
    ]) });
    try {
      await registerOpen(f, 'noisy');
      await incoming(f, 'noisy', 'n1', 'noise one');
      await incoming(f, 'noisy', 'n2', 'noise two');
      await ping(f, 'p1', 'ping 1');
      await settle(f);
      await tool(f, 'wake_remove_rule', { name: 'hide-pings' });

      const result = await tool(f, 'suppression_stats', { recent: 1 });
      assert.equal(result.success, true, String(result.error));
      const data = result.data as {
        total: number; branch: string;
        rules: Array<{ rule: string; inForce: boolean; suppressed: number; sinceStart?: number; bySource: Record<string, number>; recent: Array<{ preview: string; channel?: string }> }>;
      };
      assert.equal(data.total, 3);
      assert.equal(typeof data.branch, 'string');
      assert.deepEqual(data.rules.map((r) => [r.rule, r.inForce, r.suppressed]), [['hide-noisy', true, 2], ['unused', true, 0], ['hide-pings', false, 1]]);
      const noisy = data.rules[0];
      assert.equal(noisy.sinceStart, 2);
      assert.deepEqual(noisy.bySource, { editor: 2 });
      assert.equal(noisy.recent.length, 1);
      assert.match(noisy.recent[0].preview, /noise two/, 'the newest');
      assert.equal(noisy.recent[0].channel, 'noisy');

      const one = await tool(f, 'suppression_stats', { rule: 'hide-pings' });
      assert.deepEqual((one.data as { rules: Array<{ rule: string }> }).rules.map((r) => r.rule), ['hide-pings']);
      const bad = await tool(f, 'suppression_stats', { since: 'yesterday-ish' });
      assert.equal(bad.isError, true);
      assert.match(String(bad.error), /since is "yesterday-ish"/);
    } finally { await f.close(); }
  });

  it('a rule\'s own script decides with state it keeps: the first ping shows and wakes, the ones after it are hidden without a wake', async () => {
    const script = '(event, state) => { if (event.at - (state.shown ?? 0) < 600000) return true; state.shown = event.at; return false; }';
    const f = await fixture({ framework: GATE([
      { name: 'one-ping-a-while', match: { scope: ['mcpl:push-event'], filter: { type: 'text', pattern: 'ping' } }, behavior: 'defer', suppress: { description: 'repeated pings', script } },
    ]) });
    try {
      await ping(f, 'p1', 'ping 1');
      await f.turn();
      assert.equal(suppressedOf(find(f, 'ping 1')), undefined, 'the first is shown');
      assert.equal(await inView(f, 'ping 1'), true);
      await ping(f, 'p2', 'ping 2');
      await ping(f, 'p3', 'ping 3');
      await settle(f);
      assert.deepEqual(suppressedOf(find(f, 'ping 2')), { rule: 'one-ping-a-while', eventType: 'mcpl:push-event', source: 'editor' });
      assert.ok(suppressedOf(find(f, 'ping 3')));
      const status = (await tool(f, 'gate_status', {})).data as { policies: Array<{ name: string; matchCount: number; suppress?: { scriptStatus?: { runs: number; hidden: number } } }> };
      assert.equal(status.policies[0].matchCount, 2);
      assert.deepEqual([status.policies[0].suppress?.scriptStatus?.runs, status.policies[0].suppress?.scriptStatus?.hidden], [3, 2]);

      const broken = await tool(f, 'wake_add_rule', { name: 'bad', match: { source: 'editor' }, suppress: { description: 'x', script: '"not a function"' } });
      assert.equal(broken.isError, true);
      assert.match(String(broken.error), /suppress\.script can't be used \(the script is string, not a function/);
      const added = await tool(f, 'wake_add_rule', { name: 'shouty', match: { source: 'editor' }, suppress: { description: 'all caps', script: '(e) => e.text === e.text.toUpperCase()' } });
      assert.equal(added.success, true, String(added.error));
    } finally { await f.close(); }
  });

  it('dump_suppressed writes the hidden events, whole, to a workspace file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-suppressed-'));
    const workspace = new WorkspaceModule({ mounts: [{ name: 'notes', path: dir, mode: 'read-write', watch: 'never' }] });
    const f = await fixture({ framework: { ...GATE([HIDE_NOISY]), modules: [workspace] } });
    // The host creates the workspace's mounts once the store is open, as connectome-host does.
    workspace.initStore(f.framework.getStore());
    try {
      await registerOpen(f, 'noisy');
      await incoming(f, 'noisy', 'n1', 'noise one');
      await incoming(f, 'noisy', 'n2', 'noise two, which is the longer of the two');
      await settle(f);
      const none = await tool(f, 'dump_suppressed', { rule: 'nothing-by-this-name' });
      assert.equal(none.success, true);
      assert.equal((none.data as { written: number }).written, 0);

      const text = await tool(f, 'dump_suppressed', { path: 'notes/hidden.txt' });
      assert.equal(text.success, true, String(text.error));
      const data = text.data as { path: string; written: number; byRule: Record<string, number>; format: string };
      assert.deepEqual([data.path, data.written, data.byRule, data.format], ['notes/hidden.txt', 2, { 'hide-noisy': 2 }, 'text']);
      const read = await tool(f, 'workspace--read', { path: 'notes/hidden.txt' });
      const body = JSON.stringify(read.data ?? read);
      assert.match(body, /Suppressed events/);
      assert.match(body, /noise one/);
      assert.match(body, /noise two, which is the longer of the two/);

      const jsonl = await tool(f, 'dump_suppressed', { format: 'jsonl', rule: 'hide-noisy' });
      assert.equal(jsonl.success, true, String(jsonl.error));
      assert.match((jsonl.data as { path: string }).path, /^notes\/suppressed\/hide-noisy-\d{8}T\d{9}Z\.jsonl$/, 'a default path in the first writable mount');
      const bad = await tool(f, 'dump_suppressed', { format: 'csv' });
      assert.equal(bad.isError, true);
    } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('the suppression review asks the model about what a rule hid, and a flag is told to the resident with a wake', async () => {
    const f = await fixture({ framework: GATE([HIDE_NOISY]) });
    try {
      await registerOpen(f, 'noisy');
      await incoming(f, 'noisy', 'n1', 'just chatter');
      await incoming(f, 'noisy', 'n2', 'agent are you there? the build is on fire');
      await settle(f);
      // A review covers [from, now): a row stored in the very millisecond it
      // starts is the next review's, so the rows are given that millisecond.
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Only the review's answer queued: the fixture's first scripted turn isn't needed.
      f.membrane.responses.length = 0;
      (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '{"fits": false, "flagged": [2], "note": "one asks the agent for help"}' }]));
      const before = f.membrane.calls.length;
      const summary = await f.framework.reviewSuppression();
      assert.ok(summary, 'a review ran');
      assert.equal(summary!.total, 2);
      assert.equal(summary!.flagged, 1);
      const asked = JSON.stringify(f.membrane.calls.slice(before));
      assert.match(asked, /chatter in #noisy/, 'judged against the rule\'s description');
      assert.match(asked, /claude-haiku-5-5/);
      const notice = find(f, '[suppression review]');
      assert.equal((notice.metadata as { kind?: string }).kind, 'suppression-review');
      assert.equal(suppressedOf(notice), undefined, 'the review\'s notice is never suppressed');
      assert.match(textOf(notice), /flagged 1: one asks the agent for help/);
      assert.match(textOf(notice), /the build is on fire/);
      assert.ok(internals(f).pendingRequests.some((r) => r.agentName === 'agent' && r.reason === 'suppression-review'), 'the flag wakes the resident');
      assert.equal(await inView(f, '[suppression review]'), true);
    } finally { await f.close(); }
  });

  it('a deferred coalesced push is decided once, at its wake, and its row reads that decision', async () => {
    const counting = { name: 'count', match: { source: 'editor', scope: ['mcpl:push-event'] }, behavior: 'defer',
      suppress: { description: 'counts', script: '(e, state) => { state.n = (state.n ?? 0) + 1; return false; }' } };
    const f = await fixture({ framework: GATE([counting]) });
    try {
      await f.send('push/event', f.params('1', 'fallback', { deferred: true }));
      await f.framework.runUntilIdle();
      assert.ok(f.context().includes('document_diff'), 'rendered at assembly and shown, as the one decision said');
      const gate = (f.framework as unknown as { eventGate: { suppressScriptState(name: string): unknown } }).eventGate;
      assert.deepEqual(gate.suppressScriptState('count'), { n: 1 }, 'the script was asked once');
    } finally { await f.close(); }
  });

  it('a deferred coalesced push suppressed at its wake is stored now, stamped, and wakes nobody', async () => {
    const f = await fixture({ framework: GATE([{ name: 'hide-doc', match: { source: 'editor', scope: ['mcpl:push-event'] }, behavior: 'defer', suppress: S('document notices') }]) });
    try {
      await f.send('push/event', f.params('1', 'fallback', { deferred: true }));
      await eventually(() => stored(f).some((m) => textOf(m).includes('document_diff')), 'the batch stored');
      await settle(f);
      assert.deepEqual(suppressedOf(find(f, 'document_diff')), { rule: 'hide-doc', eventType: 'mcpl:push-event', source: 'editor' });
      assert.equal(await inView(f, 'document_diff'), false);
    } finally { await f.close(); }
  });

  it('a coalesced batch follows its latest occurrence, as its wake does: each occurrence is asked once', async () => {
    const second = { name: 'second', match: { source: 'editor', scope: ['mcpl:push-event'] }, behavior: 'defer',
      suppress: { description: 'the second of each pair', script: '(e, state) => { state.n = (state.n ?? 0) + 1; return state.n === 2; }' } };
    const f = await fixture({ framework: GATE([second]) });
    try {
      await f.send('push/event', f.params('1', 'fallback', { deferred: true }));
      await f.send('push/event', f.params('2', 'fallback', { deferred: true }));
      await eventually(() => stored(f).some((m) => textOf(m).includes('document_diff')), 'the batch stored');
      await settle(f);
      assert.ok(suppressedOf(find(f, 'document_diff')), 'its latest occurrence was hidden, so the batch is, and nothing woke for it');
      const gate = (f.framework as unknown as { eventGate: { suppressScriptState(name: string): unknown } }).eventGate;
      assert.deepEqual(gate.suppressScriptState('second'), { n: 2 }, 'each occurrence asked once');
    } finally { await f.close(); }
  });

  it('a batch holding an addressed occurrence is shown, whatever comes after it', async () => {
    const f = await fixture({ framework: GATE([{ name: 'hide-doc', match: { source: 'editor', scope: ['mcpl:push-event'] }, behavior: 'defer', suppress: S('document notices') }]) });
    try {
      f.alwaysRespond();
      await f.send('push/event', { ...f.params('1', 'fallback', { deferred: true }), tags: ['chat:mention', 'chat:addressed'] });
      await f.send('push/event', f.params('2', 'fallback', { deferred: true }));
      await f.framework.runUntilIdle();
      assert.ok(f.context().includes('document_diff'), 'stored at the turn the batch\'s wake started');
      assert.equal(suppressedOf(find(f, 'document_diff')), undefined);
      assert.equal(await inView(f, 'document_diff'), true);
    } finally { await f.close(); }
  });

  it('a plain occurrence that displaces a deferred batch the rule let by is asked on its own text', async () => {
    const f = await fixture({ framework: GATE([{ name: 'hide-pings', match: { scope: ['mcpl:push-event'], filter: { type: 'text', pattern: 'ping' } }, behavior: 'defer', suppress: S('pings') }]) });
    try {
      f.alwaysRespond();
      await f.send('push/event', f.params('1', 'hello one', { deferred: true }));
      await f.send('push/event', f.params('2', 'ping two'));
      await f.framework.runUntilIdle();
      assert.deepEqual(suppressedOf(find(f, 'ping two')), { rule: 'hide-pings', eventType: 'mcpl:push-event', source: 'editor' });
      assert.equal(await inView(f, 'ping two'), false);
    } finally { await f.close(); }
  });

  it('a module\'s row answering a suppressed server event is stamped with the server as its source', async () => {
    const f = await fixture({ framework: { ...GATE([{ name: 'hide-pings', match: { scope: ['mcpl:push-event'], filter: { type: 'text', pattern: 'ping' } }, behavior: 'defer', suppress: S('pings') }]), modules: [new EchoPushes()] } });
    try {
      await ping(f, 'p1', 'ping 1');
      await settle(f);
      assert.deepEqual(suppressedOf(find(f, 'echoed by a module')), { rule: 'hide-pings', eventType: 'mcpl:push-event', source: 'editor' });
      assert.equal(await inView(f, 'echoed by a module'), false);
    } finally { await f.close(); }
  });
});
