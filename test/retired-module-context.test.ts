import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, ShutdownTimeoutError, type Module, type ModuleContext, type ProcessEvent, type ToolCall } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const said = (event: ProcessEvent): string => `${event.type}:${String((event as { content?: unknown }).content ?? '')}`;
const external = (content: string): ProcessEvent => ({ type: 'external-message', source: 'probe', content, metadata: {} }) as ProcessEvent;

interface Probe {
  module: Module;
  ctx: () => ModuleContext;
  seen: string[];
  spoke: string[];
  calls: string[];
}

function probe(name: string, opts: { onStart?: (ctx: ModuleContext) => void; stop?: () => Promise<void>; tool?: boolean } = {}): Probe {
  let ctx: ModuleContext | undefined;
  const seen: string[] = [];
  const spoke: string[] = [];
  const calls: string[] = [];
  const module: Module = {
    name,
    async start(given) { ctx = given; opts.onStart?.(given); },
    stop: opts.stop ?? (async () => {}),
    async onProcess(event) { seen.push(said(event)); return {}; },
    async onAgentSpeech(agentName) { spoke.push(agentName); },
    getTools: () => (opts.tool ? [{ name: 'echo', description: 'Answers.', inputSchema: { type: 'object', properties: {} } }] : []),
    async handleToolCall(call: ToolCall) { calls.push(call.id); return { success: true, data: 'echoed' }; },
  };
  return { module, ctx: () => ctx!, seen, spoke, calls };
}

