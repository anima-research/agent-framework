/**
 * Content context-manager won't store is refused where the framework writes
 * it, whether a turn runs or not, as the store's own write and edit refuse
 * it: a module's write, and its edit of a write stored during the turn and
 * not in the window yet, throw context-manager's MalformedContentError. A process response with such
 * content is refused whole before any response applies, with a line and a
 * trace, and throws nothing; the API's message.send refuses content that
 * isn't text at its call. Before, a deferred write was refused only at a
 * later flush, where the writer never heard of it, and a held write's edit
 * could replace valid content with content the drain then dropped; since
 * #291 every write is stored at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { MalformedContentError, malformedContentPlaces } from '@animalabs/context-manager';
import type { Module, ModuleContext, ProcessEvent, ProcessState, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { AgentFramework, ApiServer } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];
/** A text block whose text isn't a string, which the store refuses. */
const MALFORMED = [{ type: 'text', text: 5 }] as unknown as ContentBlock[];
/** An image whose source is a string, which the store refuses for another place. */
const MALFORMED_IMAGE = [{ type: 'image', source: 'not-an-object' }] as unknown as ContentBlock[];

/** A module with one tool, `act`, that runs `during` while the turn waits
 *  for it, and that answers an external message with `onExternal`'s response
 *  and a `ping` with `onPing`'s. */
class Writer implements Module {
  readonly name: string;
  ctx!: ModuleContext;
  during: (() => void) | null = null;
  onExternal: EventResponse = { addMessages: [{ participant: 'Antra', content: text('go') }], requestInference: true };
  onPing: EventResponse = {};
  constructor(name = 'writer') { this.name = name; }
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'act', description: 'Act', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    const during = this.during;
    this.during = null;
    during?.();
    return { success: true, data: { ok: true } };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') return this.onExternal;
    if ((event as { type: string }).type === 'ping') return this.onPing;
    return {};
  }
}

