// Offline whole-history inflation probe. Build first, then run:
// node --expose-gc scripts/recovery-plan-cost.mjs [image-rows=128] [KiB-per-row=256]
// Seeds unpresented raw images and ONE presented text row; no inference/writes
// occur in the measured plan. Each sample uses a freshly reopened real store.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ContextManager } from '@animalabs/context-manager';
import { AgentFramework, residentContextOptions, storeOwnRow } from '../dist/src/index.js';

if (process.argv[2] === '--read') {
  // Open CM directly: framework registration can warm the raw snapshot before
  // recovery. A fresh process also avoids CM's shared StoredMessage/blob memo.
  const cm = await ContextManager.open({ path: process.argv[3], ...residentContextOptions('probe') });
  const fw = Object.create(AgentFramework.prototype);
  Object.assign(fw, {
    registry: { get: () => ({ relationships: { observes: [] } }), ownSlotOf: () => ({ namespace: null }) },
    activeStreams: new Map(), activeTurnTokens: new Map(), pendingAssistantBlocks: new Map(),
    storeSees: new WeakMap(), presentation: { presenting: () => true },
  });
  const agent = { name: 'probe', state: { status: 'idle' },
    toolResultGuard: { hasPending: false, idle: true }, getContextManager: () => cm };
  global.gc?.();
  const before = process.memoryUsage();
  const start = performance.now();
  const plan = fw.planNewestTurn(agent);
  const elapsedMs = performance.now() - start;
  const after = process.memoryUsage();
  if (plan.kind !== 'ready' || plan.rows.length !== 1) throw new Error('expected one-row plan');
  console.log(JSON.stringify({ elapsedMs: +elapsedMs.toFixed(1),
    heapDeltaMiB: +((after.heapUsed - before.heapUsed) / 2 ** 20).toFixed(1),
    rssDeltaMiB: +((after.rss - before.rss) / 2 ** 20).toFixed(1) }));
  cm.close();
  process.exit(0);
}
const rows = Number(process.argv[2] ?? 128);
const kib = Number(process.argv[3] ?? 256);
if (![rows, kib].every((n) => Number.isInteger(n) && n > 0)) throw new Error('positive integer sizes required');
const dir = mkdtempSync(join(tmpdir(), 'af-plan-cost-'));
const create = () => AgentFramework.create({
  storePath: join(dir, 'store.chronicle'), membrane: {},
  agents: [{ name: 'probe', model: 'unused', systemPrompt: 'unused', proseRouting: 'disabled' }],
  modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
});
let fw;
try {
  fw = await create();
  const agent = fw.getAgent('probe');
  const cm = agent.getContextManager();
  for (let i = 0; i < rows; i++) cm.addMessage('user', [{
    type: 'image', source: { type: 'base64', mediaType: 'image/png', data: randomBytes(kib * 768).toString('base64') },
  }]);
  storeOwnRow(agent, 'user', [{ type: 'text', text: 'only presented row' }]);
  await fw.stop(); fw = undefined;
  for (let sample = 1; sample <= 3; sample++) {
    const result = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, '--read', join(dir, 'store.chronicle')], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    console.log(JSON.stringify({ sample, rawImageRows: rows, base64MiB: rows * kib / 1024, presentedRows: 1 }));
    process.stdout.write(result.stdout);
  }
} finally {
  await fw?.stop();
  rmSync(dir, { recursive: true, force: true });
}
