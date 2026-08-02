/**
 * Whole-store scaling sweep (scaling campaign Finding 2, end-to-end gate).
 *
 * The unit gates in state-scaling.test.ts pin the four known writers by
 * calling them directly. This test validates the REGIME instead: it drives a
 * synthetic workload through the framework's public surface — external
 * messages with tool rounds, ephemeral spawn-and-dispose cycles, process
 * logging on — then sweeps EVERY state family the store accumulated and
 * asserts none of them grows superlinearly. A quadratic writer added anywhere
 * (the way logProcessEvent silently duplicated logInference's bug) fails this
 * test the day it's introduced, without anyone having to know to test it.
 *
 * Family classification:
 *   - capped families (per-agent turn-checkpoint slots) legitimately ramp to
 *     a fixed cap and plateau — small-N slope fits are noisy on that shape
 *     (a ramp-heavy window fits as "rising"), so they get a hard max-record-
 *     size bound instead, which is the stronger invariant anyway.
 *   - everything else with enough records gets a log-log slope fit of
 *     bytes-per-record vs index; flat ≈ healthy, ≈1 ≈ quadratic aggregate.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Module, ModuleContext, ProcessEvent, ProcessState, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const SLOPE_LIMIT = 0.3;
const MIN_RECORDS_FOR_FIT = 8;
/** Bounded-by-design families get a hard per-record ceiling instead of a
 *  slope fit: the checkpoint tree's ops are O(key) and its periodic
 *  consolidation snapshots are O(live keys) — both far under this, while a
 *  whole-map rewrite under fleet load blows past it. */
