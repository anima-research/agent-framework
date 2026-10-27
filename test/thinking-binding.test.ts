/**
 * `thinkingBinding.dropBlock` asks the provider to drop a signed thinking
 * block whose earlier conversation changed, as a fold changes it, rather than
 * refuse the request. These pin what an agent sends for it, through
 * membrane's Anthropic adapter to the wire; what a call whose report names
 * dropped blocks does to the trace and to the context strategy's
 * calibration; and the setting's refusals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextManager } from '@animalabs/context-manager';
import { AnthropicAdapter, Membrane } from '@animalabs/membrane';
import type { DetailedUsage, Membrane as MembraneType, NormalizedResponse } from '@animalabs/membrane';

import { Agent, AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ProcessEvent, ToolCall, TraceEvent } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

const DROP_BLOCK = 'true asks the provider to drop a signed thinking block whose earlier conversation changed rather than refuse the request, ' +
  'and false or leaving it out sends nothing, so the account\'s default applies';
const BINDING = { prefixMismatchBehavior: 'drop_block' };

const agentWith = (settings: Record<string, unknown>) => ({
  name: 'agent',
  model: 'claude-opus-5-5',
  systemPrompt: 'test',
  ...settings,
});

/** An Agent built directly. Building an activation request needs only
 *  compile(), so membrane is touched only when a test sends the request. */
const oneMessage = {
  compile: async () => ({ messages: [{ participant: 'user', content: [{ type: 'text', text: 'Hello.' }] }], systemInjections: [] }),
} as unknown as ContextManager;
const newAgent = (settings: Record<string, unknown>) =>
  new Agent(agentWith(settings) as never, oneMessage, {} as MembraneType);
const sentThinking = async (settings: Record<string, unknown>) =>
  (await newAgent(settings).buildActivationRequest([])).config.thinking;

/** A stand-in for the Messages API that records each request's body and
 *  headers and answers with one short text reply. */