async function harness(modules: Writer[]) {
  const dir = mkdtempSync(join(tmpdir(), 'malformed-writes-af-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
    modules,
    processLogging: { persist: true },
  });
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  const traces: Array<Record<string, unknown>> = [];
  framework.onTrace((e) => { traces.push(e as unknown as Record<string, unknown>); });
  const window = () => framework.getAgent('assistant')!.getContextManager().getAllMessages()
    .map((m) => `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join(' ')}`);
  const stored = () => framework.getAgent('assistant')!.getContextManager().getAllMessages().length;
  return {
    framework, membrane, errors, traces, window, stored,
    close: async () => {
      console.error = error;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A turn that calls `writer--act` once, then answers. */
function scriptTurn(membrane: MockMembrane): void {
  membrane.pushResponse(createMockResponse([
    { type: 'text', text: 'Acting.' },
    { type: 'tool_use', id: 'c1', name: 'writer--act', input: {} },
  ] as ContentBlock[], 'tool_use'));
  membrane.pushResponse(createMockResponse(text('Done.')));
}

function catchFrom(f: () => unknown): unknown {
  try { f(); } catch (error) { return error; }
  return undefined;
}

test("a module's malformed write throws while a turn runs, as it does while the agent is idle, and nothing is stored", async (t) => {
  const writer = new Writer();
  const x = await harness([writer]); t.after(x.close);
  scriptTurn(x.membrane);
  let duringTurn: unknown;
  let storedBy = -1;
  writer.during = () => {
    const before = x.stored();
    duringTurn = catchFrom(() => writer.ctx.addMessage('Antra', MALFORMED));
    storedBy = x.stored() - before;
    writer.ctx.addMessage('Antra', text('look right'));
  };
  x.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  assert.ok(duringTurn instanceof MalformedContentError, String(duringTurn));
  assert.match((duringTurn as Error).message, /^Message refused: content\[0\]/);
  assert.equal(storedBy, 0, 'the refused write stored nothing');
  assert.ok(x.window().includes('Antra: look right'), 'the next write landed');
  const idle = catchFrom(() => writer.ctx.addMessage('Antra', MALFORMED));
  assert.ok(idle instanceof MalformedContentError, String(idle));
  assert.equal((idle as Error).message, (duringTurn as Error).message, 'the same refusal either way');
});

test("an edit of a held write to malformed content throws and leaves the write as it was, which lands", async (t) => {
  const writer = new Writer();
  const x = await harness([writer]); t.after(x.close);
  scriptTurn(x.membrane);
  const edits: unknown[] = [];
  writer.during = () => {
    const held = writer.ctx.addMessage('Antra', text('original'));
    edits.push(catchFrom(() => writer.ctx.editMessage(held, MALFORMED)));
    edits.push(catchFrom(() => writer.ctx.editMessage(held, [null] as unknown as ContentBlock[])));
  };
  x.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  assert.equal(edits.length, 2);
  for (const edit of edits) {
    assert.ok(edit instanceof MalformedContentError, String(edit));
    assert.match((edit as Error).message, /^Edit of .* refused: content\[0\]/);
  }
  const window = x.window();
  assert.ok(window.includes('Antra: original'), `the held write landed as it was:\n${window.join('\n')}`);
  assert.equal(window.at(-1), 'assistant: Done.', 'and the turn went on past its tool boundary');
});

test("a process response with a malformed message or edit is refused whole, queueing no inference, and other modules' responses still apply", async (t) => {
  const bad = new Writer('bad');
  const badEdit = new Writer('bad-edit');
  const good = new Writer('good');
  bad.onPing = { addMessages: [{ participant: 'Antra', content: text('first') }, { participant: 'Antra', content: MALFORMED }], requestInference: true };
  badEdit.onPing = { addMessages: [{ participant: 'Edit', content: text('before the edit') }], editMessages: [{ messageId: 'm-any', content: MALFORMED_IMAGE }] };
  good.onPing = { addMessages: [{ participant: 'Good', content: text('from good') }] };
  const x = await harness([bad, badEdit, good]); t.after(x.close);
  x.framework.pushEvent({ type: 'ping', source: 'test' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  const window = x.window();
  assert.ok(!window.includes('Antra: first'), `none of the refused response's messages was added:\n${window.join('\n')}`);
  assert.ok(!window.includes('Edit: before the edit'), 'nor of the one whose edit is refused');
  assert.ok(window.includes('Good: from good'), 'the other module\'s response was applied');
  assert.equal(x.membrane.calls.length, 0, 'no inference ran');
  const lines = (module: string) => x.errors.filter((e) => e.startsWith(`[process-response-refused] module=${module} event=ping reason=malformed-content: `));
  assert.equal(lines('bad').length, 1, x.errors.join('\n'));
  assert.ok(lines('bad')[0]!.includes('addMessages[1] refused'), lines('bad')[0]);
  assert.equal(lines('bad-edit').length, 1, x.errors.join('\n'));
  assert.ok(lines('bad-edit')[0]!.includes('editMessages[0] refused'), lines('bad-edit')[0]);
  assert.equal(lines('good').length, 0, 'one line per refused response, and none for the one that applied');
  const completed = x.traces.filter((e) => e.type === 'process:completed' && (e.processEvent as { type: string }).type === 'ping');
  assert.deepEqual(completed.map((e) => (e.responses as Array<{ moduleName: string }>).map((r) => r.moduleName)), [['good']],
    'the trace lists only the response that applied');
  const logged = x.framework.queryProcessLogs({ eventType: 'ping' }).entries
    .map(({ entry }) => (entry.responses as Array<{ moduleName: string }>).map((r) => r.moduleName));
  assert.deepEqual(logged, [['good']], 'and so does the process log');
  assert.deepEqual(
    x.traces.filter((e) => e.type === 'process:response-refused').map((e) => [e.moduleName, e.eventType, e.where, e.places]),
    [
      ['bad', 'ping', 'addMessages[1]', malformedContentPlaces(MALFORMED)],
      ['bad-edit', 'ping', 'editMessages[0]', malformedContentPlaces(MALFORMED_IMAGE)],
    ],
    'a trace names each refused response, with the places of the message or edit it refused',
  );
  assert.notDeepEqual(malformedContentPlaces(MALFORMED), malformedContentPlaces(MALFORMED_IMAGE), 'the two refusals name different places');
});

test("the API's message.send refuses content that isn't text, before any module sees it", async (t) => {
  const writer = new Writer();
  const x = await harness([writer]); t.after(x.close);
  const server = new ApiServer(x.framework, { port: 0 });
  const send = (content: unknown) =>
    (server as unknown as { cmdMessageSend(p: unknown): Promise<unknown> }).cmdMessageSend({ participant: 'user', content });
  await assert.rejects(send(5), /content must be text/);
  await assert.rejects(send([{ type: 'text', text: 'blocks' }]), /content must be text/);
  await x.framework.runUntilIdle();
  const apiEvents = () => x.traces.filter((e) => e.type === 'process:received' && (e.processEvent as { type: string }).type === 'api:message').length;
  assert.equal(apiEvents(), 0, 'no event was queued');
  assert.deepEqual(await send('hello'), { messageId: 'pending' }, 'text is accepted as before');
  await x.framework.runUntilIdle();
  assert.equal(apiEvents(), 1, 'and its event queued');
});

test("console input whose only message is refused isn't counted as accepted", async (t) => {
  const writer = new Writer();
  const x = await harness([writer]); t.after(x.close);
  const accepted: unknown[] = [];
  (x.framework as unknown as { inboundAcceptanceObserver: unknown }).inboundAcceptanceObserver = {
    inboundAccepted: (source: unknown) => accepted.push(source),
  };
  writer.onExternal = { addMessages: [{ participant: 'user', content: text('hello') }] };
  x.framework.pushEvent({ type: 'external-message', source: 'tui', content: 'hello', metadata: {} } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  assert.equal(accepted.length, 1, 'input a module turns into a message is accepted');
  writer.onExternal = { addMessages: [{ participant: 'user', content: MALFORMED }] };
  x.framework.pushEvent({ type: 'external-message', source: 'tui', content: 'hello', metadata: {} } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  assert.equal(accepted.length, 1, 'input whose message is refused is not');
  assert.ok(x.errors.some((e) => e.startsWith('[process-response-refused] module=writer event=external-message')), x.errors.join('\n'));
});
