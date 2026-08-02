/**
 * Regression gates for the set-rewrite quadratic-states fixes (2026-07-08
 * scaling campaign, Finding 2): persisted record size must be independent of
 * accumulated content.
 *
 * Families covered:
 *   - framework/inference-log        — appended, not Set-rewritten
 *   - framework/turn-checkpoints/*   — per-agent slots, not one global map
 *   - modules/<name>/<log>           — ModuleContext log-state API
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { Module, ModuleContext, ProcessEvent, ProcessState, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const INFERENCE_LOG_ID = 'framework/inference-log';
const TURN_CHECKPOINTS_ID = 'framework/turn-checkpoints';
const TURN_CHECKPOINTS_TREE_ID = 'framework/turn-checkpoints/tree';

/**
 * Payload sizes of all state_update records for states matching `match`,
 * in append order.
 */
function stateUpdateSizes(store: JsStore, match: (stateId: string) => boolean): number[] {
  const sizes: number[] = [];
  for (const id of store.getRecordIdsByType('state_update')) {
    const record = store.getRecord(id);
    if (!record) continue;
    // state_update payloads are MessagePack on current chronicle (2026-08
    // encoding migration) — decode via the store, with a raw-JSON fallback
    // for older chronicle builds that lack the method.
    const decoder = (store as unknown as { getStateUpdateJson?: (id: string) => string | null })
      .getStateUpdateJson;
    const json = decoder ? decoder.call(store, id) : record.payload.toString();
    if (!json) continue;
    const update = JSON.parse(json) as { state_id: string };
    if (match(update.state_id)) sizes.push(record.payload.length);
  }
  return sizes;
}

/** Assert the record family isn't growing: last record ≈ first record. */
function assertFlat(sizes: number[], label: string, tolerance = 1.5): void {
  assert.ok(sizes.length >= 2, `${label}: expected ≥2 records, got ${sizes.length}`);
  const first = sizes[0];
  const last = sizes[sizes.length - 1];
  assert.ok(
    last <= first * tolerance,
    `${label}: record size grew ${first} → ${last} bytes over ${sizes.length} records — ` +
    `looks like accumulated content is being rewritten per update`
  );
}

