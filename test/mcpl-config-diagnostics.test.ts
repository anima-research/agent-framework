/**
 * Configuration that is accepted but silently does nothing must say so, on
 * the console AND on the trace bus (hosts keep per-server logs from traces):
 *
 *   - a tool-name pattern (`toolClassOverrides` key, `toolLifecycle.*.tools`)
 *     that matches no model-facing tool — typically written against the bare
 *     server id while the default toolPrefix is `mcpl--<serverId>`;
 *   - a feature set §6.4 derivation disables although config enabled it;
 *   - a server refusing the host's initial policy.
 */
import { describe, it, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { checkToolPattern } from '../src/mcpl/tool-pattern-check.js';
import type { McplCapabilities, McplServerConfig } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/config-diagnostics-mcpl-server.mjs');

type Traced = { type: string; [key: string]: unknown };

/** Record console.error lines (not printed) until the returned stop() runs. */
function captureConsoleError(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  return { lines, stop: () => { console.error = original; } };
}

const withoutTimestamp = ({ timestamp: _t, ...rest }: Traced) => rest;

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// ----------------------------------------------------------------------------
// Pattern verdicts
// ----------------------------------------------------------------------------

test('checkToolPattern: matched, pending on an unlisted server, unmatched with the right namespace', () => {
  const servers = [
    { id: 'search', prefix: 'mcpl--search', listed: true },
    { id: 'chat', prefix: 'chat', listed: true },
    { id: 'late', prefix: 'mcpl--late', listed: false },
  ];
  const names = ['mcpl--search--query', 'chat--send', 'think'];

  assert.deepEqual(checkToolPattern('mcpl--search--*', names, servers), { kind: 'matched' });
  assert.deepEqual(checkToolPattern('think', names, servers), { kind: 'matched' });

  // The bare server id, while the default prefix is in effect.
  const bare = checkToolPattern('search--*', names, servers);
  assert.equal(bare.kind, 'unmatched');
  assert.equal(bare.kind === 'unmatched' && bare.suggestion, 'mcpl--search--*');
  assert.match(bare.kind === 'unmatched' ? bare.hint : '', /no toolPrefix set; the default is "mcpl--<serverId>"/);

  // The default form, for a server that set its own toolPrefix.
  const dflt = checkToolPattern('mcpl--chat--send', names, servers);
  assert.equal(dflt.kind === 'unmatched' && dflt.suggestion, 'chat--send');

  // A server whose listing is not in yet decides nothing about its own
  // namespace, nor about wildcards that could reach it...
  assert.deepEqual(checkToolPattern('mcpl--late--x', names, servers), { kind: 'pending', servers: ['late'] });
  assert.equal(checkToolPattern('*--x', names, servers).kind, 'pending');
  // ...but a bare-id pattern can never match its tools, listed or not.
  const lateBare = checkToolPattern('late--x', names, servers);
  assert.equal(lateBare.kind === 'unmatched' && lateBare.suggestion, 'mcpl--late--x');

  // No server at all under that prefix; a plain non-match.
  const ghost = checkToolPattern('mcpl--ghost--*', names, servers);
  assert.equal(ghost.kind, 'unmatched');
  assert.equal(ghost.kind === 'unmatched' && ghost.suggestion, undefined);
  assert.match(ghost.kind === 'unmatched' ? ghost.hint : '', /no connected MCPL server/);
  const typo = checkToolPattern('thnik', names, servers);
  assert.match(typo.kind === 'unmatched' ? typo.hint : '', /no tool the framework offers/);
});

// ----------------------------------------------------------------------------
// End to end: real framework, real stdio servers
// ----------------------------------------------------------------------------

/** Subscribes at module start, so it sees traces emitted during create(). */
class TraceTap implements Module {
  readonly name = 'tap';
  readonly traces: Traced[] = [];
  async start(ctx: ModuleContext): Promise<void> {
    ctx.onTrace((e: TraceEvent) => { this.traces.push(e as unknown as Traced); });
  }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(): Promise<EventResponse> { return {}; }
}

describe('configuration diagnostics end to end', () => {
  let tempDir: string;
  let gatePath: string;
  let framework: AgentFramework;
  let tap: TraceTap;
  let consoleCapture: ReturnType<typeof captureConsoleError>;

  const unmatched = () => tap.traces.filter((t) => t.type === 'mcpl:tool-pattern-unmatched').map(withoutTimestamp);
  const reportedPatterns = () => unmatched().map((t) => t.pattern).sort();

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcpl-config-diagnostics-'));
    gatePath = join(tempDir, 'late.up');
    tap = new TraceTap();
    consoleCapture = captureConsoleError();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [tap],
      syncIntervalMs: 0,
      toolClassOverrides: {
        'prov--run': ['shell'],             // bare id: matches nothing
        'mcpl--prov--click': ['computer'],  // correct: silent
        'mcpl--late--click': ['computer'],  // correct once `late` lists
        'mcpl--late--clik': ['computer'],   // typo: undecided until `late` lists
        'mcpl--ghost--*': ['web'],          // no such server
        'think': ['memory'],                // a framework tool: silent
      },
      mcplServers: [
        {
          id: 'prov',
          command: process.execPath,
          args: [FIXTURE],
          env: { FEATURE_SETS: JSON.stringify({ 'prov.chat': { description: 'declares no uses' } }) },
          enabledFeatureSets: ['prov.chat'],
          toolLifecycle: { observe: { tools: ['prov--*', 'mcpl--prov--run'] } },
        },
        {
          // Loses the boot race; connects on a later reconnect attempt.
          id: 'late',
          command: process.execPath,
          args: [FIXTURE],
          env: { GATE_PATH: gatePath },
          reconnect: true,
          reconnectIntervalMs: 50,
          reconnectMaxIntervalMs: 200,
        } as McplServerConfig,
      ],
    });
  });

  after(async () => {
    consoleCapture?.stop();
    await framework?.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports zero-match patterns at startup, with the mcpl--<serverId> form suggested', () => {
    assert.deepEqual(reportedPatterns(), ['mcpl--ghost--*', 'prov--*', 'prov--run']);
    const byPattern = new Map(unmatched().map((t) => [t.pattern, t]));
    assert.deepEqual(
      { ...byPattern.get('prov--run'), hint: undefined },
      { type: 'mcpl:tool-pattern-unmatched', setting: 'toolClassOverrides', pattern: 'prov--run', suggestion: 'mcpl--prov--run', hint: undefined },
    );
    assert.deepEqual(
      { ...byPattern.get('prov--*'), hint: undefined },
      {
        type: 'mcpl:tool-pattern-unmatched',
        setting: 'toolLifecycle.observe.tools',
        serverId: 'prov',
        pattern: 'prov--*',
        suggestion: 'mcpl--prov--*',
        hint: undefined,
      },
    );
    assert.equal(byPattern.get('mcpl--ghost--*')!.suggestion, undefined);
    assert.match(String(byPattern.get('mcpl--ghost--*')!.hint), /no connected MCPL server/);

    // The console line is there too, naming the setting and the fix.
    assert.ok(
      consoleCapture.lines.some((l) =>
        l.includes('toolClassOverrides pattern "prov--run" matches no tool — did you mean "mcpl--prov--run"?')),
      consoleCapture.lines.join('\n'),
    );
    assert.ok(consoleCapture.lines.some((l) => l.includes('prov: toolLifecycle.observe.tools pattern "prov--*"')));
  });

  it('does not judge a late-connecting server\'s patterns before its first listing', async () => {
    assert.equal(framework.getAllTools().some((t) => t.name.startsWith('mcpl--late--')), false, 'late is still down');
    assert.equal(reportedPatterns().includes('mcpl--late--clik'), false);
    assert.equal(reportedPatterns().includes('mcpl--late--click'), false);

    writeFileSync(gatePath, '');
    await waitFor(
      () => framework.getAllTools().some((t) => t.name === 'mcpl--late--click'),
      'late server listed after reconnect',
    );
    // The check runs in the same refresh that installed the listing.
    assert.deepEqual(reportedPatterns(), ['mcpl--ghost--*', 'mcpl--late--clik', 'prov--*', 'prov--run']);
    const typo = unmatched().find((t) => t.pattern === 'mcpl--late--clik')!;
    assert.equal(typo.suggestion, undefined);
  });

  it('reports each pattern once across later refreshes', async () => {
    await (framework as unknown as { refreshMcplTools(): Promise<void> }).refreshMcplTools();
    await (framework as unknown as { refreshMcplTools(): Promise<void> }).refreshMcplTools();
    const patterns = unmatched().map((t) => t.pattern);
    assert.equal(new Set(patterns).size, patterns.length, `duplicates in ${patterns.join(', ')}`);
    assert.equal(consoleCapture.lines.filter((l) => l.includes('pattern "prov--run" matches no tool')).length, 1);
  });

  it('traces a feature set disabled for undeclared uses although config enabled it', () => {
    const disabled = tap.traces.filter((t) => t.type === 'mcpl:feature-set-disabled').map(withoutTimestamp);
    assert.deepEqual(disabled, [{
      type: 'mcpl:feature-set-disabled',
      serverId: 'prov',
      featureSet: 'prov.chat',
      reason: 'invalid_uses',
      selectedByConfig: true,
      unrecognized: [],
    }]);
    assert.ok(consoleCapture.lines.some((l) =>
      l.includes('prov/prov.chat disabled: invalid_uses (§6.4 — uses absent or empty) — overrides enabledFeatureSets')));
  });
});

