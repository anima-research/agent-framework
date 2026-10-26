import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HealthModule } from '../src/modules/health/index.js';
import type { AgentFramework } from '../src/framework.js';
import type { JsStore } from '@animalabs/chronicle';
import type { ToolCall } from '../src/types/events.js';

/**
 * buildSnapshot only needs queryInferenceLogs (store/ctx paths are skipped
 * when includeSubagents=false and no ctx is bound), so a minimal framework
 * stub exercises the projectSummary presentation path directly.
 */
function frameworkStub(entries: unknown[]): AgentFramework {
  return {
    queryInferenceLogs: () => ({ entries, total: entries.length, hasMore: false }),
  } as unknown as AgentFramework;
}

function snapshotCall(): ToolCall {
  return {
    id: 'call-1',
    name: 'snapshot',
    input: { includeSubagents: false, includeTokens: false },
  } as unknown as ToolCall;
}

interface SnapshotData {
  inferences: {
    successCount: number;
    errorCount: number;
    recentErrors: Array<{ timestamp: unknown; agentName?: string }>;
  };
}

describe('HealthModule snapshot timestamp resilience', () => {
  it('degrades gracefully when a legacy record lacks a timestamp', async () => {
    const entries = [
      {
        sequence: 0,
        // Legacy persisted record: no timestamp field at all.
        entry: { agentName: 'legacy', requestId: 'r0', success: false, error: 'boom', request: {}, durationMs: 1 },
      },
      {
        sequence: 1,
        entry: { timestamp: 1751900000000, agentName: 'ok', requestId: 'r1', success: true, request: {}, durationMs: 1 },
      },
    ];
    const health = new HealthModule({ timeZone: 'UTC' });
    health.bind(frameworkStub(entries), {} as JsStore);

    const result = await health.handleToolCall(snapshotCall());

    // One bad record must not sink the whole snapshot.
    assert.equal(result.success, true, `snapshot failed: ${result.error}`);
    const data = result.data as SnapshotData;
    assert.equal(data.inferences.successCount, 1);
    assert.equal(data.inferences.errorCount, 1);
    // The bad record's timestamp degrades to null (undefined ?? null).
    assert.equal(data.inferences.recentErrors[0]!.timestamp, null);
  });

  it('emits the raw value for a non-numeric timestamp instead of throwing', async () => {
    const entries = [
      {
        sequence: 0,
        entry: { timestamp: 'not-a-date', agentName: 'weird', requestId: 'r2', success: false, error: 'x', request: {}, durationMs: 1 },
      },
    ];
    const health = new HealthModule({ timeZone: 'UTC' });
    health.bind(frameworkStub(entries), {} as JsStore);

    const result = await health.handleToolCall(snapshotCall());

    assert.equal(result.success, true, `snapshot failed: ${result.error}`);
    const data = result.data as SnapshotData;
    assert.equal(data.inferences.recentErrors[0]!.timestamp, 'not-a-date');
  });

  it('still formats valid timestamps in the configured zone', async () => {
    const entries = [
      {
        sequence: 0,
        entry: { timestamp: Date.UTC(2026, 0, 2, 3, 4, 5), agentName: 'ok', requestId: 'r3', success: false, error: 'y', request: {}, durationMs: 1 },
      },
    ];
    const health = new HealthModule({ timeZone: 'UTC' });
    health.bind(frameworkStub(entries), {} as JsStore);

    const result = await health.handleToolCall(snapshotCall());

    assert.equal(result.success, true, `snapshot failed: ${result.error}`);
    const data = result.data as SnapshotData;
    assert.equal(
      data.inferences.recentErrors[0]!.timestamp,
      '2026-01-02T03:04:05.000+00:00 [UTC]',
    );
  });
});

describe('HealthModule snapshot error text', () => {
  it('cuts a recent error at 400 units without halving a surrogate pair', async () => {
    // 399 units, then an emoji whose two units straddle the 400-unit cut.
    const error = `${'e'.repeat(399)}😀 and on`;
    const entries = [
      { sequence: 0, entry: { timestamp: 1751900000000, agentName: 'a', requestId: 'r0', success: false, error, request: {}, durationMs: 1 } },
    ];
    const health = new HealthModule({ timeZone: 'UTC' });
    health.bind(frameworkStub(entries), {} as JsStore);

    const result = await health.handleToolCall(snapshotCall());

    assert.equal(result.success, true, `snapshot failed: ${result.error}`);
    const shown = (result.data as { inferences: { recentErrors: Array<{ error: string }> } }).inferences.recentErrors[0]!.error;
    assert.equal(shown, 'e'.repeat(399), 'the cut leaves the emoji out whole');
  });
});
