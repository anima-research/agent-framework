import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { MembraneError } from '@animalabs/membrane';
import { createMockResponse, MockYieldingStream } from './helpers/mock-membrane.js';
import { fixture, eventually, ok, TS } from './helpers/coalescing-fixture.js';

const ROOM = 'discord:g1:room';
const ADDRESSED = ['chat:mention', 'chat:addressed', 'chat:from-human'];
const NOTE = '[inference-failed] Your previous turn did not complete: the provider API refused its last call.';
const LOOKUP = [{ name: 'lookup', description: 'Look something up.', inputSchema: { type: 'object' } }];

const refused = (category = 'reasoning_extraction', content: ContentBlock[] = []) => ({
  ...createMockResponse(content, 'refusal'), toolCalls: [],
  raw: { request: {}, response: { stop_details: { category } } },
}) as unknown as NormalizedResponse;
const answer = (text: string) => createMockResponse([{ type: 'text', text }]);

/** A call the provider fails with an error that isn't retried: its turn ends failed. */
class FailedCall implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  provideToolResults(): void {}
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield {
      type: 'error',
      error: new MembraneError({ type: 'invalid_request', retryable: false, httpStatus: 400, message: 'the provider could not process the request', rawError: { status: 400 } }),
    } as StreamEvent;
  }
}

type Internals = {
  logFailure(record: Record<string, unknown>): void;
  channelRegistry: { getDesiredState(serverId: string, channelId: string): string | undefined };
};