// ----------------------------------------------------------------------------
// Feature-set derivation and policy refusal, unit level
// ----------------------------------------------------------------------------

test('FeatureSetManager: each §6.4 disablement is traced beside its console line', () => {
  const traces: Traced[] = [];
  const manager = new FeatureSetManager((e) => traces.push(e));
  const capabilities = {
    version: '0.5',
    pushEvents: true,
    featureSets: {
      'chat.events': { description: 'pushes', uses: ['pushEvents'] },
      'chat.bare': { description: 'no uses' },
      'chat.odd': { description: 'unknown path', uses: ['no.such.path'] },
      'chat.watch': { description: 'needs a missing capability', uses: ['inferenceLifecycle'] },
    },
  } as unknown as McplCapabilities;
  const grant = new CapabilityGrant(new Set(['pushEvents']), []);
  const capture = captureConsoleError();
  try {
    // chat.odd is not selected by config: still traced, selectedByConfig false.
    manager.initializeServer('srv', capabilities, { enabledFeatureSets: ['chat.events', 'chat.bare', 'chat.watch'] }, grant);
  } finally {
    capture.stop();
  }
  assert.equal(manager.isEnabled('srv', 'chat.events'), true);
  assert.deepEqual(traces, [
    { type: 'mcpl:feature-set-disabled', serverId: 'srv', featureSet: 'chat.bare', reason: 'invalid_uses', selectedByConfig: true, unrecognized: [] },
    { type: 'mcpl:feature-set-disabled', serverId: 'srv', featureSet: 'chat.odd', reason: 'invalid_uses', selectedByConfig: false, unrecognized: ['no.such.path'] },
    { type: 'mcpl:feature-set-disabled', serverId: 'srv', featureSet: 'chat.watch', reason: 'missing_capabilities', selectedByConfig: true, missing: ['inferenceLifecycle'] },
  ]);
  assert.equal(capture.lines.length, 3);
  assert.match(capture.lines[0]!, /srv\/chat\.bare disabled: invalid_uses .* — overrides enabledFeatureSets$/);
  assert.doesNotMatch(capture.lines[1]!, /overrides enabledFeatureSets/);

  // A scratch manager (no trace sink) derives the same state silently on the bus.
  const scratch = new FeatureSetManager();
  const quiet = captureConsoleError();
  try {
    scratch.initializeServer('srv', capabilities, undefined, grant);
  } finally {
    quiet.stop();
  }
  assert.equal(scratch.isEnabled('srv', 'chat.bare'), false);
  assert.equal(quiet.lines.length, 3, 'the console line stays');
});

