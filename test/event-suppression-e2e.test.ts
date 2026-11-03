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

const GATE = (policies: unknown[] = []) => ({ gate: { onboarding: false, config: { default: 'always', policies } } }) as Partial<FrameworkConfig>;
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
      assert.deepEqual(suppressedOf(row), { rule: 'hide-noisy', eventType: 'mcpl:channel-incoming' });
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
      assert.deepEqual(suppressedOf(rows[0]), { rule: 'hide-pings', eventType: 'mcpl:push-event' });
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
      assert.deepEqual(suppressedOf(find(f, 'chatter: nothing')), { rule: 'hide-notes', eventType: 'notes:new' });
      assert.equal(await inView(f, 'chatter: nothing'), false);

      f.framework.pushEvent({ type: 'notes:new', source: 'notes', content: 'important: read me' } as unknown as ProcessEvent);
      await f.turn();
      assert.equal(await inView(f, 'important: read me'), true);
    } finally { await f.close(); }
  });

  it('a server\'s [toolsets] notice is suppressed as its "mcpl:tool-changes" event', async () => {
    const f = await fixture({ framework: GATE([{ name: 'hide-tool-flaps', match: { source: 'editor', scope: ['mcpl:tool-changes'] }, behavior: 'defer', suppress: S('tool flaps') }]) });
    try {
      const told = (f.framework as unknown as { recordToolsetNotice(serverId: string, text: string, opts: { invite: boolean }): boolean })
        .recordToolsetNotice('editor', 'eye: left your tool list', { invite: false });
      assert.equal(told, true);
      const row = find(f, 'eye: left your tool list');
      assert.deepEqual(suppressedOf(row), { rule: 'hide-tool-flaps', eventType: 'mcpl:tool-changes' });
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
      assert.match(String(everything.error), /matches every event/);

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
      assert.deepEqual(suppressedOf(find(f, 'ping 2')), { rule: 'one-ping-a-while', eventType: 'mcpl:push-event' });
      assert.ok(suppressedOf(find(f, 'ping 3')));
      const status = (await tool(f, 'gate_status', {})).data as { policies: Array<{ name: string; matchCount: number; suppress?: { scriptStatus?: { runs: number; hidden: number } } }> };
      assert.equal(status.policies[0].matchCount, 2);
      assert.deepEqual([status.policies[0].suppress?.scriptStatus?.runs, status.policies[0].suppress?.scriptStatus?.hidden], [3, 2]);

      const broken = await tool(f, 'wake_add_rule', { name: 'bad', match: { source: 'editor' }, suppress: { description: 'x', script: '"not a function"' } });
      assert.equal(broken.isError, true);
      assert.match(String(broken.error), /suppress\.script doesn't make a function \(the script is string, not a function/);
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
      assert.match((jsonl.data as { path: string }).path, /^notes\/suppressed\/hide-noisy-\d{8}T\d{6}Z\.jsonl$/, 'a default path in the first writable mount');
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
});