describe('state scaling regression gates', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'af-state-scaling-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(storePath: string) {
    return AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
      modules: [],
    });
  }

  it('inference log: Nth record size is independent of N', async () => {
    const storePath = join(tempDir, 'inference.chronicle');
    const framework = await createFramework(storePath);
    const store = framework.getStore();

    const N = 30;
    for (let i = 0; i < N; i++) {
      (framework as any).logInference({
        timestamp: Date.now(),
        agentName: 'assistant',
        requestId: `req-${i}`,
        success: true,
        durationMs: 100,
        request: { i },
        response: { ok: true },
      });
    }

    const entries = store.getStateJson(INFERENCE_LOG_ID);
    assert.strictEqual(entries.length, N, 'all entries readable back');

    const sizes = stateUpdateSizes(store, (id) => id === INFERENCE_LOG_ID);
    assertFlat(sizes, INFERENCE_LOG_ID);

    await framework.stop();
  });

  it('inference log: appends compose with a legacy Set-written array', async () => {
    const storePath = join(tempDir, 'legacy-log.chronicle');

    // Write the state the old way: whole-array Set, as pre-fix stores did.
    {
      const store = JsStore.openOrCreate({ path: storePath });
      store.registerState({
        id: INFERENCE_LOG_ID,
        strategy: 'append_log',
        deltaSnapshotEvery: 100,
        fullSnapshotEvery: 20,
      });
      store.setStateJson(INFERENCE_LOG_ID, [
        { timestamp: 1, agentName: 'old', requestId: 'legacy-0', success: true },
        { timestamp: 2, agentName: 'old', requestId: 'legacy-1', success: false },
      ]);
      store.close();
    }

    const framework = await createFramework(storePath);
    (framework as any).logInference({
      timestamp: 3,
      agentName: 'assistant',
      requestId: 'new-0',
      success: true,
      durationMs: 5,
    });

    const entries = framework.getStore().getStateJson(INFERENCE_LOG_ID);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].requestId, 'legacy-0');
    assert.strictEqual(entries[2].requestId, 'new-0');

    await framework.stop();
  });

  it('turn checkpoints: record size and state count independent of agents-ever-spawned', async () => {
    const storePath = join(tempDir, 'checkpoints.chronicle');
    const framework = await createFramework(storePath);
    const store = framework.getStore();

    // M spawn-and-dispose subagents, several turns each.
    const M = 25;
    for (let m = 0; m < M; m++) {
      const name = `spawn-task-d1-${1000 + m}`;
      for (let turn = 0; turn < 3; turn++) {
        (framework as any).recordTurnCheckpoint(name);
      }
      (framework as any).evictTurnCheckpoints(name);
    }
    // A persistent agent keeps taking turns throughout.
    for (let turn = 0; turn < 5; turn++) {
      (framework as any).recordTurnCheckpoint('assistant');
    }

    // Every write is one tree op (path + blob hash): flat across the whole
    // run even though M unique agents came and went.
    const sizes = stateUpdateSizes(store, (id) => id === TURN_CHECKPOINTS_TREE_ID);
    assertFlat(sizes, TURN_CHECKPOINTS_TREE_ID, 4);

    // Disposal removed the key outright — the tree holds only live agents...
    for (let m = 0; m < M; m++) {
      assert.strictEqual(
        store.treeGet(TURN_CHECKPOINTS_TREE_ID, `spawn-task-d1-${1000 + m}`),
        null,
        'disposed agent key removed from checkpoint tree'
      );
    }
    assert.strictEqual((framework as any).getTurnCheckpoints('assistant').length, 5);

    // ...and no per-agent state registration leaked into the state index —
    // chronicle has no deregistration and rewrites + fsyncs the index on
    // every sync tick, so index entries must not scale with spawns-ever.
    const checkpointStates = store.listStates().filter((s: { id: string }) => s.id.startsWith(TURN_CHECKPOINTS_ID));
    assert.strictEqual(checkpointStates.length, 1, 'exactly one checkpoint state registered');

    await framework.stop();
  });

  it('turn checkpoints: legacy single-map stores are readable, migrate on save, and evict without ghosts', async () => {
    const storePath = join(tempDir, 'legacy-checkpoints.chronicle');

    {
      const store = JsStore.openOrCreate({ path: storePath });
      store.registerState({ id: TURN_CHECKPOINTS_ID, strategy: 'snapshot' });
      store.setStateJson(TURN_CHECKPOINTS_ID, {
        assistant: [
          { agentName: 'assistant', turnIndex: 0, sequenceBefore: 1, branchName: 'main', timestamp: 1 },
        ],
        'spawn-ghost-d1-1234': [
          { agentName: 'spawn-ghost-d1-1234', turnIndex: 3, sequenceBefore: 9, branchName: 'main', timestamp: 2 },
        ],
      });
      store.close();
    }

    const framework = await createFramework(storePath);
    const store = framework.getStore();

    // Legacy entry visible through the fallback read...
    const before = (framework as any).getTurnCheckpoints('assistant');
    assert.strictEqual(before.length, 1);
    assert.strictEqual(before[0].turnIndex, 0);

    // ...and the first new turn migrates the list into the tree.
    (framework as any).recordTurnCheckpoint('assistant');
    const entry = store.treeGet(TURN_CHECKPOINTS_TREE_ID, 'assistant');
    assert.ok(entry, 'tree entry created on first save');
    const migrated = (framework as any).getTurnCheckpoints('assistant');
    assert.strictEqual(migrated.length, 2);
    assert.strictEqual(migrated[0].turnIndex, 0);

    // Evicting an agent whose checkpoints live only in the legacy map writes
    // an empty tombstone — a later agent reusing the name must NOT inherit
    // the dead agent's checkpoints through the fallback.
    (framework as any).evictTurnCheckpoints('spawn-ghost-d1-1234');
    assert.deepStrictEqual((framework as any).getTurnCheckpoints('spawn-ghost-d1-1234'), []);
    // Idempotent: a second evict doesn't rewrite the tombstone (blob "[]" is
    // content-addressed, but the tree op record would still be new).
    const recordsBefore = store.getRecordIdsByType('state_update').length;
    (framework as any).evictTurnCheckpoints('spawn-ghost-d1-1234');
    assert.strictEqual(store.getRecordIdsByType('state_update').length, recordsBefore);

    await framework.stop();
  });

  it('module log states: append/edit records are O(item), state is reconstructable', async () => {
    const storePath = join(tempDir, 'module-log.chronicle');

    let capturedCtx: ModuleContext | null = null;
    const logModule: Module = {
      name: 'logtest',
      async start(ctx: ModuleContext) {
        capturedCtx = ctx;
        ctx.registerLogState('log');
      },
      async stop() {},
      getTools(): ToolDefinition[] { return []; },
      async handleToolCall(_call: ToolCall): Promise<ToolResult> {
        return { success: true };
      },
      async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
        return {};
      },
    };

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
      modules: [logModule],
    });
    const ctx = capturedCtx!;
    const store = framework.getStore();

    const N = 30;
    for (let i = 0; i < N; i++) {
      ctx.appendToLog('log', { id: `item-${i}`, content: 'x'.repeat(50) });
    }
    assert.strictEqual(ctx.getLogLength('log'), N);

    // Point-edit keeps the record O(item), not O(log).
    ctx.editLogItem('log', 3, { id: 'item-3', content: 'edited' });
    const items = ctx.getLog<{ id: string; content: string }>('log');
    assert.strictEqual(items.length, N);
    assert.strictEqual(items[3].content, 'edited');
    assert.strictEqual(items[4].id, 'item-4');

    const sizes = stateUpdateSizes(store, (id) => id === 'modules/logtest/log');
    assertFlat(sizes, 'modules/logtest/log');

    // Idempotent re-registration must not throw (restart path).
    ctx.registerLogState('log');
    // Reserved / invalid names are rejected.
    assert.throws(() => ctx.registerLogState('state'));
    assert.throws(() => ctx.appendToLog('nested/name', {}));
    // Writes to a never-registered name fail immediately — chronicle would
    // accept the append but never snapshot the state, turning a typo into a
    // silent full-chain-replay-on-restore trap.
    assert.throws(() => ctx.appendToLog('lgo', { oops: true }), /not registered/);
    assert.throws(() => ctx.editLogItem('lgo', 0, {}), /not registered/);
    assert.strictEqual(ctx.getLogLength('log'), N, 'registered log still intact');

    await framework.stop();
  });
});
