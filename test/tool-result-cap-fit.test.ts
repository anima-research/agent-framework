/**
 * An ordinary resident's inline cap is at most the smallest per-message bound
 * among the shared slot's readers, and a cut tool result's stored copy,
 * notice included, fits that bound. Each reader's strategy cuts a message
 * past its bound from the end, and the end is where the spill notice names
 * the file that holds the rest (Sol's #94 ruling: the spill file is the way
 * to the whole result). Where the cap leaves the notice its room under the
 * bound, the head stays at the cap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventResponse, Module, ProcessEvent, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, AutobiographicalStrategy } from '../src/index.js';
import { TOOL_RESULT_NOTICE_ROOM } from '../src/tool-image-ledger.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

/** A strategy that cuts any message past maxMessageTokens, as residents' do. */
const strategy = (maxMessageTokens: number) => new AutobiographicalStrategy({
  adaptiveResolution: true,
  foldingStrategy: 'kv-stable',
  recentWindowTokens: 30_000,
  kvStableReachTokens: 8_000,
  maxMessageTokens,
}) as never;

/** Its `fetch` tool returns the payload given for the call's id. */
class CannedToolModule implements Module {
  readonly name = 'canned';
  constructor(private payloadFor: (callId: string) => string) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'fetch', description: 'Returns the canned payload.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return { success: true, data: this.payloadFor(call.id) };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return { addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }], requestInference: true };
    }
    return {};
  }
}

/** 6,000 characters in 60 lines, so a cut shows where it fell. */
const PAYLOAD = Array.from({ length: 60 }, (_, i) => `line ${String(i).padStart(2, '0')} ${'x'.repeat(91)}`).join('\n');

type Content = Array<{ type: string; content?: unknown }>;
const toolResultTexts = (messages: unknown): string[] => {
  const texts: string[] = [];
  for (const m of messages as Array<{ content?: Content }>) {
    for (const b of m.content ?? []) if (b.type === 'tool_result') texts.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
  }
  return texts;
};
const toolResultText = (messages: unknown): string | null => toolResultTexts(messages)[0] ?? null;

/** The first agent calls `fetch` once, or once for each of `payloads` in one
 *  turn; the residents share one slot. */
async function withResidents(
  opts: { agents: Array<{ name: string; maxMessageTokens: number }>; mount?: string; payload?: string; payloads?: string[]; inlineMaxChars?: number; beforeStart?: (framework: AgentFramework) => void },
  run: (h: {
    framework: AgentFramework;
    stored: string;
    storedAll: string[];
    shownTo: (name: string) => Promise<string | null>;
    shownAllTo: (name: string) => Promise<string[]>;
  }) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'tool-result-cap-fit-'));
  const payloads = opts.payloads ?? [opts.payload ?? PAYLOAD];
  const callIds = payloads.map((_, i) => (i === 0 ? 'call_fetch' : `call_fetch_${i + 1}`));
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([
    { type: 'text', text: 'Fetching.' },
    ...callIds.map((id) => ({ type: 'tool_use' as const, id, name: 'canned--fetch', input: {} })),
  ], 'tool_use'));
  for (let i = 0; i < 4; i++) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Handled.' }]));
  const modules: Module[] = [new CannedToolModule((callId) => payloads[callIds.indexOf(callId)] ?? payloads[0]!)];
  let workspace: WorkspaceModule | null = null;
  if (opts.mount) {
    const mountDir = join(tempDir, 'mount');
    mkdirSync(mountDir, { recursive: true });
    workspace = new WorkspaceModule({ mounts: [{ name: opts.mount, path: mountDir, mode: 'read-write', watch: 'never' }] });
    modules.push(workspace as unknown as Module);
  }
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: opts.agents.map(({ name, maxMessageTokens }, i) => ({
      name,
      model: 'test-model',
      systemPrompt: `You are ${name}.`,
      ...(i === 0 ? { allowedTools: 'all' as const } : {}),
      strategy: strategy(maxMessageTokens),
    })),
    modules,
    syncIntervalMs: 0,
    ...(opts.inlineMaxChars !== undefined ? { toolResultInlineMaxChars: opts.inlineMaxChars } : {}),
  });
  workspace?.initStore(framework.getStore());
  try {
    opts.beforeStart?.(framework);
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: 'fetch it' }], metadata: {}, triggerInference: true } as unknown as ProcessEvent);
    const producer = opts.agents[0]!.name;
    let stored: string | null = null;
    for (const deadline = Date.now() + 20_000; stored === null && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 100));
      stored = toolResultText(framework.getAgent(producer)!.getContextManager().queryMessages({}).messages);
    }
    assert.ok(stored !== null, 'the tool result is stored');
    await run({
      framework,
      stored,
      storedAll: toolResultTexts(framework.getAgent(producer)!.getContextManager().queryMessages({}).messages),
      shownTo: async (name) => toolResultText((await framework.previewActivation(name)).messages),
      shownAllTo: async (name) => toolResultTexts((await framework.previewActivation(name)).messages),
    });
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** agent_settings get's view of an agent's inline cap. */
const capProvenance = (framework: AgentFramework, name: string) =>
  (framework as unknown as { collectAgentSettingsExtensions(): Map<string, { get(agentName: string): Record<string, unknown> }> })
    .collectAgentSettingsExtensions().get('_framework')!.get(name);