async function withFramework(modules: Module[], run: (framework: AgentFramework) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'retired-module-context-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  const framework = await AgentFramework.create({
    store,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules,
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  try {
    await run(framework);
  } finally {
    await framework.stop().catch(() => {});
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function retiredLines<T>(run: () => T | Promise<T>, pattern = /has stopped, so its/): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (pattern.test(line)) lines.push(line);
    else error(...args);
  };
  try {
    return { value: await run(), lines };
  } finally {
    console.error = error;
  }
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const moduleState = (framework: AgentFramework, name: string) =>
  framework.getStore().getStateJson(`modules/${name}/state`) as Record<string, unknown> | null;

test("a removed module's pushes, through pushEvent() and its queue handle, reach no module, a later one of its name included, and each is dropped with a line", async () => {
  const gone = probe('gone');
  const stays = probe('stays');
  await withFramework([gone.module, stays.module], async (framework) => {
    framework.start();
    await framework.removeModule('gone');
    const namesake = probe('gone');
    await framework.addModule(namesake.module);
    const old = gone.ctx();
    const result = (callId: string): ProcessEvent => ({
      type: 'tool-result', callId, toolName: 'fetch', agentName: 'assistant', moduleName: 'gone', result: { success: true },
    }) as ProcessEvent;
    const { lines } = await retiredLines(() => {
      old.pushEvent(external('late-1'));
      old.queue.push(external('late-2'));
      old.pushEvent(result('c1'));
      old.queue.push(result('c2'));
    }, /arrived after/);
    framework.pushEvent(external('marker'));
    await waitFor('the marker pushed after them', () => stays.seen.includes('external-message:marker') && namesake.seen.includes('external-message:marker'));
    assert.deepEqual(stays.seen, ['external-message:marker']);
    assert.deepEqual(namesake.seen, ['external-message:marker']);
    assert.deepEqual(lines, [
      "[framework] a 'external-message' event from module gone arrived after that module stopped — dropped",
      "[framework] a 'external-message' event from module gone arrived after that module stopped — dropped",
      '[framework] assistant: result of tool call c1 (fetch, gone) arrived after its module stopped — dropped; the tool succeeded',
      '[framework] assistant: result of tool call c2 (fetch, gone) arrived after its module stopped — dropped; the tool succeeded',
    ]);
  });
});

test("a removed module's state and log-state writes change nothing a later module of its name reads, its reads still answer, and each write logs once", async () => {
  const gone = probe('gone', {
    onStart: (ctx) => {
      ctx.registerLogState('events');
      ctx.appendToLog('events', { n: 1 });
      ctx.setState({ v: 1 });
    },
  });
  await withFramework([gone.module], async (framework) => {
    await framework.removeModule('gone');
    const namesake = probe('gone', { onStart: (ctx) => ctx.registerLogState('events') });
    await framework.addModule(namesake.module);
    const stateBefore = namesake.ctx().getState();
    const logBefore = namesake.ctx().getLog('events');
    const old = gone.ctx();
    const { lines } = await retiredLines(() => {
      old.setState({ v: 2 });
      old.setState({ v: 3 });
      old.registerLogState('late');
      old.appendToLog('events', { n: 2 });
      old.editLogItem('events', 0, { n: 0 });
    });
    assert.deepEqual(namesake.ctx().getState(), stateBefore);
    assert.deepEqual(namesake.ctx().getLog('events'), logBefore);
    assert.deepEqual(old.getState(), stateBefore, 'its own state still reads');
    assert.deepEqual(old.getLog('events'), [{ n: 1 }], 'its own log still reads');
    assert.deepEqual(lines.map((line) => line.match(/its (\S+)\(\) call/)?.[1]), ['setState', 'registerLogState', 'appendToLog', 'editLogItem']);
  });
});

test("a removed module's addMessage() answers '' and adds nothing, its editMessage() and removeMessage() leave a message as it was, and its reads still answer", async () => {
  const gone = probe('gone');
  await withFramework([gone.module], async (framework) => {
    const kept = gone.ctx().addMessage('user', text('kept'), { external: { source: 'probe', id: 'k1' } } as never);
    await framework.removeModule('gone');
    const window = framework.getAgent('assistant')!.getContextManager();
    const count = window.getAllMessages().length;
    const old = gone.ctx();
    const { value: added, lines } = await retiredLines(() => {
      const id = old.addMessage('user', text('late'));
      old.editMessage(kept, text('edited'));
      old.removeMessage(kept);
      return id;
    });
    assert.equal(added, '');
    assert.equal(window.getAllMessages().length, count);
    assert.deepEqual(old.getMessage(kept)?.content, text('kept'));
    assert.deepEqual(old.queryMessages({ source: 'probe' }).messages.map((m) => m.id), [kept]);
    assert.equal(old.findMessageByExternalId('probe', 'k1'), kept);
    assert.deepEqual(lines.map((line) => line.match(/its (\S+)\(\) call/)?.[1]), ['addMessage', 'editMessage', 'removeMessage']);
  });
});

test("a removed module's callTool() resolves with an error result and runs no tool, and its getModule() answers null", async () => {
  const gone = probe('gone');
  const stays = probe('stays', { tool: true });
  await withFramework([gone.module, stays.module], async (framework) => {
    await framework.removeModule('gone');
    const old = gone.ctx();
    const { value, lines } = await retiredLines(async () => ({
      result: await old.callTool({ id: 'late-call', name: 'stays--echo', input: {} }),
      found: old.getModule('stays'),
    }));
    assert.equal(value.result.success, false);
    assert.equal(value.result.isError, true);
    assert.match(String(value.result.error), /module "gone" has stopped, so its call of stays--echo wasn't made/);
    assert.deepEqual(stays.calls, []);
    assert.equal(value.found, null);
    assert.deepEqual(lines.map((line) => line.match(/its (\S+)\(\) call/)?.[1]), ['callTool', 'getModule']);
  });
});

test("a removed module's trace subscriptions end, one it asks for afterwards gets nothing, and its notifyOps() raises no alert", async () => {
  let fromStart = 0;
  const gone = probe('gone', { onStart: (ctx) => { ctx.onTrace(() => { fromStart++; }); } });
  await withFramework([gone.module], async (framework) => {
    const alerts: string[] = [];
    framework.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(String((event as { kind?: unknown }).kind)); });
    await framework.removeModule('gone');
    const atRemoval = fromStart;
    let later = 0;
    const old = gone.ctx();
    const { value: unsubscribe, lines } = await retiredLines(() => {
      old.notifyOps?.('late-alert', 'assistant', 'from a removed module');
      return old.onTrace(() => { later++; });
    });
    await framework.addModule(probe('next').module);
    assert.equal(typeof unsubscribe, 'function');
    assert.equal(fromStart, atRemoval, 'the subscription from start() ended at the removal');
    assert.equal(later, 0);
    assert.ok(!alerts.includes('late-alert'), alerts.join(', '));
    assert.deepEqual(lines.map((line) => line.match(/its (\S+)\(\) call/)?.[1]), ['notifyOps', 'onTrace']);
  });
});

test("a removed module's speech-handler calls neither add a handler nor remove a later module's of its name", async () => {
  const gone = probe('gone', { onStart: (ctx) => ctx.registerSpeechHandler('*') });
  await withFramework([gone.module], async (framework) => {
    await framework.removeModule('gone');
    const namesake = probe('gone', { onStart: (ctx) => ctx.registerSpeechHandler('*') });
    await framework.addModule(namesake.module);
    const old = gone.ctx();
    const { lines } = await retiredLines(() => {
      old.registerSpeechHandler('*');
      old.unregisterSpeechHandler();
    });
    const registry = (framework as unknown as { moduleRegistry: { dispatchSpeech(agent: string, content: ContentBlock[], context: never): Promise<void> } }).moduleRegistry;
    await registry.dispatchSpeech('assistant', text('spoken'), {} as never);
    assert.deepEqual(namesake.spoke, ['assistant'], 'one handler, the later module\'s');
    assert.deepEqual(gone.spoke, []);
    assert.deepEqual(lines.map((line) => line.match(/its (\S+)\(\) call/)?.[1]), ['registerSpeechHandler', 'unregisterSpeechHandler']);
  });
});

