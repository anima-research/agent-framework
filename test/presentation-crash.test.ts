/**
 * The boot repair after a crash (#291, AF-8). A process that dies between
 * storing a row and writing its window entry, or with a turn alive and rows
 * stored for it out of its window, leaves the index as it stood; the next
 * boot reads each agent's own rows and arrivals from the index alone, with
 * no cursor kept beside it. Each case runs a child process that stages the
 * crash and exits hard (helpers/own-row-crash-child.ts), then boots the
 * store again.
 *
 * - An own row stored and not yet presented (its window entry not written)
 *   is presented to its owner alone at the next boot, after the rows its
 *   request carried, traced as a repair; the owner's next request carries
 *   it, and a later boot has nothing to repair.
 * - Rows stored for an agent while its turn was alive are still its
 *   arrivals after the reboot. A quiesced boot leaves them out of its
 *   window, and resume presents them after the crashed turn's stored rows,
 *   in the order they were stored; a serving boot presents them at its rest
 *   pass. A row for both residents that the idle one was shown before the
 *   crash is in its window once.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import { until } from './helpers/dendrite.js';
import { WireMembrane, final } from './helpers/wire-membrane.js';

const CHILD = fileURLToPath(new URL('./helpers/own-row-crash-child.js', import.meta.url));
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (row: { content: readonly unknown[] }) =>
  (row.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text).join('')
  || (row.content as Array<{ type: string }>).map((b) => b.type).join('+');

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Run the child on a new store at `mode`'s exit point; return the store and what the child saw as it exited. */
async function crash<R>(mode: string, signal: AbortSignal): Promise<{ storePath: string; report: R & { mode: string } }> {
  const dir = mkdtempSync(join(tmpdir(), 'af-presentation-crash-'));
  dirs.push(dir);
  const storePath = join(dir, 'store');
  const { status, stdout, stderr } = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, storePath, mode], { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
  assert.equal(status, 0, `the child exited where it was told (stderr: ${stderr.slice(-800)})`);
  const line = stdout.split('\n').reverse().find((l) => l.startsWith('{'));
  assert.ok(line, `the child reported what it saw (stdout: ${stdout.slice(-800)})`);
  const report = JSON.parse(line) as R & { mode: string };
  assert.equal(report.mode, mode);
  return { storePath, report };
}

/** Boot the store again, as the child did, every trace kept from the start. */
async function boot(storePath: string, membrane = new WireMembrane()) {
  const framework = await AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: ['mira', 'oren'].map((name) => ({
      name, model: 'test-model', systemPrompt: `You are ${name}.`, allowedTools: 'all', proseRouting: 'disabled',
    })),
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  } as never);
  frameworks.push(framework);
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); }, { replay: true });
  const cm = (name: string) => framework.getAgent(name)!.getContextManager();
  const windowTexts = (name: string) => cm(name).getPresentedMessages().map(textOf);
  const presentations = () => traces
    .filter((t) => t.type === 'presentation:presented' || t.type === 'presentation:repaired')
    .map((t) => [t.type, (t as { agentName: string }).agentName, (t as { occasion?: string }).occasion, (t as { count: number }).count]);
  return { framework, membrane, traces, cm, windowTexts, presentations };
}

/** The host-mode record a quiesce leaves, so the next boot is quiesced. */
function quiesced(storePath: string): void {
  mkdirSync(join(storePath, 'recovery'), { recursive: true });
  writeFileSync(join(storePath, 'recovery', 'host-mode.json'), JSON.stringify({ version: 1, quiesced: true, reason: 'surgery', since: Date.now() }));
}

