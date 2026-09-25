/**
 * Prose outbox end to end: a real framework with `proseOutbox` enabled and a
 * real stdio connector that dies mid-publish after posting, is respawned by
 * the framework's reconnect loop, and dedupes the retry against its own
 * channel history. The resident's window gets honest, non-waking notices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import type { Module, ProcessEvent, EventResponse, ToolDefinition, ToolResult } from '../src/index.js';

/** Turns an external 'go' into a user message that starts a turn. */
class WakeModule implements Module {
  readonly name = 'waker';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools', isError: true }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'Ian', content: [{ type: 'text', text: 'go' }] }], requestInference: true };
  }
}

const FIXTURE = fileURLToPath(new URL('./fixtures/prose-outbox-mcpl-server.mjs', import.meta.url));

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
}

type Internals = {
  channelRegistry: {
    routeSpeech(agent: string, text: string, channelId: string): Promise<{ delivered: boolean; queued?: boolean } | null>;
    getOutboxEntries(): ReadonlyArray<{ outcome: string }>;
    getDescriptor(id: string): unknown;
  };
  agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }> } }>;
};

test('connector dies after posting: queued, retried after respawn, deduped, resident told', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prose-outbox-e2e-'));
  const postLog = join(dir, 'posts.jsonl');
  const modeFile = join(dir, 'mode');
  writeFileSync(modeFile, 'ok idem');
  const posts = () => existsSync(postLog)
    ? readFileSync(postLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string; key?: string })
    : [];

  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
    mcplServers: [{
      id: 'chat',
      command: process.execPath,
      args: [FIXTURE],
      env: { POST_LOG: postLog, MODE_FILE: modeFile },
      reconnect: true,
      reconnectIntervalMs: 100,
      reconnectMaxIntervalMs: 100,
      requestTimeoutMs: 2_000,
    }],
    proseOutbox: { enabled: true },
  });
  const fw = framework as unknown as Internals;
  try {
    await waitFor('channel registered', () => !!fw.channelRegistry.getDescriptor('chat:room'));

    // A normal reply; the result echoes the key, so the host learns this
    // connector dedupes.
    assert.equal((await fw.channelRegistry.routeSpeech('assistant', 'before the outage', 'chat:room'))?.delivered, true);

    // The connector posts, then dies before answering: outcome unknown.
    writeFileSync(modeFile, 'crash idem');
    const r = await fw.channelRegistry.routeSpeech('assistant', 'during the outage', 'chat:room');
    assert.deepEqual(r, { delivered: false, queued: true, channelId: 'chat:room' });
    assert.equal(fw.channelRegistry.getOutboxEntries()[0]?.outcome, 'unknown');
    assert.ok(existsSync(join(dir, 'store', 'recovery', 'prose-outbox.json')), 'queue file at the default path');

    // Respawned by the reconnect loop; the kick on reconnect retries it.
    writeFileSync(modeFile, 'ok idem');
    await waitFor('outbox drained after reconnect', () => fw.channelRegistry.getOutboxEntries().length === 0);

    assert.deepEqual(
      posts().map((p) => p.text),
      ['before the outage', 'during the outage'],
      'the retry found its own post in the channel history instead of posting twice',
    );

    const notices = fw.agents.get('assistant')!.getContextManager().getAllMessages()
      .filter((m) => m.metadata?.system === true)
      .map((m) => ({ kind: m.metadata?.kind, text: m.content[0]?.text ?? '' }));
    const delayed = notices.find((n) => n.kind === 'delivery-delayed');
    const late = notices.find((n) => n.kind === 'delivered-late');
    assert.ok(delayed, 'queued notice recorded');
    assert.match(delayed!.text, /couldn't be delivered yet/);
    assert.match(delayed!.text, /you don't need to resend it/);
    assert.match(delayed!.text, /starting "during the outage"/, 'names which reply');
    assert.match(delayed!.text, /kept across restarts/);
    assert.ok(late, 'late-delivery notice recorded');
    assert.match(late!.text, /was delivered at \d\d:\d\d/);
    assert.match(late!.text, /starting "during the outage"/);
    assert.equal(membrane.calls.length, 0, 'notices never wake the agent');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('send_message through a real agent turn: connector dies → "[queued]" tool result → replayed once after respawn', async () => {
  const { createMockResponse } = await import('./helpers/mock-membrane.js');
  const dir = mkdtempSync(join(tmpdir(), 'prose-outbox-tool-e2e-'));
  const postLog = join(dir, 'posts.jsonl');
  const modeFile = join(dir, 'mode');
  writeFileSync(modeFile, 'ok idem');
  const posts = () => existsSync(postLog)
    ? readFileSync(postLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string; via?: string; delayReason?: string })
    : [];

  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [new WakeModule()],
    mcplServers: [{
      id: 'chat',
      command: process.execPath,
      args: [FIXTURE],
      env: { POST_LOG: postLog, MODE_FILE: modeFile },
      reconnect: true,
      reconnectIntervalMs: 100,
      reconnectMaxIntervalMs: 100,
      requestTimeoutMs: 2_000,
    }],
    proseOutbox: { enabled: true, tools: ['send_message'] },
  });
  const fw = framework as unknown as Internals;
  const turn = async (content: string) => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: `call-${content}`, name: 'mcpl--chat--send_message', input: { channelId: 'chat:room', content } },
    ] as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([] as never));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
    await (framework as unknown as { runUntilIdle(): Promise<void> }).runUntilIdle();
  };
  const toolResults = () => fw.agents.get('assistant')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content)
    .filter((b) => b.type === 'tool_result')
    .map((b) => JSON.stringify(b));
  try {
    await waitFor('channel registered', () => !!fw.channelRegistry.getDescriptor('chat:room'));

    await turn('before the outage'); // key echoed: this tool dedupes
    writeFileSync(modeFile, 'crash-before idem');
    await turn('during the outage');
    const last = toolResults().at(-1) ?? '';
    assert.match(last, /\[queued\] Not sent yet/, 'the agent sees "queued", not an error');
    assert.match(last, /don't need to resend/);

    writeFileSync(modeFile, 'ok idem');
    await waitFor('queued send replayed', () => fw.channelRegistry.getOutboxEntries().length === 0);
    const sent = posts().filter((p) => p.via === 'send_message');
    assert.deepEqual(sent.map((p) => p.text), ['before the outage', 'during the outage'], 'replayed exactly once');
    assert.equal(sent[1]!.delayReason, 'unanswered');

    const notices = fw.agents.get('assistant')!.getContextManager().getAllMessages()
      .filter((m) => m.metadata?.system === true).map((m) => m.content[0]?.text ?? '');
    assert.ok(notices.some((t) => /^\[delivered-late\] Your send_message to #room \(chat:room\) starting "during the outage"/.test(t)));
    assert.ok(!notices.some((t) => t.startsWith('[delivery-delayed]')), 'no duplicate notice: the tool result already said so');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
