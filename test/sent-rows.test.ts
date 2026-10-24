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
import { asNextRequestCarries, roundRows, sameData, type SentRow } from '../src/sent-rows.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

const UNSTORED = { unstored: true };
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const signed = (signature: string, tokenEstimate?: number) =>
  ({ type: 'thinking', thinking: '', signature, ...(tokenEstimate !== undefined ? { tokenEstimate } : {}) }) as ContentBlock;
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'test--echo', input: {} }) as ContentBlock;
const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } } as ContentBlock;
const result = (toolUseId: string, content: string, isError?: boolean) =>
  ({ type: 'tool_result', toolUseId, content, ...(isError !== undefined ? { isError } : {}) }) as ContentBlock;

describe('sameData', () => {
  it('is equal where JSON writes the two alike, key order aside', () => {
    const equal: Array<[unknown, unknown, string]> = [
      [{ type: 'text', text: 'Hi.' }, { text: 'Hi.', type: 'text' }, 'key order'],
      [{ a: 1, b: undefined }, { a: 1 }, 'an undefined field'],
      [{ a: 1, f: () => 1 }, { a: 1 }, 'a function field'],
      [[undefined, 1], [null, 1], 'an undefined element'],
      // eslint-disable-next-line no-sparse-arrays
      [[, 1], [null, 1], 'a hole'],
      [{ n: Infinity }, { n: null }, 'a non-finite number'],
      [[NaN], [null], 'NaN'],
      [{ at: new Date(0) }, { at: '1970-01-01T00:00:00.000Z' }, 'a Date, by its toJSON'],
      [{ nested: { list: [{ a: 1 }, 'x'] } }, { nested: { list: [{ a: 1 }, 'x'] } }, 'nested'],
    ];
    for (const [a, b, label] of equal) {
      assert.equal(sameData(a, b), true, label);
      assert.equal(sameData(b, a), true, `${label}, the other way`);
    }
    const unequal: Array<[unknown, unknown, string]> = [
      [{ a: { b: null } }, { a: { b: {} } }, 'null against an object, nested'],
      [{ a: null }, { a: 0 }, 'null against 0'],
      [[1, 2], { 0: 1, 1: 2, length: 2 }, 'an array against an object with its keys'],
      [{}, { extra: 1 }, 'a field more'],
      [{ a: 1 }, { b: 1 }, 'another field'],
      [[1, 2], [2, 1], 'element order'],
      [[1], [1, null], 'length'],
      [{ at: new Date(0) }, { at: new Date(1) }, 'two Dates'],
      [{ a: '1' }, { a: 1 }, 'a string against a number'],
    ];
    for (const [a, b, label] of unequal) {
      assert.equal(sameData(a, b), false, label);
      assert.equal(sameData(b, a), false, `${label}, the other way`);
    }
  });
});

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
    // A result with an image, as stored and as the next compile renders it after an image limit took the image out.
    ['results-image', { participant: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: [text('A chart.'), image] } as ContentBlock] }],
    ['results-image-limited', { participant: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: [text('A chart.')] } as ContentBlock] }],
    // An injected message whose first text block is whitespace, which the next request's sanitize pass leaves out.
    ['note-spaced', { participant: 'Bob', content: [text(' \n'), text('A note.')] }],
    // A reply holding a provider-native item on an empty text carrier, which the sanitize pass leaves out.
    ['reply-carrier', { participant: 'agent', content: [signed('s'), { type: 'text', text: '', rawItem: { type: 'web_search_tool_result' } } as ContentBlock, text('Found.')] }],
    // A stored block with a stale cache marker, which the binding doesn't count.
    ['note-marked', { participant: 'user', content: [{ ...text('A note.'), cache_control: { type: 'ephemeral' } } as ContentBlock] }],
    ['results-error', { participant: 'user', content: [result('c1', 'ok', true)] }],
    ['note-undefined', { participant: 'user', content: [{ ...text('A note.'), citations: undefined } as never] }],
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
      { kind: 'results', id: 'results-image', sent: [{ toolUseId: 'c1', content: [text('A chart.'), image] as never, isError: false }] },
      { kind: 'injected', id: 'note-marked', participant: 'user', sent: [text('A note.')] },
      // A marker on what was sent, in its camelCase form.
      { kind: 'injected', id: 'note', participant: 'user', sent: [{ ...text('A note.'), cacheControl: { type: 'ephemeral' } } as never] },
      // A field whose value is undefined, on either side, is absent, as JSON leaves it out.
      { kind: 'injected', id: 'note', participant: 'user', sent: [{ ...text('A note.'), citations: undefined } as never] },
      { kind: 'injected', id: 'note-undefined', participant: 'user', sent: [text('A note.')] },
    ], carried), ['reply', 'reply-empty', 'results', 'note', 'results-image', 'note-marked', 'note', 'note', 'note-undefined'] as SentRow[]);
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
      // The stream was sent the image, and the next compile renders the result without it.
      { kind: 'results', id: 'results-image-limited', sent: [{ toolUseId: 'c1', content: [text('A chart.'), image] as never, isError: false }] },
      // membrane sent the whitespace block, behind Bob's name; the next request leaves it out.
      { kind: 'injected', id: 'note-spaced', participant: 'Bob', sent: [text(' \n'), text('A note.')] },
      // membrane sent the carrier's item; the next request leaves the carrier out.
      { kind: 'reply', id: 'reply-carrier', sent: [signed('s'), { type: 'text', text: '', rawItem: { type: 'web_search_tool_result' } } as ContentBlock, text('Found.')] },
      // A difference inside a nested field: the image's data.
      { kind: 'results', id: 'results-image', sent: [{ toolUseId: 'c1', content: [text('A chart.'), { ...image, source: { ...(image as { source: object }).source, data: 'other' } }] as never, isError: false }] },
      // Results for another call, and an error flag that differs.
      { kind: 'results', id: 'results', sent: [{ toolUseId: 'c2', content: 'ok', isError: false }] },
      { kind: 'results', id: 'results-error', sent: [{ toolUseId: 'c1', content: 'ok', isError: false }] },
    ], carried), Array(11).fill(UNSTORED) as SentRow[]);
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
/** The stream's complete, as membrane gives it: every round's blocks, each round's results after its calls, then the
 *  last reply's (`last`, none for a stream that ends on its last results). */