describe('a crash between a row and its window entry, and the boot after it (#291)', () => {
  it('an own row stored, its window entry not written, is presented to its owner alone at the next boot, and her next request carries it', { timeout: 120_000 }, async (t) => {
    const { storePath, report } = await crash<{
      reply: string; stored: boolean; inMiraWindow: boolean; inOrenWindow: boolean; miraWindow: string[];
    }>('own-row-before-window', t.signal);
    assert.deepEqual([report.stored, report.inMiraWindow, report.inOrenWindow], [true, false, false],
      "the premise: the reply was stored, and the process ended before it entered mira's window");
    assert.deepEqual(report.miraWindow, ['ASK mira, a question'], 'the premise: her window held what her request carried');

    let h = await boot(storePath);
    assert.deepEqual(h.windowTexts('mira'), ['ASK mira, a question', 'OWN-REPLY mira answers'], 'repaired into her window, after what her request carried');
    assert.equal(h.cm('mira').windowStatusOf(report.reply), 'in');
    assert.equal(h.cm('oren').ordinalOf(report.reply), undefined, "never into oren's: it is mira's own row");
    assert.deepEqual(h.presentations(), [['presentation:repaired', 'mira', undefined, 1]], 'one repair, and nothing else presented at the boot');
    const ordinal = h.cm('mira').ordinalOf(report.reply);

    // Her next request carries it, after what the one before carried.
    h.membrane.script('mira', final([text('again')]));
    h.framework.start();
    (h.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'mira', reason: 'test', source: 'test', timestamp: Date.now() });
    await until(() => h.windowTexts('mira').includes('again'), "mira's next turn", 30_000);
    await h.framework.runUntilIdle();
    const [request] = h.membrane.callsFor('mira');
    assert.deepEqual(request!.messages.map(textOf), ['ASK mira, a question', 'OWN-REPLY mira answers', '[Continue]'],
      'her next request is her window, then the request-only prompt a window that ends on her own reply takes');
    await h.framework.stop();

    h = await boot(storePath);
    assert.equal(h.cm('mira').ordinalOf(report.reply), ordinal, 'a later boot leaves it where it is');
    assert.deepEqual(h.presentations(), [], 'and has nothing to repair');
  });

  it("rows stored for an agent while its turn was alive are still its arrivals after a crash: a quiesced boot leaves them out of its window, and resume presents them after the turn's stored rows", { timeout: 120_000 }, async (t) => {
    const { storePath, report } = await crash<{
      forMira: string; forBoth: string; miraWindow: string[]; inMiraWindow: boolean[]; inOrenWindow: boolean[];
    }>('arrivals-mid-turn', t.signal);
    assert.deepEqual(report.miraWindow, ['ASK mira, a question', 'mira looks', 'tool_result'],
      "the premise: her turn's first round and its results were in her window");
    assert.deepEqual(report.inMiraWindow, [false, false], 'the premise: both rows were stored out of her live window');
    assert.deepEqual(report.inOrenWindow, [false, true], 'the premise: idle oren was shown the row for both at once');

    quiesced(storePath);
    const h = await boot(storePath);
    assert.equal(h.framework.getHostModeStatus().quiesced, true, 'the premise: a quiesced boot');
    assert.deepEqual([report.forMira, report.forBoth].map((id) => h.cm('mira').windowStatusOf(id)), ['out', 'out'],
      'still her arrivals, read from the index');
    assert.deepEqual(h.windowTexts('mira'), report.miraWindow, 'her window as the crash left it');
    assert.deepEqual([report.forMira, report.forBoth].map((id) => h.cm('oren').windowStatusOf(id)), ['out', 'in'], "oren's as the crash left it");
    assert.deepEqual(h.presentations(), [], 'the boot presents nothing while frozen');

    await h.framework.resume();
    assert.deepEqual(h.windowTexts('mira'), [...report.miraWindow, 'ARRIVAL for mira', 'ARRIVAL for both'],
      "resume presents them after the crashed turn's rows, in the order they were stored");
    assert.deepEqual(h.windowTexts('oren').filter((x) => x.startsWith('ARRIVAL')), ['ARRIVAL for both'], "oren's, once");
  });

  it('a serving boot after such a crash presents those arrivals at its rest pass, each to its readers once', { timeout: 120_000 }, async (t) => {
    const { storePath, report } = await crash<{ forMira: string; forBoth: string; miraWindow: string[] }>('arrivals-mid-turn', t.signal);
    const h = await boot(storePath);
    assert.equal(h.framework.getHostModeStatus().quiesced, false, 'the premise: a serving boot');
    assert.deepEqual(h.windowTexts('mira'), [...report.miraWindow, 'ARRIVAL for mira', 'ARRIVAL for both'],
      "after the crashed turn's rows, in the order they were stored");
    assert.deepEqual(h.presentations(), [['presentation:presented', 'mira', 'at-rest', 2]], 'presented at the boot, to mira alone');
    assert.deepEqual(h.windowTexts('oren').filter((x) => x.startsWith('ARRIVAL')), ['ARRIVAL for both'], "oren's, once");
  });
});
