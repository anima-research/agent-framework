import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, ModuleRegistry, ShutdownTimeoutError, type EventResponse, type Module, type ModuleContext, type ModuleContextInjection, type ProcessEvent, type ToolCall } from '../src/index.js';
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

interface ProbeOptions {
  onStart?: (ctx: ModuleContext) => void;
  stop?: () => Promise<void>;
  tool?: boolean;
  answer?: (event: ProcessEvent) => EventResponse | Promise<EventResponse>;
  speak?: () => Promise<void>;
}

function probe(name: string, opts: ProbeOptions = {}): Probe {
  let ctx: ModuleContext | undefined;
  const seen: string[] = [];
  const spoke: string[] = [];
  const calls: string[] = [];
  const module: Module = {
    name,
    async start(given) { ctx = given; opts.onStart?.(given); },
    stop: opts.stop ?? (async () => {}),
    async onProcess(event) { seen.push(said(event)); return (await opts.answer?.(event)) ?? {}; },
    async onAgentSpeech(agentName) { spoke.push(agentName); await opts.speak?.(); },
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

const refusal = (module: string, method: string): string =>
  `[framework] module "${module}" has stopped, so its ${method}() call had no effect; later ${method}() calls from it aren't logged`;

function gate(): { open: () => void; opened: Promise<void>; enter: () => void; entered: (what: string) => Promise<void> } {
  let open!: () => void;
  let isEntered = false;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened, enter: () => { isEntered = true; }, entered: (what) => waitFor(what, () => isEntered) };
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
    const result = (callId: string, moduleName: string): ProcessEvent => ({
      type: 'tool-result', callId, toolName: 'fetch', agentName: 'assistant', moduleName, result: { success: true },
    }) as ProcessEvent;
    const { lines } = await retiredLines(() => {
      old.pushEvent(external('late-1'));
      old.queue.push(external('late-2'));
      old.pushEvent(result('c1', 'gone'));
      old.queue.push(result('c2', 'provider'));
    }, /arrived after/);
    framework.pushEvent(external('marker'));
    await waitFor('the marker pushed after them', () => stays.seen.includes('external-message:marker') && namesake.seen.includes('external-message:marker'));
    assert.deepEqual(stays.seen, ['external-message:marker']);
    assert.deepEqual(namesake.seen, ['external-message:marker']);
    assert.deepEqual(lines, [
      "[framework] a 'external-message' event from module gone arrived after that module stopped — dropped",
      "[framework] a 'external-message' event from module gone arrived after that module stopped — dropped",
      '[framework] assistant: result of tool call c1 (fetch, gone) arrived after module gone stopped — dropped; the tool succeeded',
      '[framework] assistant: result of tool call c2 (fetch, provider) arrived after module gone stopped — dropped; the tool succeeded',
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
    assert.deepEqual(lines, ['setState', 'registerLogState', 'appendToLog', 'editLogItem'].map((method) => refusal('gone', method)));
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
    assert.deepEqual(lines, ['addMessage', 'editMessage', 'removeMessage'].map((method) => refusal('gone', method)));
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
    assert.deepEqual(lines, ['callTool', 'getModule'].map((method) => refusal('gone', method)));
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
    assert.deepEqual(lines, ['notifyOps', 'onTrace'].map((method) => refusal('gone', method)));
  });
});

test("a removed module's speech-handler calls neither add a handler nor remove a later module's of its name", async () => {
  const gone = probe('gone', { onStart: (ctx) => ctx.registerSpeechHandler(['assistant']) });
  await withFramework([gone.module], async (framework) => {
    await framework.removeModule('gone');
    const namesake = probe('gone', { onStart: (ctx) => ctx.registerSpeechHandler(['assistant']) });
    await framework.addModule(namesake.module);
    const old = gone.ctx();
    const { lines } = await retiredLines(() => {
      old.registerSpeechHandler(['someone-else']);
      old.unregisterSpeechHandler();
    });
    const registry = (framework as unknown as { moduleRegistry: { dispatchSpeech(agent: string, content: ContentBlock[], context: never): Promise<void> } }).moduleRegistry;
    await registry.dispatchSpeech('assistant', text('spoken'), {} as never);
    assert.deepEqual(namesake.spoke, ['assistant'], 'one handler, the later module\'s');
    assert.deepEqual(gone.spoke, []);
    assert.deepEqual(lines, ['registerSpeechHandler', 'unregisterSpeechHandler'].map((method) => refusal('gone', method)));
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
      stays.ctx().setState({ w: 2 });
      return old.callTool({ id: 'after-stop', name: 'stays--echo', input: {} });
    });
    assert.deepEqual(moduleState(framework, 'gone'), { v: 1, externalIdMap: {} });
    assert.equal(moduleState(framework, 'stays'), null, "the other module's context is retired too");
    assert.equal(value.success, false);
    assert.deepEqual(stays.calls, []);
    assert.deepEqual(lines, [refusal('gone', 'setState'), refusal('stays', 'setState'), refusal('gone', 'callTool')]);
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
    await assert.rejects(framework.stop(100), (error: unknown) => error instanceof ShutdownTimeoutError && /module:gone/.test(error.message));
    ctx.setState({ meanwhile: true });
    assert.equal(moduleState(framework, 'gone')!.meanwhile, true, 'not retired while its stop() runs');
    release();
    await waitFor("the module's stop() to settle", () => !framework.getAllModules().some((m) => m.name === 'gone'));
    assert.equal(moduleState(framework, 'gone')!.flushed, true, 'its write from inside stop() landed');
    const { lines } = await retiredLines(() => ctx.setState({ late: true }));
    assert.equal(moduleState(framework, 'gone')!.late, undefined);
    assert.deepEqual(lines, [refusal('gone', 'setState')]);
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
    assert.deepEqual(lines, [refusal('gone', 'setState')]);
  });
});

