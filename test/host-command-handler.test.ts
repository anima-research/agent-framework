import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type HostCommandHandler } from '../src/index.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplServerRegistry } from '../src/mcpl/server-registry.js';
import { McplTransport } from '../src/mcpl/transport.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { schedulerPasses } from './helpers/scheduler-passes.js';

// Fake connector at the NDJSON boundary, not an actual Zulip client.
class ControlTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly toolCalls: unknown[] = [];
  private nextId = 1;
  private replies = new Map<number, (reply: any) => void>();
  writeLine(line: string): void {
    const reply = JSON.parse(line);
    if (reply.method === 'tools/call') {
      this.toolCalls.push(reply.params);
      queueMicrotask(() => this.emit('line', JSON.stringify({
        jsonrpc: '2.0', id: reply.id, result: { content: [{ type: 'text', text: 'sent' }] },
      })));
      return;
    }
    this.replies.get(reply.id)?.(reply);
    this.replies.delete(reply.id);
  }
  async close(): Promise<void> {}
  request(params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.replies.set(id, resolve);
      this.emit('line', JSON.stringify({ jsonrpc: '2.0', id, method: 'host/command', params }));
    });
  }
}

async function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'host-command-handler-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }], modules: [],
  });
  const registry = new McplServerRegistry();
  const internals = framework as unknown as {
    mcplServerRegistry: McplServerRegistry;
    wireMcplEvents(connection: McplServerConnection, config: McplServerConfig): void;
  };
  internals.mcplServerRegistry = registry;
  t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  function server(id: string, authority: Pick<McplServerConfig, 'allowHostCommands' | 'hostCommandRole'> = {}) {
    const transport = new ControlTransport();
    const Connection = McplServerConnection as unknown as new (
      id: string, capabilities: null, transport: McplTransport,
    ) => McplServerConnection;
    const connection = new Connection(id, null, transport);
    connection.allowHostCommands = authority.allowHostCommands === true;
    connection.hostCommandRole = authority.hostCommandRole;
    (registry as unknown as { servers: Map<string, McplServerConnection> }).servers.set(id, connection);
    internals.wireMcplEvents(connection, { id, ...authority });
    connection.ready();
    return { connection, transport, request: transport.request.bind(transport) };
  }
  return { framework, membrane, server };
}

const envelope = {
  command: 'operator', text: '!agent resume', senderId: 3333, messageId: 42,
  stream: 'service-home', streamId: 7, topic: 'control', timestamp: 1795000000,
  realm: 'https://zulip.example',
};

