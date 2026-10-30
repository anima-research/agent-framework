import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { fixture } from './helpers/coalescing-fixture.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';
import { AgentFramework, WorkspaceModule } from '../src/index.js';
import type { Module, ModuleContext, ProcessEvent, ToolResult } from '../src/index.js';

const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

async function setup(t: { after(fn: () => unknown): void }, opts: { presentation?: boolean } = {}) {
  let ctx: { callTool(call: unknown): Promise<ToolResult> } | undefined;
  const probe = {
    name: 'probe',
    async start(c: typeof ctx) { ctx = c; },
    async stop() {},
    getTools() { return []; },
    async handleToolCall() { return { success: false, error: 'no tools', isError: true }; },
    async onProcess() { return {}; },
  };
  const mount = mkdtempSync(join(tmpdir(), 'awaited-routes-'));
  const workspace = new WorkspaceModule({ mounts: [{ name: 'work', path: mount, mode: 'read-write', watch: 'never' }] });
  const f = await fixture({
    agents: [{
      name: 'agent', model: 'test', systemPrompt: 'test', proseRouting: 'explicit',
      ...(opts.presentation ? { toolPresentation: { path: join(mount, 'tools.json'), cataloguePath: 'work/tools.md' } } : {}),
    }],
    framework: { modules: [probe, workspace], gate: { config: { policies: [], default: 'skip' } } } as never,
  });
  t.after(async () => { await f.close(); rmSync(mount, { recursive: true, force: true }); });
  const internals = f.framework as unknown as { pushEvent(event: unknown): void; dispatchToolCall(agent: string, call: unknown): void };
  const viaModel = (id: string, name: string, input: unknown) => new Promise<ToolResult>((resolve) => {
    const original = internals.pushEvent;
    internals.pushEvent = (event: unknown) => {
      const e = event as { type: string; callId?: string; result?: ToolResult };
      if (e.type === 'tool-result' && e.callId === id) { internals.pushEvent = original; resolve(e.result!); }
      else original.call(internals, event);
    };
    internals.dispatchToolCall('agent', { id, name, input });
  });
  const viaPuppet = async (name: string, input: Record<string, unknown>) => (await f.framework.puppetToolCall('agent', name, input)).result;
  return { f, ctx: () => ctx!, viaModel, viaPuppet };
}

const fields = (r: ToolResult) => ({ success: r.success, data: r.data, error: r.error, isError: r.isError });

async function answersAsTheAgent(h: Awaited<ReturnType<typeof setup>>, calls: Array<[string, Record<string, unknown>]>) {
  for (const [i, [name, input]] of calls.entries()) {
    const puppet = await h.viaPuppet(name, input);
    const model = await h.viaModel(`m-${i}`, name, input);
    assert.deepEqual(fields(puppet), fields(model), `${name} ${JSON.stringify(input)}`);
  }
}

test('the puppet\'s agent_settings answers as the agent\'s own call does', { timeout: 30_000 }, async (t) => {
  const h = await setup(t);
  const got = await h.viaPuppet('agent_settings', { action: 'get' });
  assert.equal(got.success, true, String(got.error));
  await answersAsTheAgent(h, [['agent_settings', { action: 'get' }]]);
});