test('a module object removed, added again and removed again is stopped and removed the second time', async () => {
  let stops = 0;
  const gone = probe('gone', { stop: async () => { stops++; } });
  await withFramework([gone.module], async (framework) => {
    await framework.removeModule('gone');
    await framework.addModule(gone.module);
    await framework.removeModule('gone');
    assert.equal(stops, 2);
    assert.ok(!framework.getAllModules().some((m) => m.name === 'gone'), 'removed the second time');
  });
});

const laterOfItsName: [string, (gone: Probe) => Probe][] = [
  ['a new module of its name', () => probe('gone')],
  ['the same module object', (gone) => gone],
];

const completion = (framework: AgentFramework, content: string): { done: () => boolean; responders: () => string[] } => {
  let responders: string[] | undefined;
  framework.onTrace((event) => {
    if (event.type !== 'process:completed') return;
    const { processEvent, responses } = event as unknown as { processEvent: ProcessEvent; responses: { moduleName: string }[] };
    if (said(processEvent) === `external-message:${content}`) responders = responses.map((r) => r.moduleName);
  });
  return { done: () => responders !== undefined, responders: () => responders ?? [] };
};

for (const [kind, later] of laterOfItsName) {
  test(`an event being dispatched when a module's removal completes doesn't call that module, once ${kind} has been added`, async () => {
    const held = gate();
    const first = probe('first', { answer: async (event) => { if (said(event) === 'external-message:hold') { held.enter(); await held.opened; } return {}; } });
    const gone = probe('gone');
    const namesake = later(gone);
    await withFramework([first.module, gone.module], async (framework) => {
      const completed = completion(framework, 'hold');
      framework.start();
      const { lines } = await retiredLines(async () => {
        framework.pushEvent(external('hold'));
        await held.entered('the event to reach the first module');
        await framework.removeModule('gone');
        await framework.addModule(namesake.module);
        held.open();
        await waitFor('the event to finish', completed.done);
      }, /error handling process event/);
      assert.ok(!gone.seen.includes('external-message:hold'), gone.seen.join('\n'));
      assert.ok(!namesake.seen.includes('external-message:hold'), "a module added during the dispatch isn't called for it either");
      assert.deepEqual(lines, []);
    });
  });

  test(`a response whose module's removal completes before it's applied is dropped whole, with a line naming what it asked for, once ${kind} has been added`, async () => {
    const held = gate();
    const ids = { edited: '', removed: '' };
    const gone = probe('gone', {
      answer: (event) => (said(event) === 'external-message:hold'
        ? {
          addMessages: [{ participant: 'user', content: text('from the removed module') }],
          editMessages: [{ messageId: ids.edited, content: text('edited by the removed module') }],
          removeMessages: [ids.removed],
          stateUpdate: { v: 'late' },
          requestInference: true,
          toolsChanged: true,
        }
        : {}),
    });
    const last = probe('last', { answer: async (event) => { if (said(event) === 'external-message:hold') { held.enter(); await held.opened; } return {}; } });
    await withFramework([gone.module, last.module], async (framework) => {
      const completed = completion(framework, 'hold');
      ids.edited = last.ctx().addMessage('user', text('to be edited'));
      ids.removed = last.ctx().addMessage('user', text('to be removed'));
      framework.start();
      const namesake = later(gone);
      const { lines } = await retiredLines(async () => {
        framework.pushEvent(external('hold'));
        await held.entered('the event to reach the last module');
        await framework.removeModule('gone');
        await framework.addModule(namesake.module);
        held.open();
        await waitFor('the event to finish', completed.done);
      }, /^\[process\]/);
      const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages()
        .flatMap((m) => m.content).flatMap((b) => ((b as { type: string }).type === 'text' ? [(b as { text: string }).text] : []));
      assert.ok(!texts.includes('from the removed module'), texts.join('\n'));
      assert.ok(texts.includes('to be edited') && !texts.includes('edited by the removed module'), texts.join('\n'));
      assert.ok(texts.includes('to be removed'), texts.join('\n'));
      assert.equal(namesake.ctx().getState(), null, "the later registration's state is untouched");
      assert.ok(!completed.responders().includes('gone'), `process:completed lists ${completed.responders().join(', ')}`);
      assert.ok(completed.responders().includes('last'), `process:completed lists ${completed.responders().join(', ')}`);
      assert.deepEqual(lines, ['[process] module gone stopped before its response to external-message was applied, so none of it was: 1 message(s) to add, 1 edit(s), 1 removal(s), a state update, an inference request, a tools change']);
    });
  });
}

