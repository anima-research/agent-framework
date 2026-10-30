/**
 * A batched event whose channel is tuned out before its batch fires is
 * dropped at delivery (EventGate.deliverEvents), whether it reached the gate
 * as a channel message, named by its registered id, or as a push event,
 * named by the adapter's raw id and registered under another.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-held-batch-route');
const REGISTERED = 'discord:g1:room';

describe('a batched event whose channel is tuned out before its batch fires', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

  for (const [eventType, channelId] of [
    ['mcpl:channel-incoming', REGISTERED],
    ['mcpl:push-event', 'room'],
  ] as const) {
    it(`is dropped at delivery, not woken for: ${eventType}`, async () => {
      const configPath = join(TMP_DIR, `${eventType.replace(':', '-')}.json`);
      writeFileSync(configPath, JSON.stringify({
        policies: [{ name: 'batch', match: { scope: [eventType] }, behavior: { debounce: 50 } }],
        default: 'skip',
      }));
      let held = false;
      const traces: Array<{ type: string; channels?: unknown[] }> = [];
      const wakes: string[] = [];
      const gate = new EventGate({
        configPath,
        emitTrace: (t) => traces.push(t as never),
        addMessage: () => '',
        requestInference: (agentName) => wakes.push(agentName),
        getAgentNames: () => ['agent'],
        isHeld: (serverId, channel) => held && serverId === 'discord' && channel === REGISTERED,
        resolveRouteChannel: (info) => (info.eventType === 'mcpl:push-event' ? REGISTERED : info.channelId),
      });
      try {
        gate.evaluate({ content: 'hi', eventType, serverId: 'discord', channelId, tags: [] });
        held = true;
        const deadline = Date.now() + 5_000;
        while (wakes.length === 0 && !traces.some((t) => t.type === 'gate:held-dropped')) {
          assert.ok(Date.now() < deadline, 'the batch fired');
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.deepStrictEqual(wakes, [], 'no wake for an event its channel now holds');
        assert.strictEqual(traces.filter((t) => t.type === 'gate:held-dropped').length, 1);
      } finally {
        gate.dispose();
      }
    });
  }
});
