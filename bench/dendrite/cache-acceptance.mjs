/**
 * Live acceptance run for the Dendrite rendering contract.
 *
 * The fork tests prove provider-formatted content identity up to the fork
 * boundary. This script asks the real provider the question that test
 * cannot: does a fork's FIRST request read the resident's cache?
 *
 *   phase 1  resident turn: writes the cache            (cache_creation ≈ prefix)
 *   phase 2  resident turn: own reuse, the control      (cache_read ≈ prefix)
 *   phase 3  fork at the boundary, first request        (cache_read ≈ prefix?)
 *   phase 4  resident blocks in a tool call; a fork
 *            derived mid-round, first request           (cache_read ≈ prefix?)
 *
 * Needs the local build (`npm run build`) and either ANTHROPIC_API_KEY, or
 * GATE_TOKEN + GATE_URL for an Anthropic-compatible inference gateway.
 *   node bench/dendrite/cache-acceptance.mjs [model]
 * Nothing here prints the environment.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Membrane, AnthropicAdapter, NativeFormatter } from '@animalabs/membrane';
import { AgentFramework, AutobiographicalStrategy } from '../../dist/src/index.js';
import { GateModule, until } from '../../dist/test/helpers/dendrite.js';

const model = process.argv[2] ?? 'claude-sonnet-5-5';
const viaGate = !!process.env.GATE_TOKEN;
if (!viaGate && !process.env.ANTHROPIC_API_KEY) {
  console.error('set ANTHROPIC_API_KEY, or GATE_TOKEN (+ GATE_URL) for a gateway');
  process.exit(2);
}
const adapterConfig = viaGate
  ? { apiKey: process.env.GATE_TOKEN, baseURL: process.env.GATE_URL ?? 'https://gate.animalabs.ai/anthropic' }
  : {};

const dir = mkdtempSync(join(tmpdir(), 'dendrite-cache-acceptance-'));
const gates = new GateModule();
// Native tools and roles, as residents run: the XML default is a prefill formatter, which Sonnet 5.5 rejects.
const inner = new Membrane(new AnthropicAdapter(adapterConfig), { assistantParticipant: 'mira', formatter: new NativeFormatter() });

// Record each request's shape next to the usage the provider reports for it.
let phase = 'setup';
const requests = [];
const membrane = new Proxy(inner, {
  get(target, prop, receiver) {
    if (prop === 'streamYielding') {
      return (request, options) => {
        const built = new NativeFormatter().buildMessages(request.messages, {
          participantMode: 'multiuser', assistantParticipant: request.assistantParticipant ?? 'mira', tools: request.tools,
          systemPrompt: request.system, promptCaching: request.promptCaching ?? true,
          cacheMarkers: request.cacheMarkers ?? 'membrane-system', cacheTtl: request.cacheTtl,
        });
        const marked = [];
        built.messages.forEach((m, i) => {
          const blocks = Array.isArray(m.content) ? m.content : [];
          if (blocks.some((b) => b.cache_control)) marked.push(`${i}:${m.role}`);
        });
        const systemMarked = Array.isArray(built.system) && built.system.some((b) => b.cache_control);
        requests.push({ phase, messages: request.messages.length, provider: built.messages.length, markers: `${systemMarked ? 'sys,' : ''}${marked.join(',') || 'none'}`, cacheMarkers: request.cacheMarkers ?? 'membrane-system', breakpoints: request.messages.filter((m) => m.cacheBreakpoint).length });
        return target.streamYielding(request, options);
      };
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

// The production shape: a folding resident. Message cache breakpoints exist
// only once there is a recall ladder (summaries) in the compiled view, so the
// windows are small enough that this history folds; summaries are written by
// the same model through the same route.
const makeStrategy = () => new AutobiographicalStrategy({
  compressionModel: model,
  adaptiveResolution: true,
  targetChunkTokens: 400,
  recentWindowTokens: 1500,
});

const framework = await AgentFramework.create({
  storePath: join(dir, 'store.chronicle'),
  membrane,
  agents: [{
    name: 'mira',
    model,
    strategy: makeStrategy(),
    systemPrompt: 'You are mira, a terse assistant used in an automated acceptance run. Follow instructions literally.',
  }],
  modules: [gates],
  syncIntervalMs: 0,
  maintenanceIntervalMs: 0,
});

const usage = []; // { phase, agent, input, cacheCreation, cacheRead }
let completed = 0;
framework.onTrace((event) => {
  if (event.type === 'inference:usage') {
    const u = event.tokenUsage;
    usage.push({ phase, agent: event.agentName, input: u.input, cacheCreation: u.cacheCreation ?? 0, cacheRead: u.cacheRead ?? 0, output: u.output });
  }
  if (event.type === 'inference:completed') completed++;
  if (event.type === 'inference:error') console.error('[inference:error]', JSON.stringify(event).slice(0, 400));
});

const cm = framework.getAgent('mira').getContextManager();
// ~6k tokens of history: well past every model's minimum cacheable prefix.
for (let i = 0; i < 40; i++) {
  cm.addMessage(i % 2 ? 'mira' : 'user', [{ type: 'text', text: `Turn ${i}. ` + `The quick brown fox jumps over the lazy dog number ${i}. `.repeat(10) }]);
}
let ticks = 0;
while (!cm.isReady()) { await cm.tick(); ticks++; }
console.error(`history seeded; ${ticks} ticks to ready`);

framework.start();
const internals = framework; // pendingRequests is the same door the framework's own tests use
async function residentTurn(text, label) {
  phase = label;
  cm.addMessage('user', [{ type: 'text', text }]);
  const before = completed;
  internals.pendingRequests.push({ agentName: 'mira', reason: 'acceptance', source: 'acceptance', timestamp: Date.now() });
  await until(() => completed > before, `${label} to complete`, 60_000);
}

try {
  await residentTurn('Reply with exactly one word: ready.', 'p1-resident-write');
  await residentTurn('Reply with exactly one word: again.', 'p2-resident-reuse');

  phase = 'p3-fork-at-boundary';
  const forkA = await framework.deriveAgent({
    name: 'fork-a',
    from: 'mira',
    strategy: makeStrategy(),
    framing: [{ participant: 'user', content: [{ type: 'text', text: 'You are a fork of mira. Reply with exactly one word: forked.' }] }],
  });
  await framework.runEphemeralToCompletion(forkA.agent, forkA.contextManager);

  // Mid-round: ask the resident for a tool call that blocks, derive while it waits.
  phase = 'p4-resident-tool-call';
  cm.addMessage('user', [{ type: 'text', text: 'Call the tool test--wait once with input {"gate": "g1"}. Say nothing else.' }]);
  internals.pendingRequests.push({ agentName: 'mira', reason: 'acceptance', source: 'acceptance', timestamp: Date.now() });
  let midRound = true;
  try {
    await until(() => gates.entered.has('g1'), 'mira to block in test--wait', 60_000);
  } catch {
    midRound = false;
    console.error('mira did not call the tool; phase 4 skipped');
  }
  if (midRound) {
    phase = 'p4-fork-mid-round';
    const forkB = await framework.deriveAgent({
      name: 'fork-b',
      from: 'mira',
      strategy: makeStrategy(),
      framing: [{ participant: 'user', content: [{ type: 'text', text: 'Reply with exactly one word: forked.' }] }],
    });
    await framework.runEphemeralToCompletion(forkB.agent, forkB.contextManager);
    phase = 'p4-resident-finish';
    const before = completed;
    gates.release('g1');
    await until(() => completed > before, 'mira to finish her turn', 60_000);
  }
} finally {
  await framework.stop();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`model: ${model}  route: ${viaGate ? 'gateway' : 'direct'}`);
console.log('phase                      agent   msgs  input  cache_creation  cache_read  markers');
for (const u of usage) {
  const r = requests.find((q) => q.phase === u.phase);
  if (!r) continue; // a tool-result continuation reports cumulative stream usage; not a request of its own
  console.log(`${u.phase.padEnd(26)} ${u.agent.padEnd(7)} ${String(r?.messages ?? '?').padStart(4)} ${String(u.input).padStart(6)} ${String(u.cacheCreation).padStart(15)} ${String(u.cacheRead).padStart(11)}  ${r ? `${r.cacheMarkers} bp=${r.breakpoints} ${r.markers}` : ''}`);
}
const by = (p) => usage.find((u) => u.phase === p);
const control = by('p2-resident-reuse')?.cacheRead ?? 0;
for (const p of ['p3-fork-at-boundary', 'p4-fork-mid-round']) {
  const u = by(p);
  if (!u) continue;
  const ratio = control ? (u.cacheRead / control) : 0;
  console.log(`${p}: cache_read is ${(ratio * 100).toFixed(1)}% of the resident's own reuse (${u.cacheRead} / ${control})`);
}