test('the puppet\'s workspace tools answer as the agent\'s own calls do, and a host\'s fetch whose reference id can\'t be read answers with the error, as the agent\'s own fetch does', { timeout: 30_000 }, async (t) => {
  const h = await setup(t);
  await answersAsTheAgent(h, [
    ['save_recent_image', {}],
    ['read_image', { path: 'work/zz-missing.png' }],
    ['fetch_reference', { ref_id: 'zz-none' }],
  ]);
  const unreadable = { ref_id: { toString: 1, valueOf: 1 } };
  const host = await h.f.framework.executeToolCall({ id: 'host-fetch', name: 'fetch_reference', input: unreadable, callerAgentName: 'agent' });
  assert.equal(host.isError, true);
  assert.match(String(host.error), /^fetch_reference couldn't answer: .+/);
  assert.deepEqual(fields(host), fields(await h.viaModel('m-fetch', 'fetch_reference', unreadable)));
});

test('the puppet\'s gate tools answer as the agent\'s own calls do', { timeout: 30_000 }, async (t) => {
  const h = await setup(t);
  await answersAsTheAgent(h, [
    ['gate_status', {}],
    ['event_tags', {}],
    ['wake_add_rule', {}],
    ['wake_remove_rule', { name: 'zz-none' }],
    ['sleep', { seconds: 0 }],
    ['wake', {}],
  ]);
});

test('the puppet\'s think and journal answer as the agent\'s own calls do, and skip_reply, which ends the turn it\'s called in, is refused off a turn: by the puppet before anything is stored, and to a host as its result', { timeout: 30_000 }, async (t) => {
  const h = await setup(t);
  await answersAsTheAgent(h, [
    ['think', { content: 'zz-thought' }],
    ['journal', { content: 'zz-entry' }],
  ]);
  const before = h.f.context();
  await assert.rejects(h.viaPuppet('skip_reply', { reason: 'zz' }), /puppet refused: skip_reply ends the turn it's called in/);
  assert.equal(h.f.context(), before, 'the refused puppet call stored nothing');
  const skip = await h.f.framework.executeToolCall({ id: 'host-skip', name: 'skip_reply', input: { reason: 'zz' }, callerAgentName: 'agent' });
  assert.equal(skip.isError, true);
  assert.match(String(skip.error), /skip_reply ends the turn it's called in/);
  assert.match(String(skip.error), /nothing was done/);
});

test('the puppet refuses a skip_reply reached through toolsets--act as it refuses one called by name, and stores nothing', { timeout: 30_000 }, async (t) => {
  const h = await setup(t, { presentation: true });
  assert.equal((await h.viaPuppet('set_tool_visibility', { name: 'skip_reply', visible: false })).success, true);
  assert.equal((await h.viaPuppet('toolsets--open', { toolset: 'settings' })).success, true);
  const before = h.f.context();
  await assert.rejects(h.viaPuppet('toolsets--act', { tool: 'skip_reply', args: { reason: 'zz' } }), /puppet refused: skip_reply ends the turn it's called in/);
  assert.equal(h.f.context(), before, 'the refused puppet call stored nothing');
});

test('prose_help is on an explicit-prose agent\'s surface for the puppet, and answers it with the routing reference, as it answers the agent', { timeout: 30_000 }, async (t) => {
  const h = await setup(t);
  const help = await h.viaPuppet('prose_help', {});
  assert.equal(help.success, true, String(help.error));
  assert.match(String(help.data), />>/);
  await answersAsTheAgent(h, [['prose_help', {}]]);
});

test('a module\'s call of the agent\'s own verbs, think, journal, skip_reply and drafts, is refused as the agent\'s own, and does nothing', { timeout: 30_000 }, async (t) => {
  const h = await setup(t);
  for (const name of ['think', 'journal', 'skip_reply', 'drafts']) {
    const got = await h.ctx().callTool({ id: `mod-${name}`, name, input: {}, callerAgentName: 'agent' });
    assert.equal(got.isError, true, name);
    assert.match(String(got.error), new RegExp(`^${name} is the agent's own`), name);
    assert.match(String(got.error), /nothing was done/, name);
  }
});

test('a call with no agent behind it: think and journal answer it as they answer the agent\'s own call, and skip_reply is refused, since no turn is going', { timeout: 30_000 }, async (t) => {
  const h = await setup(t);
  for (const name of ['think', 'journal']) {
    const got = await h.f.framework.executeToolCall({ id: `anon-${name}`, name, input: { content: 'zz' } });
    const model = await h.viaModel(`anon-m-${name}`, name, { content: 'zz' });
    assert.deepEqual(fields(got), fields(model), name);
  }
  const skip = await h.f.framework.executeToolCall({ id: 'anon-skip', name: 'skip_reply', input: {} });
  assert.equal(skip.isError, true);
  assert.match(String(skip.error), /skip_reply ends the turn it's called in/);
  assert.match(String(skip.error), /nothing was done/);
});

test('an awaited call the dispatcher would refuse, a conversation fork\'s sleep, gets the refusal with no refused claim', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awaited-refused-'));
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' }],
    modules: [],
    conversations: { templateAgent: 'trunk' },
    gate: { config: { policies: [], default: 'always' }, configPath: join(dir, 'gate.json') },
  });
  t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  framework.pushEvent({
    type: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'slack:D9', messageId: 'm-1',
    author: { id: 'U1', name: 'alice' }, content: [{ type: 'text', text: 'hi' }],
    timestamp: new Date().toISOString(), metadata: { mentioned: false, channel_type: 'im' }, triggerInference: true,
  } as unknown as ProcessEvent);
  await framework.runUntilIdle();
  const fork = framework.getAllAgents().map((a) => a.name).find((name) => name.startsWith('conversation-'));
  assert.ok(fork, 'the message made a conversation fork');
  const got = await framework.executeToolCall({ id: 'fork-sleep', name: 'sleep', input: { seconds: 60, announce: false }, callerAgentName: fork });
  assert.equal(got.isError, true);
  assert.match(String(got.error), /a sleep quiets the whole agent, not one conversation/);
  assert.equal('refused' in got, false);
});

test('a module that saves an image from inside its own tool call is answered at once, not held by the round its own call is in', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awaited-save-'));
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call-save-now', name: 'saver--save_now', input: {} }] as ContentBlock[], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
  let saved: (result: ToolResult) => void = () => {};
  const answered = new Promise<ToolResult>((resolve) => { saved = resolve; });
  let ctx: ModuleContext | undefined;
  const saver: Module = {
    name: 'saver',
    async start(c: ModuleContext) { ctx = c; },
    async stop() {},
    getTools() { return [{ name: 'save_now', description: 'Save the newest image.', inputSchema: { type: 'object', properties: {} } }]; },
    async handleToolCall() {
      const result = await ctx!.callTool({ id: 'mod-save', name: 'save_recent_image', input: { path: 'work/zz.gif', index: 0 }, callerAgentName: 'agent' });
      saved(result);
      return result;
    },
    async onProcess(event: ProcessEvent) {
      return event.type === 'external-message'
        ? { addMessages: [{ participant: 'User', content: (event as { content: unknown }).content }], requestInference: true }
        : {};
    },
  } as unknown as Module;
  const workspace = new WorkspaceModule({ mounts: [{ name: 'work', path: dir, mode: 'read-write', watch: 'never' }] });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', allowedTools: 'all' }],
    modules: [saver, workspace as unknown as Module],
    syncIntervalMs: 0,
  });
  workspace.initStore(framework.getStore());
  t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  framework.getAgent('agent')!.getContextManager().addMessage('user', [
    { type: 'text', text: 'here is my avatar' },
    { type: 'image', source: { type: 'base64', data: GIF, mediaType: 'image/gif' } },
  ] as ContentBlock[]);
  framework.start();
  framework.pushEvent({
    type: 'external-message', source: 'test', content: [{ type: 'text', text: 'save it' }], metadata: {}, triggerInference: true,
  } as unknown as ProcessEvent);
  const result = await answered;
  assert.equal(result.success, true, String(result.error));
  const written = await workspace.readBinary('work/zz.gif');
  assert.ok('data' in written, 'the save wrote work/zz.gif');
  assert.equal(written.data.toString('base64'), GIF);
});