async function messagesApi(): Promise<{ baseURL: string; seen: Array<{ body: Record<string, unknown>; headers: IncomingHttpHeaders }>; server: Server }> {
  const seen: Array<{ body: Record<string, unknown>; headers: IncomingHttpHeaders }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ body, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

describe('thinkingBinding.dropBlock', () => {
  it('adds the binding control to the thinking config the agent sends, and to no request without the setting', async () => {
    // Each agent is given a config of its own, and the expectations are
    // literals, so a control written into the agent's config would show.
    const thinking = () => ({ enabled: true, budgetTokens: 2048 });
    const given = thinking();
    assert.deepEqual(await sentThinking({ thinking: given, thinkingBinding: { dropBlock: true } }),
      { enabled: true, budgetTokens: 2048, blockBinding: BINDING });
    assert.deepEqual(given, { enabled: true, budgetTokens: 2048 }, 'the agent\'s own config is left as it was');
    for (const none of [undefined, null, false]) {
      assert.deepEqual(await sentThinking({ thinking: none, thinkingBinding: { dropBlock: true } }), { enabled: false, blockBinding: BINDING },
        `an agent whose thinking is ${String(none)} still carries the control, for a model whose thinking is always on`);
    }
    assert.deepEqual(await sentThinking({ thinking: thinking() }), { enabled: true, budgetTokens: 2048 });
    assert.deepEqual(await sentThinking({ thinking: thinking(), thinkingBinding: { dropBlock: false } }), { enabled: true, budgetTokens: 2048 });
    assert.equal(await sentThinking({ thinkingBinding: { dropBlock: false } }), undefined);
  });

  it('reaches the wire through membrane\'s Anthropic adapter as block_binding with its beta, on the models that take it', async () => {
    const api = await messagesApi();
    const membrane = new Membrane(new AnthropicAdapter({ apiKey: 'test-key', baseURL: api.baseURL, cacheKeepalive: { enabled: false } }));
    const send = async (settings: Record<string, unknown>) => {
      const request = await newAgent(settings).buildActivationRequest([]);
      await membrane.complete(request);
      const { body, headers } = api.seen[api.seen.length - 1]!;
      return { thinking: body.thinking, beta: String(headers['anthropic-beta'] ?? '').split(',').filter(Boolean) };
    };
    const binding = { prefix_mismatch_behavior: 'drop_block' };
    const BETA = 'thinking-binding-controls-2026-08-01';
    try {
      const opus = await send({ thinking: { enabled: true, budgetTokens: 2048 }, thinkingBinding: { dropBlock: true } });
      assert.deepEqual(opus.thinking, { type: 'enabled', budget_tokens: 2048, block_binding: binding });
      assert.ok(opus.beta.includes(BETA), `the beta goes with it: ${opus.beta.join(',')}`);

      const fable = await send({ model: 'claude-fable-5-1', thinkingBinding: { dropBlock: true } });
      assert.deepEqual(fable.thinking, { type: 'adaptive', block_binding: binding },
        'a model whose thinking is always on carries it in an adaptive config, with no thinking config of the agent\'s own');
      assert.ok(fable.beta.includes(BETA));

      // On such a model the agent's `display` goes out in that config, and so only with the setting.
      const shown = { enabled: false, display: 'summarized' };
      const fableShown = await send({ model: 'claude-fable-5-1', thinking: shown, thinkingBinding: { dropBlock: true } });
      assert.deepEqual(fableShown.thinking, { type: 'adaptive', display: 'summarized', block_binding: binding }, 'display beside the control');
      const fableUnset = await send({ model: 'claude-fable-5-1', thinking: shown });
      assert.equal(fableUnset.thinking, undefined, 'without the setting, such a model is sent no thinking config, display included');
      assert.equal(fableUnset.beta.includes(BETA), false);

      const off = await send({ thinkingBinding: { dropBlock: true } });
      assert.equal(off.thinking, undefined, 'another model with thinking off sends no thinking config, so no control');
      assert.equal(off.beta.includes(BETA), false);

      const unset = await send({ thinking: { enabled: true, budgetTokens: 2048 } });
      assert.deepEqual(unset.thinking, { type: 'enabled', budget_tokens: 2048 }, 'without the setting nothing changes');
      assert.equal(unset.beta.includes(BETA), false);
    } finally {
      await new Promise<void>((resolve) => api.server.close(() => resolve()));
    }
  });

  it('puts a call\'s report in its inference:usage trace, and gives no calibration sample from a call that dropped blocks or any later call of its stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-thinking-binding-'));
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(), agents: [],
      modules: [new EchoTools()], syncIntervalMs: 0,
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    framework.start();
    try {
      const dropped = { reason: 'prefix_binding_mismatch', path: 'messages.1.content.0', message: 1 };
      const shown = { reason: 'prefix_binding_mismatch', path: 'messages.3.content.0', message: 3 };
      // Four calls of one stream: no report, a block shown though it failed
      // the check, a block dropped, and a report that names nothing.
      membrane.pushResponse(withRound(createMockResponse([{ type: 'tool_use', id: 'c1', name: 'test--echo', input: {} }], 'tool_use'),
        { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 400 }));
      membrane.pushResponse(withRound(createMockResponse([{ type: 'tool_use', id: 'c2', name: 'test--echo', input: {} }], 'tool_use'),
        { inputTokens: 130, outputTokens: 15, cacheCreationTokens: 0, cacheReadTokens: 900 }, { dropped: [], mismatchAllowed: [shown] }));
      membrane.pushResponse(withRound(createMockResponse([{ type: 'tool_use', id: 'c3', name: 'test--echo', input: {} }], 'tool_use'),
        { inputTokens: 150, outputTokens: 20, cacheCreationTokens: 60, cacheReadTokens: 900 }, { dropped: [dropped], mismatchAllowed: [] }));
      membrane.pushResponse(withRound(createMockResponse([{ type: 'text', text: 'Done.' }]),
        { inputTokens: 170, outputTokens: 25, cacheCreationTokens: 60, cacheReadTokens: 1400 }, { dropped: [], mismatchAllowed: [] }));

      const { agent, contextManager } = await framework.createEphemeralAgent({
        name: 'worker', model: 'claude-opus-5-5', systemPrompt: 'Do the task.', allowedTools: 'all',
        proseRouting: 'disabled', thinkingBinding: { dropBlock: true },
      });
      const calibrated: number[] = [];
      const strategy = contextManager.getStrategy() as unknown as { reportRealInputTokens?: (n: number) => void };
      strategy.reportRealInputTokens = (n) => { calibrated.push(n); };
      contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      await framework.runEphemeralToCompletion(agent, contextManager);

      const usage = traces.filter((event): event is Extract<TraceEvent, { type: 'inference:usage' }> => event.type === 'inference:usage');
      assert.equal(usage.length, 4);
      assert.equal('thinking' in usage[0]!, false, 'a call with no report carries no thinking field');
      assert.deepEqual(usage[1]!.thinking, { dropped: [], mismatchAllowed: [shown] },
        'a block shown to the model though it failed the check is reported too');
      assert.deepEqual(usage[2]!.thinking, { dropped: [dropped], mismatchAllowed: [] });
      assert.equal('thinking' in usage[3]!, false, 'a call whose report names nothing carries no thinking field');
      assert.deepEqual(calibrated, [100 + 0 + 400, 30 + 0 + 500],
        'each call before the drop is given, as its own share of the stream\'s usage, a shown block being billed; ' +
        'the call that dropped one and the call after it are not, since the strategy would take the first call given after its compile');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives no sample from a stream whose first call dropped blocks, and calibrates the next stream, which dropped none', async () => {
    // A stream's skip is the stream's: a stream whose first call drops blocks gives no sample, and the next stream that
    // drops none is a sample again. Kept anywhere longer-lived than the stream, such as the agent, the skip would stop
    // calibration for good. One agent, two turns, two streams.
    const dir = mkdtempSync(join(tmpdir(), 'af-thinking-binding-streams-'));
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ ...agentWith({ thinkingBinding: { dropBlock: true } }), proseRouting: 'disabled' } as never],
      modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    const completed: TraceEvent[] = [];
    framework.onTrace((event) => { if (event.type === 'inference:completed') completed.push(event); });
    framework.start();
    try {
      const calibrated: number[] = [];
      const strategy = framework.getAgent('agent')!.getContextManager().getStrategy() as unknown as { reportRealInputTokens?: (n: number) => void };
      strategy.reportRealInputTokens = (n) => { calibrated.push(n); };
      const dropped = { reason: 'prefix_binding_mismatch', path: 'messages.1.content.0', message: 1 };
      const turn = async (text: string) => {
        const before = completed.length;
        framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as never);
        await framework.runUntilIdle();
        for (const until = Date.now() + 10_000; completed.length === before && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
        assert.equal(completed.length, before + 1, `the turn for "${text}" completed`);
      };

      membrane.pushResponse(withRound(createMockResponse([{ type: 'text', text: 'First.' }]),
        { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 400 }, { dropped: [dropped], mismatchAllowed: [] }));
      await turn('Run once.');
      assert.equal(membrane.calls.length, 1, 'the first turn\'s stream ran');
      assert.deepEqual(calibrated, [], 'its first call dropped a block: no sample');

      membrane.pushResponse(withRound(createMockResponse([{ type: 'text', text: 'Second.' }]),
        { inputTokens: 120, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 500 }, { dropped: [], mismatchAllowed: [] }));
      await turn('Run again.');
      assert.equal(membrane.calls.length, 2, 'the second turn\'s stream ran');
      assert.deepEqual(calibrated, [120 + 0 + 500], 'the next stream dropped none, and is a sample again');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a setting that is not true or false, and a thinkingBinding other than an object, null or false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-thinking-binding-refused-'));
    const storePath = join(dir, 'store.chronicle');
    const createWith = (settings: Record<string, unknown>) => AgentFramework.create({
      storePath, membrane: new MockMembrane().asMembrane(), agents: [agentWith(settings)], modules: [], syncIntervalMs: 0,
    } as never);
    try {
      for (const [settings, message] of [
        [{ thinkingBinding: { dropBlock: 'true' } }, `Agent "agent" thinkingBinding.dropBlock must be true or false, unquoted, not a string: ${DROP_BLOCK}`],
        [{ thinkingBinding: true }, 'Agent "agent" thinkingBinding must be an object, such as { binds: true, dropBlock: true }, not a boolean'],
      ] as const) {
        await assert.rejects(createWith(settings), (error: Error) => {
          assert.equal(error.message, message);
          return true;
        });
        assert.equal(existsSync(storePath), false, 'the refused config opened no store');
        assert.throws(() => newAgent(settings), (error: Error) => {
          assert.equal(error.message, message);
          return true;
        }, 'new Agent() refuses it too');
      }
      for (const settings of [{ thinkingBinding: null }, { thinkingBinding: false }, { thinkingBinding: { dropBlock: null } }]) {
        assert.equal(await sentThinking(settings), undefined, `${JSON.stringify(settings)} counts as left out`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Turns each external message into a user message and a request for inference. */
class InputModule implements Module {
  readonly name = 'input';
  async start() {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

class EchoTools implements Module {
  readonly name = 'test';
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() {
    return [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' as const, properties: {} } }];
  }
  async handleToolCall(_call: ToolCall) {
    return { success: true, data: {} };
  }
}

type Entry = { reason: string; path: string; message?: number };

/** A response whose usage event carries membrane's round report with the
 *  given thinking entries, or no report when none are given. Usage is
 *  cumulative across a stream's rounds, as membrane reports it. */
function withRound(
  response: NormalizedResponse,
  usage: DetailedUsage,
  thinking?: { dropped: Entry[]; mismatchAllowed: Entry[] },
): NormalizedResponse {
  return Object.assign(response, thinking ? { usage, round: { thinking } } : { usage });
}