async function rig(t: TestContext, opts: { agents?: unknown[]; tools?: unknown[] } = {}) {
  const f = await fixture({
    agents: opts.agents, tools: opts.tools,
    toolsCall: () => ({ content: [{ type: 'text', text: 'what the tool saw' }] }),
  });
  t.after(f.close);
  const streams: Array<() => YieldingStream> = [];
  f.membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
    f.membrane.calls.push(request);
    const make = streams.shift();
    return make ? make() : new MockYieldingStream([ok()]);
  };
  f.framework.start();
  const fw = f.framework as unknown as Internals;
  const failures: Array<Record<string, unknown>> = [];
  t.mock.method(fw, 'logFailure', (record: Record<string, unknown>) => { failures.push(record); });
  await f.send('channels/register', { channels: [{ id: ROOM, type: 'discord', label: 'room', initiallyOpen: true }] });
  await eventually(() => fw.channelRegistry.getDesiredState('editor', ROOM) === 'open', 'room is open');
  let sent = 0;
  /** One addressed message, and the turn it wakes, answered by `responses` (one per call). */
  const turn = async (...responses: Array<NormalizedResponse | 'failed'>) => {
    const before = f.membrane.calls.length;
    const messageId = `m-${++sent}`;
    streams.push(() => (responses[0] === 'failed' ? new FailedCall() : new MockYieldingStream(responses as NormalizedResponse[])));
    await f.send('channels/incoming', {
      messages: [{ channelId: ROOM, messageId, timestamp: TS, author: { id: 'u', name: 'User' }, tags: ADDRESSED, content: [{ type: 'text', text: `message ${messageId}` }] }],
    });
    await eventually(() => f.membrane.calls.length > before, `the turn for ${messageId}`);
    await f.framework.runUntilIdle();
  };
  const rows = (kind: string) => f.framework.getAgent('agent')!.getContextManager().getAllMessages()
    .filter((m) => (m.metadata as { kind?: unknown } | undefined)?.kind === kind);
  const notes = () => rows('inference-refused')
    .map((m) => m.content.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`)).join(''));
  return { f, turn, rows, notes, failures };
}

describe('a turn the provider refused leaves the agent a note, one for a run of such turns', () => {
  it('one refused turn: one note, which starts no turn, and the next request carries it once', async (t) => {
    const r = await rig(t);
    await r.turn(refused());
    assert.deepEqual(r.notes(), [NOTE]);
    assert.deepEqual(r.rows('inference-refused')[0]!.metadata, { ...r.rows('inference-refused')[0]!.metadata, system: true, category: 'reasoning_extraction' });
    assert.equal(r.f.membrane.calls.length, 1, 'the note wakes nobody');
    await r.turn(answer('here again'));
    assert.equal(r.f.lastRequest().split(NOTE).length - 1, 1, 'the answered turn read the note');
  });

  it('refused turns in a row: the one note is updated where it is, and says how many followed', async (t) => {
    const r = await rig(t);
    await r.turn(refused());
    const id = r.rows('inference-refused')[0]!.id;
    await r.turn(refused());
    assert.deepEqual(r.notes(), [`${NOTE} The turn after it ended the same way.`]);
    await r.turn(refused());
    await r.turn(refused());
    assert.deepEqual(r.notes(), [`${NOTE} The 3 turns after it ended the same way.`]);
    assert.equal(r.rows('inference-refused')[0]!.id, id);
    const context = r.f.context();
    assert.ok(context.indexOf('message m-1') < context.indexOf(NOTE) && context.indexOf(NOTE) < context.indexOf('message m-2'),
      'the note stays after the first refused turn, before the messages of the turns that followed');
    await r.turn(answer('here again'));
    assert.ok(r.f.lastRequest().includes(`${NOTE} The 3 turns after it ended the same way.`));
  });

  it('a refused turn after an answered one: the first note stays as written, and a new one is started', async (t) => {
    const r = await rig(t);
    await r.turn(refused());
    await r.turn(refused());
    await r.turn(answer('here again'));
    await r.turn(refused());
    assert.deepEqual(r.notes(), [`${NOTE} The turn after it ended the same way.`, NOTE]);
  });

  it('a turn refused after a round of it was answered: that round read the first note, so a new one is started', async (t) => {
    const r = await rig(t, { tools: LOOKUP });
    await r.turn(refused());
    const call = { type: 'tool_use', id: 'look-1', name: 'mcpl--editor--lookup', input: {} } as ContentBlock;
    const round = [{ type: 'text', text: 'let me look' } as ContentBlock, call];
    await r.turn(
      createMockResponse(round, 'tool_use'),
      refused('reasoning_extraction', [...round, { type: 'tool_result', toolUseId: 'look-1', content: 'what the tool saw' } as ContentBlock]),
    );
    assert.deepEqual(r.notes(), [NOTE, NOTE]);
    const context = r.f.context();
    assert.ok(context.lastIndexOf(NOTE) > context.indexOf('what the tool saw'), 'the new note follows the round that ran');
  });

  it('a refusal of another category leaves no note', async (t) => {
    const r = await rig(t);
    await r.turn(refused('cyber'));
    assert.deepEqual(r.notes(), []);
  });

  it('a turn refused in another category between two told ones: it ends the run, so the second note counts from itself', async (t) => {
    const r = await rig(t);
    await r.turn(refused());
    await r.turn(refused('cyber'));
    await r.turn(refused());
    assert.deepEqual(r.notes(), [NOTE, NOTE]);
  });

  it('a failed turn between two refused ones: it ends the run, so the second note counts from itself', async (t) => {
    const r = await rig(t);
    await r.turn(refused());
    await r.turn('failed');
    assert.ok(r.failures.some((record) => record.kind === 'inference-exhausted'), 'premise: the turn between failed');
    await r.turn(refused());
    assert.deepEqual(r.notes(), [NOTE, NOTE]);
  });

  it('a note an undo took out of the window: the next refused turn starts a new one there, and the old row is left as written', async (t) => {
    const r = await rig(t);
    await r.turn(refused());
    r.f.framework.undoLastTurn('agent');
    assert.ok(!r.f.window().includes(NOTE), 'premise: the undo took the note out of the window');
    assert.deepEqual(r.notes(), [NOTE], 'premise: the record keeps the row');
    await r.turn(refused());
    assert.equal(r.f.window().split(NOTE).length - 1, 1, 'the window holds the new note');
    assert.deepEqual(r.notes(), [NOTE, NOTE]);
  });

  it('a refused turn a rewind takes leaves the rewind\'s note only', async (t) => {
    const r = await rig(t, { agents: [{ name: 'agent', model: 'test', systemPrompt: 'test', refusalHandling: { retries: 0, autoRewind: true, maxRewinds: 1 } }] });
    await r.turn(refused());
    assert.equal(r.rows('refusal-rewind').length, 1, 'premise: the rewind took the refusal');
    assert.deepEqual(r.notes(), []);
  });

  it('SUPPRESS_INFERENCE_FAILED_MARKER=1 leaves the note out', async (t) => {
    const before = process.env.SUPPRESS_INFERENCE_FAILED_MARKER;
    process.env.SUPPRESS_INFERENCE_FAILED_MARKER = '1';
    t.after(() => {
      if (before === undefined) delete process.env.SUPPRESS_INFERENCE_FAILED_MARKER;
      else process.env.SUPPRESS_INFERENCE_FAILED_MARKER = before;
    });
    const r = await rig(t);
    await r.turn(refused());
    assert.deepEqual(r.notes(), []);
  });
});