test("a removed module's findMessageByExternalId() answers as before without changing the mapping it stored", async () => {
  const gone = probe('gone');
  const stays = probe('stays');
  await withFramework([gone.module, stays.module], async (framework) => {
    const ctx = gone.ctx();
    const stale = ctx.addMessage('user', text('removed later'), { external: { source: 'probe', id: 'stale' } } as never);
    await framework.quiesce({ reason: 'test' });
    ctx.addMessage('user', text('held'), { external: { source: 'probe', id: 'held' } } as never);
    await framework.resume();
    stays.ctx().removeMessage(stale);
    const landed = stays.ctx().queryMessages({ source: 'probe', externalIds: ['held'] }).messages[0]!.id;
    await framework.removeModule('gone');
    const mapping = () => (moduleState(framework, 'gone')!.externalIdMap as Record<string, string>);
    const before = { ...mapping() };
    assert.deepEqual(before, { 'probe:stale': stale, 'probe:held': '' }, 'the entries a running module would update');
    const { value, lines } = await retiredLines(() => [ctx.findMessageByExternalId('probe', 'stale'), ctx.findMessageByExternalId('probe', 'held')]);
    assert.deepEqual(value, [null, landed]);
    assert.deepEqual(mapping(), before);
    assert.deepEqual(lines, []);
  });
});

test("a framework's completed stop() retires every module's context", async () => {
  const gone = probe('gone');
  const stays = probe('stays', { tool: true });
  await withFramework([gone.module, stays.module], async (framework) => {
    gone.ctx().setState({ v: 1 });
    framework.start();
    await framework.stop();
    const old = gone.ctx();
    const { value, lines } = await retiredLines(async () => {
      old.setState({ v: 2 });
      return old.callTool({ id: 'after-stop', name: 'stays--echo', input: {} });
    });
    assert.deepEqual(moduleState(framework, 'gone'), { v: 1, externalIdMap: {} });
    assert.equal(value.success, false);
    assert.deepEqual(stays.calls, []);
    assert.deepEqual(lines.map((line) => line.match(/its (\S+)\(\) call/)?.[1]), ['setState', 'callTool']);
  });
});

test("a module whose stop() outlasts stop()'s budget keeps a working context until its stop() settles, and its writes from inside stop() land", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let ctx!: ModuleContext;
  const gone = probe('gone', {
    onStart: (given) => { ctx = given; },
    stop: async () => {
      await released;
      ctx.setState({ flushed: true });
    },
  });
  await withFramework([gone.module], async (framework) => {
    framework.start();
    await assert.rejects(framework.stop(100), (error: unknown) => error instanceof ShutdownTimeoutError);
    ctx.setState({ meanwhile: true });
    assert.equal(moduleState(framework, 'gone')!.meanwhile, true, 'not retired while its stop() runs');
    release();
    await waitFor("the module's stop() to settle", () => !framework.getAllModules().some((m) => m.name === 'gone'));
    assert.equal(moduleState(framework, 'gone')!.flushed, true, 'its write from inside stop() landed');
    const { lines } = await retiredLines(() => ctx.setState({ late: true }));
    assert.equal(moduleState(framework, 'gone')!.late, undefined);
    assert.equal(lines.length, 1, lines.join('\n'));
  });
});

test('a module whose stop() fails keeps a working context, and a retry that succeeds retires it', async () => {
  let failing = true;
  const gone = probe('gone', { stop: async () => { if (failing) throw new Error('injected stop failure'); } });
  await withFramework([gone.module], async (framework) => {
    const old = gone.ctx();
    await assert.rejects(framework.removeModule('gone'), /injected stop failure/);
    old.setState({ after: 'failed stop' });
    assert.equal(moduleState(framework, 'gone')!.after, 'failed stop');
    assert.ok(framework.getAllModules().some((m) => m.name === 'gone'), 'still registered for the retry');
    failing = false;
    await framework.removeModule('gone');
    const { lines } = await retiredLines(() => old.setState({ after: 'retried' }));
    assert.equal(moduleState(framework, 'gone')!.after, 'failed stop');
    assert.equal(lines.length, 1, lines.join('\n'));
  });
});
