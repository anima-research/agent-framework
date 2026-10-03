/**
 * RFC-007 end to end: a real framework, two real MCPL servers over stdio, a
 * scripted model turn.
 *
 *   provider  — offers `click` (classed `computer`) and `run` (unclassed,
 *               returns an error result)
 *   observer  — granted toolLifecycle.observe + inputs (narrowed by tool
 *               name to prov--*), sends a tools/observe filter asking for click
 *               coordinates and every other call's full arguments
 *
 * The agent calls prov--click, prov--run and the observer's own obs--ping in
 * one round. The observer must see: click with ONLY the requested fields;
 * run with its class empty and its arguments withheld (unclassed tools never
 * carry arguments); run's terminal as completed+isError; nothing at all for
 * its own tool; and no tool result anywhere.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tool-lifecycle-mcpl-server.mjs');

class Trigger implements Module {
  readonly name = 'trigger';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools', isError: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      // Wake the named agents when the event names them (broadcast skips
      // conversation forks), everyone otherwise.
      const targets = (event as { targetAgents?: string[] }).targetAgents;
      return {
        addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }],
        requestInference: targets ?? true,
      };
    }
    return {};
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

type Logged = { event: string; params?: Record<string, unknown>; [k: string]: unknown };
const readLog = (path: string): Logged[] =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

describe('tool lifecycle end to end (RFC-007)', () => {
  let tempDir: string;
  let obsLog: string;
  let provLog: string;
  let diePath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tool-lifecycle-e2e-'));
    obsLog = join(tempDir, 'observer.jsonl');
    provLog = join(tempDir, 'provider.jsonl');
    diePath = join(tempDir, 'provider.die');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [new Trigger()],
      mcplServers: [
        {
          id: 'prov',
          toolPrefix: 'prov',
          command: process.execPath,
          args: [FIXTURE],
          env: { ROLE: 'provider', LOG_PATH: provLog, DIE_PATH: diePath },
        },
        {
          id: 'obs',
          toolPrefix: 'obs',
          command: process.execPath,
          args: [FIXTURE],
          env: {
            ROLE: 'observer',
            LOG_PATH: obsLog,
            FILTER: JSON.stringify([
              { match: { serverTool: 'click' }, input: ['x', 'y', 'target.window_id'] },
              { match: {}, input: true },
            ]),
          },
          // Narrowed by NAME, which admits prov--run: only the class
          // exclusion (unclassed never carries arguments) can withhold it.
          toolLifecycle: { observe: {}, inputs: { tools: ['prov--*'] } },
        },
      ],
    });
    await framework.start();
    await waitFor(() => readLog(obsLog).some((e) => e.event === 'observe-applied'), 'observer filter applied');
    await waitFor(
      () => ['prov--click', 'prov--run', 'obs--ping'].every((n) => framework.getAllTools().some((t) => t.name === n)),
      'MCPL tools listed',
    );
  });

  after(async () => {
    await framework?.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists every tool with its effective class, source, and server (RFC-008 §6)', () => {
    const byTool = new Map(framework.listToolClasses().map((e) => [e.tool, e]));
    assert.deepEqual(byTool.get('prov--click'), { tool: 'prov--click', class: ['computer'], source: 'server', serverId: 'prov' });
    assert.deepEqual(byTool.get('prov--run'), { tool: 'prov--run', class: [], source: 'none', serverId: 'prov' });
    assert.deepEqual(byTool.get('obs--ping'), { tool: 'obs--ping', class: ['body'], source: 'server', serverId: 'obs' });
    const prov = framework.listMcplServers().find((s) => s.id === 'prov')!;
    assert.deepEqual(prov.toolClasses.map((t) => `${t.serverTool}:${t.class.join('+') || '-'}:${t.source}`), [
      'click:computer:server', 'run:-:none',
    ]);
  });

  it('reports other servers\' calls with requested fields only, never results', async () => {
    const policy = readLog(obsLog).find((e) => e.event === 'policy');
    assert.ok(
      (policy?.effectiveCapabilities as string[]).includes('toolLifecycle.inputs'),
      'the policy block granted both paths',
    );

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Acting.' },
      {
        type: 'tool_use', id: 'toolu_01AAAAAAAAAAAAAAAAAAAAAA', name: 'prov--click',
        input: { x: 812, y: 440, button: 'left', target: { window_id: 3312, title: 'Invoice.pdf' } },
      },
      { type: 'tool_use', id: 'toolu_01BBBBBBBBBBBBBBBBBBBBBB', name: 'prov--run', input: { cmd: 'make secret-arg' } },
      { type: 'tool_use', id: 'toolu_01CCCCCCCCCCCCCCCCCCCCCC', name: 'obs--ping', input: {} },
    ] as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: [{ type: 'text', text: 'go' }],
      metadata: {},
      triggerInference: true,
    } as unknown as ProcessEvent);

    const lifecycle = () => readLog(obsLog).filter((e) => e.event === 'lifecycle').map((e) => e.params!);
    await waitFor(() => lifecycle().length >= 4, 'two calls, both phases');
    // Let the turn finish, so a stray or duplicate notification would land
    // before the counts below are taken.
    await waitFor(() => membrane.lastStream?.receivedToolResults.length === 1, 'tool results returned to the model');
    await new Promise((r) => setTimeout(r, 300));

    const events = lifecycle();
    const byTool = (tool: string, phase: string) => events.filter((p) => p.tool === tool && p.phase === phase);

    // Own tool: the observer saw its own call as tools/call, never as lifecycle.
    assert.ok(readLog(obsLog).some((e) => e.event === 'tools-call' && e.name === 'ping'));
    assert.equal(events.filter((p) => p.tool === 'obs--ping').length, 0, 'own tools are excluded');

    // click: classed computer → the requested fields and nothing else.
    const [clickStart] = byTool('prov--click', 'started');
    assert.deepEqual(clickStart.class, ['computer']);
    assert.equal(clickStart.serverId, 'prov');
    assert.equal(clickStart.serverTool, 'click');
    assert.equal(clickStart.conversationId, 'scout');
    assert.deepEqual(clickStart.input, { x: 812, y: 440, target: { window_id: 3312 } });
    const [clickEnd] = byTool('prov--click', 'completed');
    assert.equal(clickEnd.toolCallId, clickStart.toolCallId);
    assert.equal(clickEnd.inferenceId, clickStart.inferenceId);
    assert.equal(clickEnd.isError, false);
    assert.equal(typeof clickEnd.durationMs, 'number');

    // run: unclassed → arguments withheld though the rule asked; error RESULT
    // is a completed call with isError, not a failure.
    const [runStart] = byTool('prov--run', 'started');
    assert.deepEqual(runStart.class, []);
    assert.equal(runStart.input, undefined);
    assert.equal(runStart.inputWithheld, true);
    const [runEnd] = byTool('prov--run', 'completed');
    assert.equal(runEnd.isError, true);

    // Exactly one opening and one terminal per call.
    assert.equal(events.length, 4);

    const wire = JSON.stringify(events);
    for (const secret of ['RESULT-MARKER', 'secret-arg', 'Invoice.pdf', 'left']) {
      assert.ok(!wire.includes(secret), `"${secret}" must not reach the observer`);
    }

    // The provider, which holds no toolLifecycle grant, received nothing.
    assert.equal(readLog(provLog).filter((e) => e.event === 'lifecycle').length, 0);
  });
  it('a provider that dies takes its classes with it, and calls to it are never reported (review #3, #4)', async () => {
    const internals = framework as unknown as {
      mcplServerRegistry: { getServer(id: string): unknown } | null;
      describeToolForLifecycle(tool: string): { class: string[] };
      conversationAgentHomes: Map<string, string>;
    };
    assert.deepEqual(internals.describeToolForLifecycle('prov--click').class, ['computer'], 'classed while alive');

    writeFileSync(diePath, '');
    await waitFor(() => internals.mcplServerRegistry?.getServer('prov') == null, 'provider removed from the registry');

    // #3: the stale declaration is gone — unclassed (restrictive) until re-listed.
    assert.deepEqual(internals.describeToolForLifecycle('prov--click').class, []);

    const before = readLog(obsLog).filter((e) => e.event === 'lifecycle').length;
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'toolu_01DDDDDDDDDDDDDDDDDDDDDD', name: 'prov--click', input: { x: 1, y: 2 } },
    ] as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'It is gone.' }]));
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: [{ type: 'text', text: 'again' }],
      metadata: {},
      triggerInference: true,
    } as unknown as ProcessEvent);
    await waitFor(() => (membrane.lastStream?.receivedToolResults.length ?? 0) >= 1
      && membrane.lastStream !== null && membrane.calls.length >= 2, 'the refused call answered');
    await new Promise((r) => setTimeout(r, 300));
    const after = readLog(obsLog).filter((e) => e.event === 'lifecycle').length;
    assert.equal(after, before, 'a call the host refused (provider gone) produces no events');
  });
  it('a host-tool refusal (conversation-bound channel guard) is never reported (re-review #1)', async () => {
    const internals = framework as unknown as { conversationAgentHomes: Map<string, string> };
    // Make scout a conversation fork bound to one channel: the guard in
    // dispatchChannelToolCall refuses channel_open before it runs.
    internals.conversationAgentHomes.set('scout', 'disc:guild:home');
    try {
      const before = readLog(obsLog).filter((e) => e.event === 'lifecycle').length;
      const callsBefore = membrane.calls.length;
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'toolu_01EEEEEEEEEEEEEEEEEEEEEE', name: 'channel_open', input: { channelId: 'disc:guild:other' } },
      ] as never, 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Refused.' }]));
      framework.pushEvent({
        type: 'external-message',
        source: 'test',
        content: [{ type: 'text', text: 'open another channel' }],
        metadata: {},
        triggerInference: true,
        // Broadcast wakes skip conversation forks; address scout directly.
        targetAgents: ['scout'],
      } as unknown as ProcessEvent);
      await waitFor(() => membrane.calls.length > callsBefore
        && (membrane.lastStream?.receivedToolResults.length ?? 0) >= 1, 'the refused call answered');
      const answer = JSON.stringify(membrane.lastStream!.receivedToolResults[0]);
      assert.match(answer, /cannot open channels/, 'the guard did refuse it');
      await new Promise((r) => setTimeout(r, 300));
      const after = readLog(obsLog).filter((e) => e.event === 'lifecycle').length;
      assert.equal(after, before, 'a refused host-tool call produces no events');
    } finally {
      internals.conversationAgentHomes.delete('scout');
    }
  });
});