test('selected control server delivers unchanged numeric actor/origin while quiesced, without ingestion or a wake', { timeout: 15_000 }, async (t) => {
  const { framework, membrane, server } = await harness(t);
  const control = server('zulip-control', { hostCommandRole: 'operator' });
  const cm = framework.getAgent('agent')!.getContextManager();
  const before = structuredClone(cm.getAllMessages());
  let calls = 0;
  const handler: HostCommandHandler = async (serverId, params) => {
    calls++;
    assert.equal(serverId, 'zulip-control');
    assert.deepEqual(params, envelope);
    assert.equal(typeof params.senderId, 'number');
    assert.equal(framework.getHostModeStatus().quiesced, true);
    await control.connection.sendToolsCall('send_message', { topic: 'control', content: 'resume accepted' });
    assert.equal(control.transport.toolCalls.length, 1, 'reply tool call works with data plane paused');
    await framework.resume();
    return { ok: true, message: 'resumed' };
  };
  framework.setHostCommandHandler(handler);
  const nextPass = schedulerPasses(framework, async (what, cond) => {
    const deadline = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  framework.start();
  assert.equal((await framework.quiesce()).drained, true);
  assert.equal((control.connection as unknown as { dataPlaneReady: boolean }).dataPlaneReady, false);
  assert.deepEqual((await control.request(envelope)).result, { ok: true, message: 'resumed' });
  assert.equal(framework.getHostModeStatus().quiesced, false);
  await nextPass();
  assert.equal(calls, 1);
  assert.deepEqual(cm.getAllMessages(), before, 'no control message entered the record');
  assert.equal(framework.getHostModeStatus().gatedRequests, 0, 'no parked wake');
  assert.equal(membrane.calls.length, 0, 'no model call');
});

test('selected server cannot reach any built-in or unknown command, even without a handler', { timeout: 15_000 }, async (t) => {
  const { framework, server } = await harness(t);
  const control = server('zulip-control', { hostCommandRole: 'operator' });
  let calls = 0;
  framework.setHostCommandHandler(async () => { calls++; return { ok: true }; });
  for (const handler of [true, false]) {
    if (!handler) framework.setHostCommandHandler(null);
    for (const command of ['undo', 'hide', 'unstick', 'unstick-outcome', 'nudge', 'quiesce', 'resume', 'maintain', 'host-status', 'marks', 'release-provider-wait', 'unknown', 'Operator', undefined]) {
      const reply = await control.request({ command, agentName: 'agent' });
      assert.equal(reply.error?.code, -32002, String(command));
      assert.equal(reply.result, undefined);
    }
  }
  assert.equal(calls, 0);
  assert.equal(framework.getHostModeStatus().quiesced, false);
  const unset = await control.request(envelope);
  assert.equal(unset.result.ok, false);
  assert.match(unset.result.error, /No host command handler/);

  control.connection.hostCommandRole = undefined;
  assert.equal((await control.request({ command: 'host-status' })).error?.code, -32002,
    'a role that is no longer valid must not fall through to admin commands');
});

test('omitted config denies; true preserves legacy behavior and cannot reach the hook', { timeout: 15_000 }, async (t) => {
  const { framework, server } = await harness(t);
  const denied = server('untrusted');
  const legacy = server('discord', { allowHostCommands: true });
  let calls = 0;
  framework.setHostCommandHandler(async () => { calls++; return { ok: true }; });
  for (const handler of [true, false]) {
    if (!handler) framework.setHostCommandHandler(null);
    assert.equal((await denied.request(envelope)).error.code, -32002);
    assert.match((await legacy.request(envelope)).result.error, /Unknown host command: operator/);
    assert.equal((await legacy.request({ command: 'host-status' })).result.ok, true);
    assert.equal((await legacy.request({ command: 'undo', agentName: 'missing' })).result.ok, false);
    assert.match((await legacy.request({ command: 'not-a-command' })).result.error, /Unknown host command/);
  }
  assert.equal(calls, 0);
});

test('hook rejection and missing result are contained by existing request error handling', { timeout: 15_000 }, async (t) => {
  const { framework, server } = await harness(t);
  const control = server('zulip-control', { hostCommandRole: 'operator' });
  framework.setHostCommandHandler(async () => { throw new Error('handler failed'); });
  assert.equal((await control.request(envelope)).error.code, -32603);
  framework.setHostCommandHandler((async () => {}) as unknown as HostCommandHandler);
  assert.equal((await control.request(envelope)).error.code, -32603);
  framework.setHostCommandHandler(async () => ({ ok: false, message: 'unsupported' }));
  assert.deepEqual((await control.request(envelope)).result, { ok: false, message: 'unsupported' });
});

test('runBuiltIn answers refusals as handleHostCommand does, refuses operator, and refuses once stop() has begun', { timeout: 15_000 }, async (t) => {
  const { framework, server } = await harness(t);
  const control = server('zulip-control', { hostCommandRole: 'operator' });
  let run!: Parameters<HostCommandHandler>[2];
  const answers: unknown[] = [];
  framework.setHostCommandHandler(async (_serverId, _params, runBuiltIn) => {
    run = runBuiltIn;
    answers.push(await runBuiltIn({ command: 'unstick', agentName: 'missing' }));
    answers.push(await runBuiltIn({ command: 'operator' }));
    answers.push(await runBuiltIn({ command: 'unstick-outcome', agentName: 'agent' }));
    answers.push(await runBuiltIn({ command: 'unstick-outcome' }));
    answers.push(await runBuiltIn({ command: 'host-status' }));
    return { ok: true };
  });
  assert.deepEqual((await control.request(envelope)).result, { ok: true });
  assert.deepEqual(answers.slice(0, 4), [
    { ok: false, error: 'Unknown agent: missing' },
    { ok: false, error: 'Unknown host command: operator' },
    { ok: false, error: 'unstick-outcome: agent has no /unstick to answer for' },
    { ok: false, error: 'unstick-outcome: agentName must name the agent, as the unstick acknowledgement does' },
  ]);
  assert.equal((answers[4] as { ok: boolean }).ok, true);
  await framework.stop();
  assert.deepEqual(await run({ command: 'host-status' }), { ok: false, error: 'host shutdown has begun' });
});

test('the framework refuses a non-operator command for the control role on its own, behind the connection gate', { timeout: 15_000 }, async (t) => {
  // The connection answers -32002 first, so reach handleHostCommand directly:
  // this pins the framework's own operator-only refusal if that gate moves.
  const { framework } = await harness(t);
  let calls = 0;
  const handle = (framework as unknown as {
    handleHostCommand(serverId: string, params: Record<string, unknown>, operatorOnly?: boolean): Promise<Record<string, unknown>>;
  }).handleHostCommand.bind(framework);
  for (const handler of [true, false]) {
    framework.setHostCommandHandler(handler ? async () => { calls++; return { ok: true }; } : null);
    for (const command of ['undo', 'hide', 'unstick', 'nudge', 'quiesce', 'resume', 'host-status', 'release-provider-wait', 'unknown', undefined]) {
      assert.deepEqual(await handle('zulip-control', { command, agentName: 'agent' }, true),
        { ok: false, error: 'Control role accepts only operator' }, String(command));
    }
  }
  assert.equal(calls, 0);
  assert.equal(framework.getHostModeStatus().quiesced, false);
  // The same params without the role still reach the built-ins.
  assert.equal((await handle('discord', { command: 'host-status' })).ok, true);
});