test("a resident's own bound clamps its cap, and the stored copy, notice included, fits it, so the resident still sees where the rest is", async () => {
  // maxMessageTokens 1000: a bound of 4000 characters, under the 24000 default.
  await withResidents({ agents: [{ name: 'solo', maxMessageTokens: 1000 }], mount: 'files' }, async ({ framework, stored, shownTo }) => {
    const cap = capProvenance(framework, 'solo');
    assert.equal(cap.tool_result_inline_max_chars_effective, 4000);
    assert.equal(cap.tool_result_inline_max_chars_clamped_by, 'strategy-bound');
    assert.ok(stored.length <= 4000, `the stored copy is ${stored.length} characters`);
    assert.match(stored, new RegExp(`^"?line 00 [^]*\\n\\n\\[truncated — showing ${4000 - TOOL_RESULT_NOTICE_ROOM} of \\d+ chars; full content: workspace file files/tool-results/`));
    // The bound holds the cap down, so raising it can't show more.
    assert.doesNotMatch(stored, /raise the inline cap/);
    assert.equal(await shownTo('solo'), stored, 'the resident is shown the stored copy whole, its notice included');
  });
});

test("a resident's cap is the smallest bound among the shared slot's readers, so each of them is shown where the rest is", async () => {
  // scout's own bound (40000) leaves the 24000 default; ward's is 4000.
  await withResidents({ agents: [{ name: 'scout', maxMessageTokens: 10_000 }, { name: 'ward', maxMessageTokens: 1000 }], mount: 'files' }, async ({ framework, stored, shownTo }) => {
    const cap = capProvenance(framework, 'scout');
    assert.equal(cap.tool_result_inline_max_chars_effective, 4000);
    assert.equal(cap.tool_result_inline_max_chars_clamped_by, 'reader-bound');
    assert.equal(capProvenance(framework, 'ward').tool_result_inline_max_chars_clamped_by, 'strategy-bound');
    assert.ok(stored.length <= 4000, `the stored copy is ${stored.length} characters`);
    assert.match(stored, /full content: workspace file files\/tool-results\//);
    assert.equal(await shownTo('ward'), stored, 'ward is shown the stored copy whole, its notice included');
    assert.equal(await shownTo('scout'), stored);
  });
});

test("a turn's results that pass one message's bound together each take a share of it, so each result's notice survives the reader's cut", async () => {
  // Two 6,000-character results in one turn, at a bound of 4,000: the strategy
  // budgets the message, not each result, spending its 4,000 in block order.
  const writes: string[] = [];
  const countWrites = (framework: AgentFramework) => {
    const internals = framework as unknown as { writeToolResultFile(label: string, content: string): Promise<unknown> };
    const write = internals.writeToolResultFile.bind(framework);
    internals.writeToolResultFile = (label, content) => { writes.push(label); return write(label, content); };
  };
  await withResidents({ agents: [{ name: 'solo', maxMessageTokens: 1000 }], mount: 'files', payloads: [PAYLOAD, PAYLOAD], beforeStart: countWrites }, async ({ storedAll, shownAllTo }) => {
    // Each result's file is written once: its cut by share reuses the first cut's.
    assert.equal(writes.length, 2, JSON.stringify(writes));
    assert.equal(storedAll.length, 2);
    const total = storedAll.reduce((sum, text) => sum + text.length, 0);
    assert.ok(total <= 4000, `the turn's results are ${total} characters together`);
    for (const text of storedAll) assert.match(text, /full content: workspace file files\/tool-results\//);
    assert.deepEqual(await shownAllTo('solo'), storedAll, 'each result is shown whole, its notice included');
  });
});

test("a turn's results that fit one message's bound together are each stored as they would be alone", async () => {
  // 3,000 and 500 characters at a bound of 4,000: under a share of 2,000 the
  // first would spill, but together they fit, so neither is cut.
  const payloads = ['y'.repeat(3000), 'z'.repeat(500)];
  await withResidents({ agents: [{ name: 'solo', maxMessageTokens: 1000 }], mount: 'files', payloads }, async ({ storedAll, shownAllTo }) => {
    assert.deepEqual(storedAll, payloads.map((payload) => JSON.stringify(payload)));
    assert.deepEqual(await shownAllTo('solo'), storedAll);
  });
});

test('without a writable workspace, the stored copy fits the smallest reader\'s bound, its notice saying nothing kept the rest', async () => {
  await withResidents({ agents: [{ name: 'scout', maxMessageTokens: 10_000 }, { name: 'ward', maxMessageTokens: 1000 }] }, async ({ stored, shownTo }) => {
    assert.ok(stored.length <= 4000, `the stored copy is ${stored.length} characters`);
    assert.match(stored, /\n\n\[truncated — original was \d+ chars; no writable workspace mount without an include, full content not retained\]$/);
    assert.equal(await shownTo('ward'), stored);
  });
});

test('a cap that leaves the notice its room under the bound keeps its head at the cap', async () => {
  // A bound of 40000, above the 24000 default: nothing threatens the notice.
  const payload = 'y'.repeat(30_000);
  await withResidents({ agents: [{ name: 'solo', maxMessageTokens: 10_000 }], mount: 'files', payload }, async ({ stored, shownTo }) => {
    assert.equal(stored.indexOf('\n\n[truncated'), 24000, 'the head is the cap');
    assert.match(stored, /Or raise the inline cap via agent_settings update tool_result_inline_max_chars\.\]$/);
    assert.match(stored, /\n\n\[truncated — showing 24000 of \d+ chars; full content: workspace file files\/tool-results\//);
    assert.equal(await shownTo('solo'), stored);
  });
});

test("a resident with no bound of its own takes another reader's, so its cut result still fits the slot", async () => {
  // scout's strategy sets no maxMessageTokens (0, no limit); ward's bound is 4000.
  await withResidents({ agents: [{ name: 'scout', maxMessageTokens: 0 }, { name: 'ward', maxMessageTokens: 1000 }], mount: 'files' }, async ({ framework, stored, shownTo }) => {
    const cap = capProvenance(framework, 'scout');
    assert.equal(cap.tool_result_inline_max_chars_effective, 4000);
    assert.equal(cap.tool_result_inline_max_chars_clamped_by, 'reader-bound');
    assert.ok(stored.length <= 4000, `the stored copy is ${stored.length} characters`);
    assert.match(stored, /full content: workspace file files\/tool-results\//);
    assert.equal(await shownTo('ward'), stored);
  });
});

test("an ephemeral agent's store has itself as its only reader: a resident's bound doesn't reach it, and its bound doesn't reach a resident", async () => {
  await withResidents({ agents: [{ name: 'ward', maxMessageTokens: 1000 }] }, async ({ framework }) => {
    const resolve = (agent: unknown) => {
      const { cap, clampedBy } = (framework as unknown as { resolveToolResultInlineCap(agent: unknown): { cap: number; clampedBy: string | null } })
        .resolveToolResultInlineCap(agent);
      return { cap, clampedBy };
    };
    const wide = await framework.createEphemeralAgent({ name: 'wide', model: 'test-model', systemPrompt: 'You are wide.', strategy: strategy(10_000) });
    const narrow = await framework.createEphemeralAgent({ name: 'narrow', model: 'test-model', systemPrompt: 'You are narrow.', strategy: strategy(250) });
    try {
      assert.deepEqual(resolve(wide.agent), { cap: 24_000, clampedBy: null }, "the default cap, under wide's own bound of 40000, whatever ward's");
      assert.deepEqual(resolve(narrow.agent), { cap: 1000, clampedBy: 'strategy-bound' }, "narrow's own bound");
      assert.deepEqual(resolve(framework.getAgent('ward')), { cap: 4000, clampedBy: 'strategy-bound' }, "ward's own bound, not narrow's 1000");
    } finally {
      wide.cleanup();
      narrow.cleanup();
    }
  });
});

test("a script's wake, spilled past the cap, fits the readers' bound with its notice, so the resident still sees where the rest is", async () => {
  await withResidents({ agents: [{ name: 'solo', maxMessageTokens: 1000 }], mount: 'files' }, async ({ framework }) => {
    // The wake's whole text is one message, which the resident's strategy
    // cuts at 4000 characters from its end.
    const text = `[script s1-test] Woke you with wake_agent(), 0 min after it started (wake 1 of 100): ${JSON.stringify({ blob: 'w'.repeat(6000) })}`;
    await (framework as unknown as { scriptWake(agent: string, id: string, text: string, label: string): Promise<void> })
      .scriptWake('solo', 's1-test', text, 'wake-test');
    const messages = framework.getAgent('solo')!.getContextManager().queryMessages({}).messages as unknown as Array<{
      content: Array<{ type: string; text?: string }>; metadata?: { source?: string };
    }>;
    const wake = messages.find((m) => m.metadata?.source === 'code-execution-script');
    assert.ok(wake, 'the wake is stored');
    const stored = wake.content[0]!.text!;
    assert.ok(stored.length <= 4000, `the stored wake is ${stored.length} characters`);
    assert.ok(stored.startsWith('[script s1-test] Woke you with wake_agent()'), stored.slice(0, 80));
    assert.match(stored, /\[truncated — showing \d+ of \d+ chars; full content: workspace file files\/tool-results\/\S+\. [^\]]*keeping limitChars\.\]$/);
    // The wake's own file, which no other result in the turn names.
    assert.ok(stored.includes('files/tool-results/script-wake-test.txt'), stored.slice(-300));
    const shown = JSON.stringify((await framework.previewActivation('solo')).messages);
    assert.ok(shown.includes('full content: workspace file files/tool-results/script-wake-test.txt'), "the resident is shown the wake's notice");
  });
});

test("the puppet's call stores its result within the readers' bound, notice included", async () => {
  await withResidents({ agents: [{ name: 'solo', maxMessageTokens: 1000 }], mount: 'files' }, async ({ framework }) => {
    const { toolUseId } = await framework.puppetToolCall('solo', 'canned--fetch', {});
    const messages = framework.getAgent('solo')!.getContextManager().queryMessages({}).messages as unknown as Array<{
      content: Array<{ type: string; toolUseId?: string; content?: unknown }>;
    }>;
    const block = messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.toolUseId === toolUseId);
    assert.ok(block, "the puppet's result is stored");
    const stored = String(block.content);
    assert.ok(stored.length <= 4000, `the stored copy is ${stored.length} characters`);
    assert.match(stored, /\[truncated — showing \d+ of \d+ chars; full content: workspace file files\/tool-results\/\S+\. /);
  });
});

test("a cap the bound's fit already holds the head under gets no offer to raise it, since a higher cap would show no more", async () => {
  // A bound of 4000 leaves a head of at most 4000 less the notice's room, so
  // a cap of 3800 and one of 4000 keep the same head.
  await withResidents({ agents: [{ name: 'solo', maxMessageTokens: 1000 }], mount: 'files', inlineMaxChars: 3800 }, async ({ framework, stored }) => {
    assert.equal(capProvenance(framework, 'solo').tool_result_inline_max_chars_effective, 3800);
    assert.ok(stored.length <= 4000, `the stored copy is ${stored.length} characters`);
    assert.match(stored, /\[truncated — showing \d+ of \d+ chars; full content: workspace file files\/tool-results\/\S+\. /);
    assert.doesNotMatch(stored, /raise the inline cap/);
  });
});

test("a result between the cap and the bound is offered a higher cap, which would store it whole", async () => {
  // The 3,900 characters are stored as a JSON string, 3,902 with its quotes:
  // past the cap of 3,800, and within the bound of 4,000.
  await withResidents({ agents: [{ name: 'solo', maxMessageTokens: 1000 }], mount: 'files', inlineMaxChars: 3800, payload: 'y'.repeat(3900) }, async ({ stored }) => {
    assert.match(stored, /\[truncated — showing \d+ of 3902 chars; full content: workspace file files\/tool-results\/\S+\. /);
    assert.match(stored, /raise the inline cap/);
  });
});
