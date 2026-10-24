/**
 * A context injection, a hook's or a module's, isn't stored, so it goes out
 * as given in every request while it's injected. A lone UTF-16 surrogate in
 * its text or its namespace reaches the request as U+FFFD, as the context
 * store would keep it: a provider refuses a request that carries a lone half
 * (#695).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type Module, type ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/hook-injection-mcpl-server.mjs');
const LONE = 'HOOK cut \ud83d here';
const MENDED = 'HOOK cut \ufffd here';

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) await frameworks.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Turns an external message into a user message and asks for inference. */
class Trigger implements Module {
  readonly name = 'trigger';
  async start() {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; }
  async onProcess(event: ProcessEvent) {
    return event.type === 'external-message'
      ? { addMessages: [{ participant: 'user', content: [{ type: 'text' as const, text: 'hello' }] }], requestInference: true }
      : {};
  }
}

async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every string under `value` that holds the hook's marker. */
function hookTexts(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (v.includes('HOOK')) found.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return found;
}

const SHAPES = {
  string: 'a string',
  blocks: 'a text block',
  'unknown-type': 'a block of a type this host can\'t show, named by it',
} as const;

const CASES: Array<{ position: string; shape: keyof typeof SHAPES; grant?: string[]; inNamespace?: 'string' | 'array' }> = [
  { position: 'beforeUser', shape: 'blocks' },
  { position: 'beforeUser', shape: 'unknown-type' },
  { position: 'beforeUser', shape: 'string' },
  { position: 'system', shape: 'blocks', grant: ['tools', 'contextHooks.beforeInference.inject.system'] },
  { position: 'system', shape: 'string', grant: ['tools', 'contextHooks.beforeInference.inject.system'] },
  // context-manager names a beforeUser injection's message by its namespace.
  { position: 'beforeUser', shape: 'blocks', inNamespace: 'string' },
  { position: 'afterUser', shape: 'blocks', inNamespace: 'string' },
  // One that isn't a string, which §10.4 doesn't allow, is read by its text form.
  { position: 'beforeUser', shape: 'blocks', inNamespace: 'array' },
];

for (const { position, shape, grant, inNamespace } of CASES) {
  const where = inNamespace === 'array' ? "'s namespace given as an array" : inNamespace ? "'s namespace" : ` given as ${SHAPES[shape]}`;
  test(`a lone surrogate in a ${position} hook injection${where} reaches the request as U+FFFD`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-hook-well-formed-')); dirs.push(dir);
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello.' }]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.' }],
      modules: [new Trigger()],
      mcplServers: [{
        id: 'notes',
        command: process.execPath,
        args: [FIXTURE],
        env: {
          POSITION: position,
          SHAPE: shape,
          ...(inNamespace
            ? { TEXT_JSON: JSON.stringify('a note'), NAMESPACE_JSON: JSON.stringify(inNamespace === 'array' ? [LONE] : LONE) }
            : { TEXT_JSON: JSON.stringify(LONE) }),
        },
        ...(grant ? { enabledCapabilities: grant } : {}),
      }],
      syncIntervalMs: 0,
    });
    frameworks.push(framework);
    await framework.start();
    await until(() => framework.getAllTools().some((t) => t.name.endsWith('ready')), 'the fixture to connect');
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await until(() => membrane.calls.length >= 1, 'the request');
    const sent = hookTexts(membrane.calls[0]);
    assert.ok(sent.length > 0, "the request carries the hook's injection");
    for (const t of sent) assert.ok(t.isWellFormed(), `the injection's text is well formed: ${JSON.stringify(t)}`);
    assert.ok(sent.some((t) => t.includes(MENDED)), 'the lone half goes out as U+FFFD');
    if (inNamespace) {
      assert.ok(
        membrane.calls[0].messages.some((m) => m.participant === `system_context:${MENDED}`),
        "the injection's message is named by its namespace, well formed",
      );
    }
  });
}

/** A Trigger that also gives one context injection, as a module's gatherContext does. */
class Injecting implements Module {
  readonly name = 'injecting';
  private readonly trigger = new Trigger();
  constructor(
    private readonly position: 'beforeUser' | 'system',
    private readonly content: Array<Record<string, unknown>> = [{ type: 'text', text: LONE }],
  ) {}
  async start() {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; }
  onProcess(event: ProcessEvent) { return this.trigger.onProcess(event); }
  async gatherContext() {
    return [{ namespace: 'mod', position: this.position, content: this.content as never }];
  }
}

for (const position of ['beforeUser', 'system'] as const) {
  test(`a lone surrogate in a module's ${position} injection reaches the request as U+FFFD`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-module-well-formed-')); dirs.push(dir);
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello.' }]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.' }],
      modules: [new Injecting(position)],
      syncIntervalMs: 0,
    });
    frameworks.push(framework);
    await framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await until(() => membrane.calls.length >= 1, 'the request');
    const sent = hookTexts(membrane.calls[0]);
    assert.ok(sent.length > 0, "the request carries the module's injection");
    for (const t of sent) assert.ok(t.isWellFormed(), `the injection's text is well formed: ${JSON.stringify(t)}`);
    assert.ok(sent.some((t) => t.includes(MENDED)), 'the lone half goes out as U+FFFD');
  });
}

test("a lone surrogate in an injection given straight to an Agent's inference reaches the request as U+FFFD", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-agent-well-formed-')); dirs.push(dir);
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.' }],
    modules: [],
    syncIntervalMs: 0,
  });
  frameworks.push(framework);
  await framework.start();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello.' }]));
  await framework.getAgent('prime')!.runInferenceWithInjections([], [
    { namespace: LONE, position: 'beforeUser', content: [{ type: 'text', text: LONE }] },
    { namespace: 'sys', position: 'system', content: [{ type: 'text', text: LONE }] },
  ]);
  assert.equal(membrane.calls.length, 1, 'the premise: one request went out');
  const sent = hookTexts(membrane.calls[0]);
  assert.ok(sent.length > 0, 'the request carries the injections');
  for (const t of sent) assert.ok(t.isWellFormed(), `the injection's text is well formed: ${JSON.stringify(t)}`);
  assert.ok(membrane.calls[0]!.messages.some((m) => m.participant === `system_context:${MENDED}`), 'its namespace too');
});

test("a lone surrogate in a module's injected image link reaches the request as U+FFFD", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-module-image-well-formed-')); dirs.push(dir);
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello.' }]));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.' }],
    modules: [new Injecting('beforeUser', [{ type: 'image', source: { type: 'url', url: 'https://example.com/HOOK\ud83d.png' } }])],
    syncIntervalMs: 0,
  });
  frameworks.push(framework);
  await framework.start();
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
  await until(() => membrane.calls.length >= 1, 'the request');
  const sent = hookTexts(membrane.calls[0]);
  assert.ok(sent.length > 0, "the request carries the module's image");
  for (const t of sent) assert.ok(t.isWellFormed(), `the image's link is well formed: ${JSON.stringify(t)}`);
  assert.ok(sent.includes('https://example.com/HOOK\ufffd.png'), 'the lone half goes out as U+FFFD');
});