const cumulative = (first: ContentBlock[], last: ContentBlock[] = [signed('sig-3'), text('Done.')]): NormalizedResponse => {
  const toolResult = (id: string) => ({ type: 'tool_result', toolUseId: id, content: '{"echoed":true}' }) as ContentBlock;
  const response = final([...first, toolUse('c1'), toolResult('c1'), signed('sig-2'), text('Again.'), toolUse('c2'), toolResult('c2'), ...last]);
  response.toolCalls = [];
  return response;
};
const twoRounds = (first: ContentBlock[], last?: ContentBlock[]) =>
  [round('c1', first), round('c2', [signed('sig-2'), text('Again.')]), cumulative(first, last)];

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

type Logged = { kind: 'note'; rows: SentRow[]; identity: unknown; compileId: unknown; storedIds: string[] }
  | { kind: 'compile'; dryRun: boolean; identity: unknown; compileId?: string };

/** A turn of a binding agent over a context manager that logs each note, with what the store held then, and each
 *  compile, in order. */
async function turn(opts: {
  scripts?: NormalizedResponse[][]; first?: ContentBlock[]; alter?: (s: YieldingStream) => YieldingStream;
  guard?: boolean; binds?: boolean; agent?: Record<string, unknown>; noProvenance?: boolean;
  render?: (rendered: Array<ContentBlock[] | null> | undefined) => Array<ContentBlock[] | null> | undefined;
  /** What the context manager's noteRequestSent does: returns true (the default) or false, throws, or is absent. */
  noteAs?: boolean | 'throw' | 'absent';
  last?: ContentBlock[];
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-sent-rows-'));
  const membrane = new Scripted(opts.scripts ?? [twoRounds(opts.first ?? [signed('sig-1'), text('Calling.')], opts.last)], opts.alter);
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
    (contextManager as unknown as { noteRequestSent: unknown }).noteRequestSent = opts.noteAs === 'absent' ? undefined
      : (rows: SentRow[], identity: unknown, compileId: unknown) => {
        log.push({ kind: 'note', rows: [...rows], identity, compileId, storedIds: contextManager.getAllMessages().map((m) => m.id) });
        if (opts.noteAs === 'throw') throw new Error('the store is gone');
        return opts.noteAs ?? true;
      };
    let renders = 0;
    const renderAsNewest = contextManager.renderAsNewest.bind(contextManager);
    contextManager.renderAsNewest = ((ids: string[]) => { renders++; return renderAsNewest(ids); }) as typeof renderAsNewest;
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    if (opts.render) {
      // A render, as a strategy with renderAsNewest gives one, from the stored bodies: the default strategy here
      // (PassthroughStrategy) has none, so the framework would compare the stored bodies themselves.
      const cm = contextManager as unknown as { renderAsNewest: (ids: string[]) => Array<ContentBlock[] | null> | undefined };
      cm.renderAsNewest = (ids) => opts.render!(ids.map((id) => contextManager.getMessage(id)?.content ?? null));
    }
    const compile = contextManager.compile.bind(contextManager);
    contextManager.compile = (async (budget, injections, o) => {
      const result = await compile(budget, injections, o);
      if (opts.noProvenance) delete (result as { provenance?: unknown }).provenance;
      log.push({ kind: 'compile', dryRun: (o as { dryRun?: boolean } | undefined)?.dryRun === true, identity: (o as { identity?: unknown } | undefined)?.identity,
        ...(result.provenance ? { compileId: result.provenance.compileId } : {}) });
      return result;
    }) as typeof compile;
    contextManager.addMessage('user', [{ type: 'text', text: 'Run twice.' }]);
    try {
      await framework.runEphemeralToCompletion(agent, contextManager);
    } finally {
      console.error = consoleError;
    }
    const stored = contextManager.getAllMessages();
    const notes = log.filter((e): e is Extract<Logged, { kind: 'note' }> => e.kind === 'note');
    const compiledIdentity = log.filter((e) => e.kind === 'compile').map((e) => e.identity);
    return { log, notes, compiledIdentity, stored, streams: membrane.calls.length, renders, errors: errors.filter((e) => e.includes('[thinking-binding]')) };
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

  it('names on every note the compile the stream was built from, and notes nothing where that compile reports no provenance', async () => {
    const { log, notes } = await turn();
    const compiled = log.find((e): e is Extract<Logged, { kind: 'compile' }> => e.kind === 'compile' && !e.dryRun);
    assert.equal(typeof compiled?.compileId, 'string');
    assert.deepEqual(notes.map((n) => n.compileId), notes.map(() => compiled!.compileId), 'the end note too');
    assert.equal((await turn({ noProvenance: true })).notes.length, 0);
  });

  it('notes a single-round turn once, at its end, with its reply', async () => {
    const { notes, stored } = await turn({ scripts: [[final()]] });
    assert.deepEqual(notes.map((n) => n.rows), [replies(stored)]);
  });

  it('notes the marker for a reply the wrapper-prose guard contains, since a system row stands where it would be', async () => {
    const { notes, stored } = await turn({ agent: { toolWrapperProseGuard: true }, scripts: [[final([signed('sig-1'), text('<test--echo/>')])]] });
    assert.ok(stored.some((m) => m.metadata?.kind === 'tool-wrapper-prose-contained'), 'the guard contained the reply');
    assert.deepEqual(notes.map((n) => n.rows), [[UNSTORED]]);
  });

  it('notes a stream a result ends at that boundary, with the round\'s reply and not its results', async () => {
    const { notes, stored } = await turn({ scripts: [[round('c1', [signed('sig-1'), text('Ending.')], 'end')]] });
    assert.deepEqual(notes.map((n) => n.rows), [replies(stored)]);
  });

  for (const [restart, agent] of [
    ['a budget restart', { maxStreamTokens: 50 }],
    // The budget is never passed, so only the window can restart the stream: the first call's prompt (100), its
    // output (10) and the reserve for the next response (100) pass a window of 150, and without the prompt wouldn't.
    ['a window restart', { maxStreamTokens: 1_000_000, maxTokens: 100, physicalWindowTokens: 150 }],
  ] as const) it(`notes a stream ${restart} ends before the restart's compile, and the restart's own stream after it`, async () => {
    const { log, notes, stored, streams } = await turn({
      agent, scripts: [[round('c1', [signed('sig-1'), text('Calling.')]), final()], [final()]],
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

  it('compares each stored row as the next compile renders it, so results the render cuts are marked', async () => {
    // As a per-message cap or an image limit would: the next compile renders each results row otherwise than the
    // stream was submitted it.
    const cut = (rendered: Array<ContentBlock[] | null> | undefined) => rendered?.map((content) => content?.map((block) =>
      block.type === 'tool_result' ? { ...block, content: '[cut]' } as ContentBlock : block) ?? null);
    const { notes } = await turn({ render: cut });
    assert.equal(notes.length, 3);
    assert.deepEqual(notes[2]!.rows.map((row) => typeof row === 'string' ? 'id' : row),
      ['id', UNSTORED, 'id', UNSTORED, 'id'], 'the replies render as stored; the results don\'t');
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

  it('notes a stream that ends on its last results with the rows so far, and no reply after them', async () => {
    const { notes, stored } = await turn({ last: [] });
    const [reply1, reply2, ...more] = replies(stored);
    assert.equal(more.length, 0, 'no reply after the last results');
    const results = resultRows(stored);
    assert.deepEqual(notes.map((n) => n.rows), [
      [reply1, results[0]], [reply1, results[0], reply2, results[1]], [reply1, results[0], reply2, results[1]],
    ]);
  });

  it('stops noting, and says so, once the context manager writes nothing for a note', async () => {
    const { notes, errors } = await turn({ noteAs: false });
    assert.equal(notes.length, 1, 'the first boundary\'s note, and none after it');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /wrote nothing for this stream's note/);
  });

  it('stops noting, and says so, once a note throws', async () => {
    const { notes, errors } = await turn({ noteAs: 'throw' });
    assert.equal(notes.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /couldn't note the rounds this stream sent/);
  });

  it('notes nothing, and renders nothing to note, with a context manager that has no noteRequestSent', async () => {
    const { notes, renders, stored, errors } = await turn({ noteAs: 'absent' });
    assert.equal(notes.length, 0);
    assert.equal(renders, 0);
    assert.equal(replies(stored).length, 3, 'the turn ran');
    assert.deepEqual(errors, []);
  });
});