test('registerMcplServerFeatures: a refused initial policy is traced, and fallback close closes', async () => {
  for (const fallback of ['close', 'mcp-only'] as const) {
    const fw = Object.create(AgentFramework.prototype) as any;
    fw.traceListeners = [];
    fw.featureSetManager = new FeatureSetManager();
    fw.checkpointManager = null;
    const traces: Traced[] = [];
    fw.onTrace((e: Traced) => traces.push(e));
    let closed = 0;
    let established = 0;
    const connection = {
      id: 'srv',
      capabilities: { version: '0.5', pushEvents: true } as unknown as McplCapabilities,
      mcpToolsAdvertised: false,
      establishGrant: () => { established++; },
      sendFeatureSetsUpdateRequest: async () => ({ accepted: false, fallback, reason: 'policy too narrow' }),
      close: async () => { closed++; },
    };
    const capture = captureConsoleError();
    try {
      await fw.registerMcplServerFeatures({ id: 'srv', command: 'unused' } as McplServerConfig, connection);
    } finally {
      capture.stop();
    }
    assert.equal(closed, fallback === 'close' ? 1 : 0, fallback);
    assert.equal(established, 0, 'a refusal never establishes the grant');
    assert.deepEqual(
      traces.filter((t) => t.type === 'mcpl:policy-refused').map(withoutTimestamp),
      [{ type: 'mcpl:policy-refused', serverId: 'srv', phase: 'initial', reason: 'policy too narrow', fallback }],
    );
    assert.ok(capture.lines.some((l) => l.includes(`srv refused initial policy (policy too narrow) — fallback: ${fallback}`)));
  }
});
