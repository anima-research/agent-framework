/**
 * Write paths the AF #844 bot review (round 8) found wanting: an agent's own
 * row whose add throws with rows of it stored (storeOwnRow and the
 * tool-result guard's two writes), the boot's worker-ended notice and the
 * results it reads, the deferred-write importer and the held mail its boot
 * releases, the coalescer's failure snapshot, and the window reads whose
 * failure a caller has to be able to tell from an answer.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteLandedError, WriteOutcomeUnknownError, type ContextManager, type MessageId } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { Agent } from '../src/index.js';
import { storeOwnRow } from '../src/dendrite/audience.js';
import { WireMembrane } from './helpers/wire-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (row: { content: ContentBlock[] }) => row.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Errors the framework logs while a test makes a write throw, kept off the test's output. */
async function quietly<T>(run: () => T | Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const quiet = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); };
  try {
    return { value: await run(), logged };
  } finally {
    console.error = quiet;
  }
}

async function bootOne() {
  const dir = mkdtempSync(join(tmpdir(), 'af-review8-writes-'));
  dirs.push(dir);
  const membrane = new WireMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', allowedTools: 'all', proseRouting: 'disabled' }],
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  frameworks.push(framework);
  framework.start();
  await framework.runUntilIdle();
  const agent = framework.getAgent('mira')! as Agent;
  const cm = agent.getContextManager();
  const rowOf = (t: string) => cm.getAllMessages().find((m) => textOf(m) === t);
  const status = (t: string) => { const row = rowOf(t); return row ? cm.windowStatusOf(row.id) : 'absent'; };
  const window = () => cm.getPresentedMessages().map((m) => textOf(m));
  return { framework, agent, cm, rowOf, status, window };
}

/** The manager's next add of a row carrying `marker` lands, then its own listener throws (WriteLandedError). */
function landThenThrowOnce(cm: ContextManager, marker: string): void {
  const target = cm as unknown as { handleMessageStoreEvent(event: unknown): void };
  const original = target.handleMessageStoreEvent;
  target.handleMessageStoreEvent = function (event: unknown) {
    original.call(cm, event);
    if ((event as { type?: string }).type === 'add' && JSON.stringify(event).includes(marker)) {
      target.handleMessageStoreEvent = original;
      throw new Error('a listener failed after the append');
    }
  };
}

/** The manager's next add of a row carrying `marker` stores it, then throws WriteOutcomeUnknownError naming it landed and `unknown` as maybe stored. */
function unknownOutcomeOnce(cm: ContextManager, marker: string, unknown: MessageId[] = []): void {
  const original = cm.addMessage;
  cm.addMessage = function (this: ContextManager, ...args: Parameters<ContextManager['addMessage']>) {
    const id = original.apply(cm, args);
    if (!JSON.stringify(args[1]).includes(marker)) return id;
    cm.addMessage = original;
    throw new WriteOutcomeUnknownError({ landed: [id], unknown, unnamed: 0 }, new Error('the store read failed'));
  } as ContextManager['addMessage'];
}

describe('an own row whose add throws with rows of it stored (AF #844 findings 2, 3)', () => {
  it('storeOwnRow presents a landed row, throws on, and a later own row enters after it', async () => {
    const h = await bootOne();
    landThenThrowOnce(h.cm, 'own-landed');
    const { value: thrown } = await quietly(() => {
      try { storeOwnRow(h.agent, 'mira', [text('own-landed')]); } catch (error) { return error; }
      return undefined;
    });
    assert.ok(thrown instanceof WriteLandedError, 'the add\'s error is passed on');
    assert.equal(h.status('own-landed'), 'in', 'the row it stored is presented as a returned write\'s');
    storeOwnRow(h.agent, 'mira', [text('own-later')]);
    assert.deepEqual(h.window().slice(-2), ['own-landed', 'own-later'], 'the window keeps store order');
  });

  it('storeOwnRow presents an unknown-outcome write\'s landed rows, but not a named row the store no longer holds', async () => {
    const h = await bootOne();
    const traces: string[] = [];
    h.framework.onTrace((event) => { if (event.type === 'presentation:failed') traces.push(event.type); });
    unknownOutcomeOnce(h.cm, 'own-unknown', ['no-such-row' as MessageId]);
    const { value: thrown } = await quietly(() => {
      try { storeOwnRow(h.agent, 'mira', [text('own-unknown')]); } catch (error) { return error; }
      return undefined;
    });
    assert.ok(thrown instanceof WriteOutcomeUnknownError, 'the add\'s error is passed on');
    assert.equal(h.status('own-unknown'), 'in', 'the row it knows landed is presented');
    assert.deepEqual(traces, [], 'a named row the store doesn\'t hold isn\'t offered to the window, which would refuse the call');
    storeOwnRow(h.agent, 'mira', [text('own-later')]);
    assert.deepEqual(h.window().slice(-2), ['own-unknown', 'own-later']);
  });

  it('a row held back (present: false) stays out of the window though its add threw after it landed', async () => {
    const h = await bootOne();
    landThenThrowOnce(h.cm, 'held-back');
    await quietly(() => { try { storeOwnRow(h.agent, 'mira', [text('held-back')], undefined, undefined, false); } catch { /* passed on */ } });
    assert.equal(h.status('held-back'), 'out', 'its writer held it back for the next point\'s sweep');
  });

  for (const guard of [false, true]) {
    for (const kind of ['landed', 'unknown'] as const) {
      it(`the tool-result guard (${guard ? 'on' : 'off'}) presents a results row whose add threw ${kind === 'landed' ? 'after it landed' : 'with an unknown outcome'}, and throws on`, async () => {
        const h = await bootOne();
        h.agent.toolResultGuard.setOverride(guard);
        const marker = guard ? 'tool_result' : 'results-row';
        if (kind === 'landed') landThenThrowOnce(h.cm, marker); else unknownOutcomeOnce(h.cm, marker);
        const before = h.cm.getAllMessages().length;
        const content: ContentBlock[] = guard
          ? [{ type: 'tool_result', toolUseId: 'call-1', content: 'results-row' } as ContentBlock]
          : [text('results-row')];
        const { value: thrown } = await quietly(() => {
          try {
            h.agent.toolResultGuard.storeResults(content, [{ toolUseId: 'call-1', content: 'results-row' }],
              [{ id: 'call-1', name: 'test--read', input: {}, result: { success: true, data: 'results-row' } }] as never, undefined, undefined);
          } catch (error) { return error; }
          return undefined;
        });
        assert.ok(thrown instanceof (kind === 'landed' ? WriteLandedError : WriteOutcomeUnknownError), 'the add\'s error is passed on');
        const stored = h.cm.getAllMessages().slice(before);
        assert.equal(stored.length, 1, 'the results row is stored');
        assert.equal(h.cm.windowStatusOf(stored[0]!.id), 'in', 'and presented, as a returned write\'s');
        if (guard) {
          // No batch is pending (as before): a next batch stages as its own.
          assert.doesNotThrow(() => h.agent.toolResultGuard.storeResults(content, [{ toolUseId: 'call-2', content: 'x' }],
            [{ id: 'call-2', name: 'test--read', input: {}, result: { success: true, data: 'x' } }] as never, undefined, undefined));
        }
      });
    }
  }
});
