/**
 * Child process for the boot repair's crash cases (presentation-crash.test.ts,
 * #291 AF-8). It boots a framework on argv[2]'s store with two residents,
 * mira (the primary) and oren, runs a turn of mira's, and HARD-EXITS
 * (process.exit, no stop()) at the point argv[3] names, once the store is
 * synced, so what was stored is on disk and nothing after it is.
 *
 *   own-row-before-window  mira's turn stores its reply, an own row, and the
 *                          process exits as the reply is presented to her,
 *                          before its window entry is written.
 *   arrivals-mid-turn      mira's turn, its first round and that round's
 *                          results stored and in her window, waits on its
 *                          second round's tool while two rows are stored
 *                          for her (one for her alone, one for both
 *                          residents, which idle oren is presented at once),
 *                          and the process exits with her turn alive.
 *
 * Before it exits it prints one line of JSON to stdout: the ids it stored,
 * and where each stood, as this process saw them. Exit code 0 means the
 * exit point was hit; anything else means the scenario could not be staged.
 */
import { ContextManager, type MessageId, type MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../../src/index.js';
import { GateModule, until } from './dendrite.js';
import { WireMembrane, final, round } from './wire-membrane.js';

const MODES = ['own-row-before-window', 'arrivals-mid-turn'] as const;
type Mode = typeof MODES[number];
const [storePath, modeArg] = process.argv.slice(2);
if (!storePath || !MODES.includes(modeArg as Mode)) {
  console.error(`usage: own-row-crash-child <storePath> ${MODES.join('|')}`);
  process.exit(2);
}
const mode = modeArg as Mode;

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (row: { content: ContentBlock[] } | null | undefined) =>
  row?.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('') ?? '';

let framework: AgentFramework | undefined;
/** Sync the store, report what this process saw, and exit hard. */
function exitHere(report: Record<string, unknown>): never {
  framework!.getStore().sync();
  console.log(JSON.stringify({ mode, ...report }));
  process.exit(0);
}

// The reply's presentation: the window entry is written by presentRows, so
// the exit comes before the real call, with the reply already stored.
const presentRows = ContextManager.prototype.presentRows;
ContextManager.prototype.presentRows = function (this: ContextManager, ids: readonly MessageId[], ...rest: unknown[]) {
  if (mode === 'own-row-before-window' && framework) {
    const reply = ids.find((id) => textOf(this.getMessage(id)).startsWith('OWN-REPLY'));
    if (reply !== undefined) {
      const oren = framework.getAgent('oren')!.getContextManager();
      exitHere({
        reply,
        stored: this.getMessage(reply) !== null,
        inMiraWindow: this.ordinalOf(reply) !== undefined,
        inOrenWindow: oren.ordinalOf(reply) !== undefined,
        miraWindow: this.getPresentedMessages().map((m) => textOf(m) || m.content.map((b) => b.type).join('+')),
      });
    }
  }
  return (presentRows as (...args: unknown[]) => ReturnType<typeof presentRows>).call(this, ids, ...rest);
} as typeof presentRows;

const membrane = new WireMembrane();
const gates = new GateModule();
framework = await AgentFramework.create({
  storePath,
  membrane: membrane.asMembrane(),
  agents: ['mira', 'oren'].map((name) => ({
    name, model: 'test-model', systemPrompt: `You are ${name}.`, allowedTools: 'all', proseRouting: 'disabled',
  })),
  modules: [gates],
  syncIntervalMs: 0,
  maintenanceIntervalMs: 0,
} as never);
const internals = framework as unknown as {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
  pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
};
const mira = framework.getAgent('mira')!.getContextManager();
const oren = framework.getAgent('oren')!.getContextManager();

if (mode === 'own-row-before-window') {
  membrane.script('mira', final([text('OWN-REPLY mira answers')]));
} else {
  membrane.script('mira',
    round('call-1', [text('mira looks')], 'wait', { gate: 'one' }),
    round('call-2', [text('mira looks again')], 'wait', { gate: 'two' }),
    final([text('mira done')]));
}
internals.addMessage('user', [text('ASK mira, a question')], undefined, { forAgent: 'mira' });
framework.start();
internals.pendingRequests.push({ agentName: 'mira', reason: 'test', source: 'test', timestamp: Date.now() });

if (mode === 'arrivals-mid-turn') {
  await until(() => gates.entered.has('one'), "mira's first round waiting on its tool", 30_000);
  gates.release('one');
  // A round is stored at its tool boundary, with its results: the first is
  // stored once the second round's tool is called.
  await until(() => gates.entered.has('two'), "mira's second round waiting on its tool", 30_000);
  const forMira = internals.addMessage('someone', [text('ARRIVAL for mira')], undefined, { forAgent: 'mira' });
  const forBoth = internals.addMessage('someone', [text('ARRIVAL for both')]);
  exitHere({
    forMira,
    forBoth,
    miraWindow: mira.getPresentedMessages().map((m) => textOf(m) || m.content.map((b) => b.type).join('+')),
    inMiraWindow: [mira.ordinalOf(forMira) !== undefined, mira.ordinalOf(forBoth) !== undefined],
    inOrenWindow: [oren.ordinalOf(forMira) !== undefined, oren.ordinalOf(forBoth) !== undefined],
  });
}

await until(() => false, 'the exit point', 30_000).catch(() => {});
console.error(`own-row-crash-child: the ${mode} exit was not reached`);
process.exit(3);
