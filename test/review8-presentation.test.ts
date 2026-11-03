/**
 * The framework's presentation points after one that failed, and what a
 * host is told of a failure (AF #844's bot review, findings 4, 6, 13, 36,
 * 54 and 79), driven through AgentFramework: a write through an agent whose
 * window is the record still reaches the other readers of its slot; a
 * write's placement says when the row is out of its agent's window; a
 * window left as the record is alerted; and the boot leaves out of a window
 * what it couldn't read for a wake.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { ContextManager, MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, type TraceEvent } from '../src/index.js';
import { AgentPresentation } from '../src/presentation.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];

interface Placement { agent?: string; messageId?: string; presented?: false }
interface Internals {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string; placement?: Placement }): MessageId;
  writeToFork(agent: unknown, content: ContentBlock[], metadata: Record<string, unknown>): Placement;
  activeTurnTokens: Map<string, number>;
  pendingRequests: Array<{ agentName: string; reason: string; source?: string }>;
}

/** Run `body` with console.error and console.warn caught; returns its result and the lines logged. */
async function logged<T>(body: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> {
  const { error, warn } = console;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = console.error;
  try { return { result: await body(), lines }; } finally { console.error = error; console.warn = warn; }
}

const dir = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'af-review8-presentation-'));
  dirs.push(made);
  return made;
};

/** A host's store whose index for `name`'s window is in another version's format, so its write-down leaves it in legacy mode. */
function storeWithForeignIndex(path: string, name: string): JsStore {
  const store = JsStore.openOrCreate({ path });
  store.registerState({ id: `agents/${name}/window`, strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 100 });
  store.appendToStateJson(`agents/${name}/window`, { v: 99 });
  return store;
}

/** Two residents, mira (the primary) and oren, over `store` or a store at `storePath`; creation's traces replayed into `traces`. */
async function residents(source: { store: JsStore } | { storePath: string }) {
  const traces: TraceEvent[] = [];
  const framework = await AgentFramework.create({
    ...source,
    membrane: new MockMembrane().asMembrane(),
    agents: [
      { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', proseRouting: 'disabled' },
      { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.', proseRouting: 'disabled' },
    ],
    modules: [],
    syncIntervalMs: 0,
    operatorLogPath: false,
  } as Parameters<typeof AgentFramework.create>[0]);
  framework.onTrace((event) => { traces.push(event); }, { replay: true });
  const internals = framework as unknown as Internals;
  const cm = (name: string): ContextManager => framework.getAgent(name)!.getContextManager();
  return { framework, traces, internals, cm };
}

describe("a write through an agent whose window is the record (AF #844 bot review finding 79)", () => {
  it("enters an idle co-resident's window at once", async () => {
    const store = storeWithForeignIndex(join(dir(), 'store.chronicle'), 'mira');
    const { result: r } = await logged(() => residents({ store }));
    try {
      assert.equal(r.cm('mira').windowMode(), 'legacy', "setup: mira's window couldn't be written down");
      assert.equal(r.cm('oren').windowMode(), 'presented', "setup: oren's is presented");
      const id = r.internals.addMessage('someone', text('a message for everyone'));
      assert.equal(r.cm('oren').windowStatusOf(id), 'in', "in oren's window at its write, though mira's isn't presented");
    } finally {
      await r.framework.stop();
      store.close();
    }
  });
});