test("a push a module made while it was registered still reaches the other modules after its removal completes", async () => {
  const gone = probe('gone');
  const stays = probe('stays');
  await withFramework([gone.module, stays.module], async (framework) => {
    gone.ctx().pushEvent(external('made while registered'));
    await framework.removeModule('gone');
    framework.start();
    await waitFor('the push to reach the other module', () => stays.seen.includes('external-message:made while registered'));
  });
});

test("speech being dispatched when a module's removal completes doesn't reach a module of its name added since", async () => {
  const held = gate();
  const first = probe('first', { onStart: (ctx) => ctx.registerSpeechHandler('*'), speak: async () => { held.enter(); await held.opened; } });
  const gone = probe('gone', { onStart: (ctx) => ctx.registerSpeechHandler('*') });
  await withFramework([first.module, gone.module], async (framework) => {
    const registry = (framework as unknown as { moduleRegistry: { dispatchSpeech(agent: string, content: ContentBlock[], context: never): Promise<void> } }).moduleRegistry;
    const speaking = registry.dispatchSpeech('assistant', text('spoken'), {} as never);
    await held.entered('the speech to reach the first module');
    await framework.removeModule('gone');
    const namesake = probe('gone');
    await framework.addModule(namesake.module);
    held.open();
    await speaking;
    assert.deepEqual(first.spoke, ['assistant']);
    assert.deepEqual(gone.spoke, []);
    assert.deepEqual(namesake.spoke, [], 'it registered no handler');
  });
});

test("a running module that registers or removes its speech handler while speech is being dispatched is still called for it", async () => {
  const held = gate();
  const first = probe('first', { onStart: (ctx) => ctx.registerSpeechHandler('*'), speak: async () => { held.enter(); await held.opened; } });
  const replacing = probe('replacing', { onStart: (ctx) => ctx.registerSpeechHandler('*') });
  const removing = probe('removing', { onStart: (ctx) => ctx.registerSpeechHandler('*') });
  await withFramework([first.module, replacing.module, removing.module], async (framework) => {
    const registry = (framework as unknown as { moduleRegistry: { dispatchSpeech(agent: string, content: ContentBlock[], context: never): Promise<void> } }).moduleRegistry;
    const speaking = registry.dispatchSpeech('assistant', text('spoken'), {} as never);
    await held.entered('the speech to reach the first module');
    replacing.ctx().registerSpeechHandler(['assistant']);
    removing.ctx().unregisterSpeechHandler();
    held.open();
    await speaking;
    assert.deepEqual([replacing.spoke, removing.spoke], [['assistant'], ['assistant']]);
  });
});

interface BareRegistry {
  registry: ModuleRegistry;
  queued: string[];
  pushed: string[];
  listeners: { label: string; listener: (event: never) => void; active: boolean; unsubscribed: number }[];
}

function bareRegistry(t: { after: (fn: () => void) => void }, throwingUnsubscribe?: string): BareRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'retired-module-context-registry-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const queued: string[] = [];
  const pushed: string[] = [];
  const listeners: BareRegistry['listeners'] = [];
  const registry = new ModuleRegistry(store, { push: (event) => { queued.push(event.type); } }, {
    getAgents: () => [],
    addMessage: () => { throw new Error('not expected'); },
    editMessage: () => {},
    removeMessage: () => {},
    getMessage: () => null,
    queryMessages: () => ({ messages: [], totalCount: 0 }),
    pushEvent: (event) => { pushed.push(event.type); },
    onTrace: (listener) => {
      const entry = { label: `subscription ${listeners.length + 1}`, listener: listener as (event: never) => void, active: true, unsubscribed: 0 };
      listeners.push(entry);
      return () => {
        entry.unsubscribed++;
        if (entry.label === throwingUnsubscribe) throw new Error('injected unsubscribe failure');
        entry.active = false;
      };
    },
    callTool: async () => ({ success: true }),
  });
  return { registry, queued, pushed, listeners };
}