const CAPPED_MAX_RECORD_BYTES = 16 * 1024;
const CAPPED_FAMILIES = [/^framework\/turn-checkpoints\//];

/** OLS slope of ln(bytes) on ln(index) — same fit latency.mjs uses. */
function logLogSlope(sizes: number[]): number {
  const pts = sizes.map((y, i) => ({ x: i + 1, y })).filter((p) => p.y > 0);
  const lx = pts.map((p) => Math.log(p.x));
  const ly = pts.map((p) => Math.log(p.y));
  const mx = lx.reduce((a, b) => a + b, 0) / lx.length;
  const my = ly.reduce((a, b) => a + b, 0) / ly.length;
  let num = 0, den = 0;
  for (let i = 0; i < lx.length; i++) {
    num += (lx[i] - mx) * (ly[i] - my);
    den += (lx[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** All state_update payload sizes in append order, grouped by state id. */
function sweepStateFamilies(store: { getRecordIdsByType(t: string): string[]; getRecord(id: string): { payload: Buffer } | null; getStateUpdateJson?: (id: string) => string | null }): Map<string, number[]> {
  const families = new Map<string, number[]>();
  for (const id of store.getRecordIdsByType('state_update')) {
    const record = store.getRecord(id);
    if (!record) continue;
    // state_update payloads are MessagePack on current chronicle (2026-08
    // encoding migration) — decode via the store, with a raw-JSON fallback
    // for older chronicle builds that lack the method.
    const json = store.getStateUpdateJson ? store.getStateUpdateJson(id) : record.payload.toString();
    if (!json) continue;
    const update = JSON.parse(json) as { state_id: string };
    let sizes = families.get(update.state_id);
    if (!sizes) families.set(update.state_id, (sizes = []));
    sizes.push(record.payload.length);
  }
  return families;
}

/** Minimal module providing one tool, so turns exercise real tool rounds. */
class EchoModule implements Module {
  readonly name = 'echo';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{
      name: 'echo',
      description: 'Echo the input back',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return { success: true, data: (call.input as { message?: string }).message ?? '' };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{
          participant: 'User',
          content: [{ type: 'text', text: String(event.content) }],
        }],
        requestInference: true,
      };
    }
    return {};
  }
}

describe('whole-store scaling sweep (e2e)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'af-scaling-e2e-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('no state family grows superlinearly under a synthetic fleet workload', async () => {
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'e2e.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a test assistant.' }],
      modules: [new EchoModule()],
      // Exercise the process log — it's registered append_log and had the
      // same Set-rewrite bug as the inference log.
      processLogging: { persist: true },
    });

    // Phase 1: persistent-agent turns, each with one tool round. Every turn
    // writes: turn checkpoint, process log entries, inference log entry,
    // message appends — the production write set.
    const TURNS = 40;
    for (let t = 0; t < TURNS; t++) {
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: `Working on request ${t}.` },
        { type: 'tool_use', id: `call-${t}`, name: 'echo--echo', input: { message: `payload ${t}` } },
      ], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: `Done with request ${t}.` },
      ]));

      framework.pushEvent({
        type: 'external-message',
        source: 'e2e',
        content: `Request number ${t}, please handle it.`,
        metadata: {},
      });
      await framework.runUntilIdle();
    }

    // Phase 2: spawn-and-dispose ephemeral agents — the fleet regime that
    // grew the old checkpoint map without bound.
    const SPAWNS = 12;
    for (let s = 0; s < SPAWNS; s++) {
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: `Scout ${s} reporting: nothing to see.` },
      ]));
      const { agent, contextManager, cleanup } = await framework.createEphemeralAgent({
        name: `e2e-scout-${s}`,
        model: 'test-model',
        systemPrompt: 'You are a scout.',
      });
      contextManager.addMessage('user', [{ type: 'text', text: `Scout task ${s}` }]);
      const run = framework.runEphemeralToCompletion(agent, contextManager);
      await framework.runUntilIdle();
      await run;
      cleanup();
    }

    const store = framework.getStore();
    const families = sweepStateFamilies(store);

    // The workload must actually have exercised the families this test
    // exists to watch — otherwise a routing change could green-wash it.
    const inferenceLog = families.get('framework/inference-log') ?? [];
    const processLog = families.get('framework/process-log') ?? [];
    assert.ok(inferenceLog.length >= TURNS, `inference log exercised (${inferenceLog.length} records)`);
    assert.ok(processLog.length >= TURNS, `process log exercised (${processLog.length} records)`);
    const checkpointTree = families.get('framework/turn-checkpoints/tree') ?? [];
    assert.ok(checkpointTree.length >= TURNS + SPAWNS, `checkpoint tree exercised (${checkpointTree.length} records)`);

    // Disposal actually removed the scouts' keys — the tree stays O(live
    // agents), and no per-agent state registration leaked into chronicle's
    // state index (which is rewritten + fsynced on every sync tick).
    for (let s = 0; s < SPAWNS; s++) {
      assert.strictEqual(
        store.treeGet('framework/turn-checkpoints/tree', `e2e-scout-${s}`),
        null,
        `disposed scout ${s} evicted from checkpoint tree`
      );
    }
    assert.ok(store.treeGet('framework/turn-checkpoints/tree', 'assistant'), 'persistent agent keeps its checkpoints');
    const stateCount = store.listStates().length;
    const checkpointStates = store.listStates().filter((s: { id: string }) => s.id.startsWith('framework/turn-checkpoints')).length;
    assert.strictEqual(checkpointStates, 1, `exactly one checkpoint state registered (index has ${stateCount} states total)`);

    // The sweep: every family, classified, no exemptions beyond the rules —
    // and no silent caps: families too small for a slope fit are listed.
    const violations: string[] = [];
    const skipped: string[] = [];
    for (const [stateId, sizes] of families) {
      if (CAPPED_FAMILIES.some((re) => re.test(stateId))) {
        const max = Math.max(...sizes);
        if (max > CAPPED_MAX_RECORD_BYTES) {
          violations.push(`${stateId}: capped family record hit ${max} B (limit ${CAPPED_MAX_RECORD_BYTES})`);
        }
        continue;
      }
      if (sizes.length < MIN_RECORDS_FOR_FIT) {
        skipped.push(`${stateId} (${sizes.length})`);
        continue;
      }
      const slope = logLogSlope(sizes);
      if (slope >= SLOPE_LIMIT) {
        violations.push(
          `${stateId}: bytes/record slope ${slope.toFixed(2)} over ${sizes.length} records ` +
          `(${sizes[0]} B → ${sizes[sizes.length - 1]} B) — superlinear growth`
        );
      }
    }
    if (skipped.length > 0) {
      console.log(
        `[state-scaling-e2e] ${skipped.length} families below the ${MIN_RECORDS_FOR_FIT}-record fit threshold ` +
        `(unaudited by the slope gate): ${skipped.join(', ')}`
      );
    }
    assert.deepStrictEqual(violations, [], `superlinear state families:\n  ${violations.join('\n  ')}`);

    await framework.stop();
  });
});
