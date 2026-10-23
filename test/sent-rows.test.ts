/**
 * What a stream's later rounds tell the context manager they carried after the compiled messages
 * (`noteRequestSent`): each stored row's id where the next request carries it as the stream sent it, the marker
 * where it doesn't. Noted at each tool boundary before the round's reply exists, every round so far in sent order.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageId } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';

import { AgentFramework } from '../src/index.js';
import type { Module, ToolCall } from '../src/index.js';
import { asNextRequestCarries, roundRows, type SentRow } from '../src/sent-rows.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

const UNSTORED = { unstored: true };
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const signed = (signature: string, tokenEstimate?: number) =>
  ({ type: 'thinking', thinking: '', signature, ...(tokenEstimate !== undefined ? { tokenEstimate } : {}) }) as ContentBlock;
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'test--echo', input: {} }) as ContentBlock;
const result = (toolUseId: string, content: string, isError?: boolean) =>
  ({ type: 'tool_result', toolUseId, content, ...(isError !== undefined ? { isError } : {}) }) as ContentBlock;

describe('asNextRequestCarries', () => {
  it('leaves out what the sanitize pass does and the framework\'s stamp, and is null where nothing is left', () => {
    assert.deepEqual(asNextRequestCarries([signed('s', 900), text(''), text('  '), text('Hi.')]), [signed('s'), text('Hi.')]);
    assert.equal(asNextRequestCarries([text(''), text('\n')]), null);
  });
});

describe('roundRows', () => {
  const store = new Map<string, { participant: string; content: ContentBlock[] } | null>([
    ['reply', { participant: 'agent', content: [signed('s', 900), text('Calling.'), toolUse('c1')] }],
    ['reply-empty', { participant: 'agent', content: [signed('s', 900), text(''), toolUse('c1')] }],
    ['reply-header', { participant: 'agent', content: [text('[agent] '), signed('s', 900), toolUse('c1')] }],
    ['results', { participant: 'user', content: [result('c1', 'ok')] }],
    ['placeholders', { participant: 'user', content: [result('c1', 'Tool result withheld by the guard. The tool has already executed.', false)] }],
    ['note', { participant: 'user', content: [text('A note.')] }],
    ['gone', null],
  ]);
  const carried = (id: MessageId) => store.get(id) ?? null;

  it('names a stored row the next request carries as the stream sent it', () => {
    assert.deepEqual(roundRows([
      { kind: 'reply', id: 'reply', sent: [signed('s'), text('Calling.'), toolUse('c1')] },
      // An empty text block reaches the provider in neither request: the API refuses one, and both leave it out.
      { kind: 'reply', id: 'reply-empty', sent: [signed('s'), text(''), toolUse('c1')] },
      { kind: 'results', id: 'results', sent: [{ toolUseId: 'c1', content: 'ok', isError: false }] },
      { kind: 'injected', id: 'note', participant: 'user', sent: [text('A note.')] },
    ], carried), ['reply', 'reply-empty', 'results', 'note'] as SentRow[]);
  });

  it('marks a row the next request carries otherwise, or doesn\'t carry, or the store doesn\'t hold', () => {
    assert.deepEqual(roundRows([
      // The next compile renders the reply with a header the stream didn't send.
      { kind: 'reply', id: 'reply-header', sent: [signed('s'), toolUse('c1')] },
      // The guard stored placeholders and the stream was sent the originals.
      { kind: 'results', id: 'placeholders', sent: [{ toolUseId: 'c1', content: 'ok', isError: false }] },
      { kind: 'injected', id: 'note', participant: 'Someone', sent: [text('A note.')] },
      { kind: 'injected', id: 'gone', participant: 'user', sent: [text('Gone.')] },
      { kind: 'reply', id: undefined, sent: [text('Unstored.')] },
    ], carried), [UNSTORED, UNSTORED, UNSTORED, UNSTORED, UNSTORED] as SentRow[]);
  });
});

class Tools implements Module {
  readonly name = 'test';
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() {
    return ['echo', 'end'].map((name) => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} } }));
  }
  async handleToolCall(call: ToolCall) { return { success: true, data: { echoed: true }, ...(call.name.endsWith('end') ? { endTurn: true } : {}) }; }
}
const usage = { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 };
const round = (id: string, content: ContentBlock[], tool = 'echo'): NormalizedResponse =>
  Object.assign(createMockResponse([...content, { type: 'tool_use', name: `test--${tool}`, id, input: {} }], 'tool_use'), { usage });
const final = (content: ContentBlock[] = [signed('sig-3'), text('Done.')]): NormalizedResponse => {
  const response = Object.assign(createMockResponse(content), { usage });
  response.details!.usage = usage;
  return response;
};
const twoRounds = (first: ContentBlock[]) => [round('c1', first), round('c2', [signed('sig-2'), text('Again.')]), final()];

/** Each stream takes the next script, its tool-calls events passed through `alter`. */
class Scripted extends MockMembrane {
  constructor(private readonly scripts: NormalizedResponse[][], private readonly alter?: (stream: YieldingStream) => YieldingStream) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.scripts.shift() ?? [final()]);
    this.lastStream = stream;
    return this.alter ? this.alter(stream) : stream;
  }
}
/** The stream as membrane's XML path gives it: no `roundContent`. */
const withoutRoundContent = (stream: YieldingStream): YieldingStream => new Proxy(stream, {
  get(target, key) {
    if (key === Symbol.asyncIterator) {
      return async function* () {
        for await (const event of target as AsyncIterable<{ type: string; context?: object }>) {
          yield event.type === 'tool-calls' ? { ...event, context: { ...event.context, roundContent: undefined } } : event;
        }
      };
    }
    const value = (target as unknown as Record<PropertyKey, unknown>)[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

type Logged = { kind: 'note'; rows: SentRow[]; identity: unknown; storedIds: string[] } | { kind: 'compile'; dryRun: boolean; identity: unknown };

/** A turn of a binding agent over a context manager that logs each note, with what the store held then, and each
 *  compile, in order. */
async function turn(opts: {
  scripts?: NormalizedResponse[][]; first?: ContentBlock[]; alter?: (s: YieldingStream) => YieldingStream;
  guard?: boolean; binds?: boolean; agent?: Record<string, unknown>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-sent-rows-'));
  const membrane = new Scripted(opts.scripts ?? [twoRounds(opts.first ?? [signed('sig-1'), text('Calling.')])], opts.alter);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(), agents: [], modules: [new Tools()], syncIntervalMs: 0,
  });
  framework.start();
  try {
    const { agent, contextManager } = await framework.createEphemeralAgent({
      name: 'worker', model: 'claude-opus-5-5', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'disabled',
      thinkingBinding: { binds: opts.binds ?? true }, ...(opts.guard ? { toolResultGuard: true } : {}), ...opts.agent,
    } as never);
    const log: Logged[] = [];
    (contextManager as unknown as { noteRequestSent: unknown }).noteRequestSent = (rows: SentRow[], identity: unknown) => {
      log.push({ kind: 'note', rows: [...rows], identity, storedIds: contextManager.getAllMessages().map((m) => m.id) });
      return true;
    };
    const compile = contextManager.compile.bind(contextManager);
    contextManager.compile = ((budget, injections, o) => {
      log.push({ kind: 'compile', dryRun: (o as { dryRun?: boolean } | undefined)?.dryRun === true, identity: (o as { identity?: unknown } | undefined)?.identity });
      return compile(budget, injections, o);
    }) as typeof compile;
    contextManager.addMessage('user', [{ type: 'text', text: 'Run twice.' }]);
    await framework.runEphemeralToCompletion(agent, contextManager);
    const stored = contextManager.getAllMessages();
    const notes = log.filter((e): e is Extract<Logged, { kind: 'note' }> => e.kind === 'note');
    const compiledIdentity = log.filter((e) => e.kind === 'compile').map((e) => e.identity);
    return { log, notes, compiledIdentity, stored, streams: membrane.calls.length };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
const replies = (stored: Array<{ id: string; participant: string }>) => stored.filter((m) => m.participant === 'worker').map((m) => m.id);
const resultRows = (stored: Array<{ id: string; content: ContentBlock[] }>) => stored.filter((m) => m.content.some((b) => b.type === 'tool_result')).map((m) => m.id);

describe('a stream\'s rounds, noted at each tool boundary and at its end', () => {
  it('notes every round so far, reply then results in sent order, before the round\'s reply exists, and the last reply at the end', async () => {
    const { notes, compiledIdentity, stored, streams } = await turn();
    assert.equal(streams, 1);
    assert.equal(notes.length, 3, 'one note per round that continues, and one at the end');
    const [reply1, reply2, reply3] = replies(stored);
    const results = resultRows(stored);
    assert.deepEqual(notes[0]!.rows, [reply1, results[0]]);
    assert.deepEqual(notes[1]!.rows, [reply1, results[0], reply2, results[1]], 'the second note holds both rounds');
    assert.deepEqual(notes[2]!.rows, [reply1, results[0], reply2, results[1], reply3], 'the end note adds the last reply');
    assert.equal(notes[0]!.storedIds.includes(reply2!), false, 'noted before the reply to it was stored');
    assert.equal(notes[2]!.storedIds.includes(reply3!), true, 'the end note comes after the last reply is stored');
    assert.deepEqual(notes[0]!.identity, compiledIdentity[0], 'the head the stream\'s compile was given');
    assert.ok(notes[0]!.identity);
  });

  it('notes a single-round turn once, at its end, with its reply', async () => {
    const { notes, stored } = await turn({ scripts: [[final()]] });
    assert.deepEqual(notes.map((n) => n.rows), [replies(stored)]);
  });

  it('notes a stream a result ends at that boundary, with the round\'s reply and not its results', async () => {
    const { notes, stored } = await turn({ scripts: [[round('c1', [signed('sig-1'), text('Ending.')], 'end')]] });
    assert.deepEqual(notes.map((n) => n.rows), [replies(stored)]);
  });

  it('notes a stream a budget restart ends before the restart\'s compile, and the restart\'s own stream after it', async () => {
    const { log, notes, stored, streams } = await turn({
      agent: { maxStreamTokens: 50 }, scripts: [[round('c1', [signed('sig-1'), text('Calling.')]), final()], [final()]],
    });
    assert.equal(streams, 2, 'the restart opened a second stream');
    const [reply1, reply2] = replies(stored);
    assert.deepEqual(notes[0]!.rows, [reply1], 'the first stream, ended at its boundary');
    const committing = log.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'compile' && !e.dryRun).map(([, i]) => i);
    const firstNote = log.findIndex((e) => e.kind === 'note');
    assert.ok(committing.length >= 2, 'the restart compiled');
    assert.ok(firstNote < committing[1]!, 'the end note lands before the restart\'s compile');
    assert.deepEqual(notes.at(-1)!.rows, [reply2], 'the restart\'s stream notes its own reply after its compile');
  });

  it('takes no empty text block in a reply as a difference, since neither request carries one', async () => {
    const { notes } = await turn({ first: [signed('sig-1'), { type: 'text', text: '' } as ContentBlock, text('Calling.')] });
    assert.equal(notes.length, 3);
    assert.ok(notes[2]!.rows.every((row) => typeof row === 'string'), JSON.stringify(notes[2]!.rows));
  });

  it('marks results while the tool-result guard holds them, and names them once its batch settles to the originals', async () => {
    const { notes } = await turn({ guard: true });
    assert.equal(notes.length, 3, 'at each boundary, and at the end');
    assert.equal(typeof notes[0]!.rows[0], 'string', 'the reply');
    assert.deepEqual(notes[0]!.rows[1], UNSTORED, 'round 1\'s results, held: placeholders stored, originals sent');
    assert.equal(typeof notes[1]!.rows[1], 'string', 'round 1\'s results, settled at round 2\'s calls');
    assert.deepEqual(notes[1]!.rows[3], UNSTORED, 'round 2\'s results, held');
    assert.equal(notes[2]!.rows.length, 5);
    assert.ok(notes[2]!.rows.every((row) => typeof row === 'string'), 'at the end, every batch settled, the last reply stored');
  });

  it('notes nothing of a stream whose rounds have no roundContent, nor for an agent whose model doesn\'t bind', async () => {
    assert.equal((await turn({ alter: withoutRoundContent })).notes.length, 0);
    assert.equal((await turn({ binds: false })).notes.length, 0);
  });
});