test("a ModuleRegistry built without dropRetiredPush drops a stopped module's pushes with its own lines, and its trace listeners hear nothing once it has stopped, even where the unsubscribe throws", async (t) => {
  const { registry, queued, pushed, listeners } = bareRegistry(t, 'subscription 2');
  const heard: string[] = [];
  let kept!: () => void;
  const gone = probe('gone', {
    onStart: (ctx) => {
      kept = ctx.onTrace(() => heard.push('kept'));
      ctx.onTrace(() => heard.push('throwing'));
      const live = ctx.onTrace(() => heard.push('live'));
      live();
      live();
    },
  });
  await registry.addModule(gone.module);
  assert.deepEqual(listeners.map((l) => l.unsubscribed), [0, 0, 1], 'a live unsubscribe ends its own subscription once, however often it is called');
  for (const { listener, active } of listeners) if (active) listener({ type: 'probe' } as never);
  assert.deepEqual(heard.splice(0), ['kept', 'throwing'], 'a running module hears traces');
  const { lines } = await retiredLines(async () => {
    await registry.removeModule('gone');
    kept();
    const old = gone.ctx();
    old.pushEvent(external('late'));
    old.queue.push({ type: 'tool-result', callId: 'c9', toolName: 'fetch', agentName: 'assistant', moduleName: 'gone', result: { success: false, isError: true, error: 'boom' } } as ProcessEvent);
  }, /\[framework\]/);
  assert.equal(registry.getModule('gone'), null, 'removed despite the throwing unsubscribe');
  assert.deepEqual(listeners.map((l) => l.unsubscribed), [1, 1, 1], 'each ended once at the removal, and not again by its own unsubscribe');
  assert.deepEqual(listeners.map((l) => l.active), [false, true, false], 'the throwing one stays subscribed in the registry it came from');
  for (const { listener } of listeners) listener({ type: 'probe' } as never);
  assert.deepEqual(heard, [], 'no listener of a stopped module hears a trace');
  assert.deepEqual([queued, pushed], [[], []]);
  assert.deepEqual(lines, [
    '[framework] module "gone" has stopped, and ending one of its trace subscriptions threw: injected unsubscribe failure',
    "[framework] a 'external-message' event from module gone arrived after that module stopped — dropped",
    '[framework] assistant: result of tool call c9 (fetch, gone) arrived after module gone stopped — dropped; the tool failed: boom',
  ]);
});

test("a gatherContext answer from a module whose stop() completes before the answers are merged is left out of the turn, with a line only if it held injections, the same module object added again included", async (t) => {
  const { registry } = bareRegistry(t);
  const held = gate();
  const injecting = (name: string, answer: ModuleContextInjection[], wait = false): Module => ({
    name,
    async start() {},
    async stop() {},
    async onProcess() { return {}; },
    getTools: () => [],
    async handleToolCall() { return { success: true }; },
    async gatherContext(): Promise<ModuleContextInjection[]> {
      if (wait) { held.enter(); await held.opened; }
      return answer;
    },
  });
  const notText = [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA==' } }] as unknown as ContentBlock[];
  const gone = injecting('gone', [{ namespace: 'gone', position: 'system', content: notText }]);
  await registry.addModule(gone);
  await registry.addModule(injecting('empty', []));
  await registry.addModule(injecting('slow', [{ namespace: 'slow', position: 'system', content: text('from slow') }], true));
  const { value, lines } = await retiredLines(async () => {
    const gathering = registry.gatherContext('assistant');
    await held.entered("the slow module's gatherContext to be called");
    await registry.removeModule('gone');
    await registry.removeModule('empty');
    await registry.addModule(gone);
    held.open();
    return gathering;
  }, /gatherContext/);
  assert.deepEqual(value.map((injection) => injection.namespace), ['slow']);
  assert.deepEqual(lines, ['[framework] module gone stopped before its gatherContext answer for assistant was used, so its 1 injection(s) were left out']);
});

test("a module added under a stopped module's name has its onToolBatchComplete called while the stopped one's hook still runs past its bound", async (t) => {
  const { registry } = bareRegistry(t);
  const called: string[] = [];
  const batching = (label: string, wedged: boolean): Module => ({
    name: 'batcher',
    async start() {},
    async stop() {},
    async onProcess() { return {}; },
    getTools: () => [],
    async handleToolCall() { return { success: true }; },
    async onToolBatchComplete() {
      called.push(label);
      if (wedged) await new Promise(() => {});
    },
  });
  await registry.addModule(batching('stopped', true));
  const first = await retiredLines(() => registry.notifyToolBatchComplete('assistant', 20), /onToolBatchComplete/);
  assert.deepEqual(first.value.map((f) => f.module), ['batcher']);
  await registry.removeModule('batcher');
  await registry.addModule(batching('later', false));
  assert.deepEqual(await registry.notifyToolBatchComplete('assistant', 20), []);
  assert.deepEqual(called, ['stopped', 'later']);
});
