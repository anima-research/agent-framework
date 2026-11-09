/**
 * A derived agent is registered — and its source told, when the host asks —
 * when it starts running, so these tests run each fork to completion.
 *
 * The host's two hooks over derivations (docs/dendrite.md): beforeDerive
 * refuses any derivation or spawn with its own reason before the agent
 * exists, and derivationNotice decides what the source is told. The
 * framework attaches no meaning to either.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, workerSpec } from '../src/index.js';
import type { AgentSpec, AgentRecord } from '../src/index.js';
import { RoutedMembrane, say } from './helpers/dendrite.js';

async function boot(dir: string, dendrite: Record<string, unknown>, membrane = new RoutedMembrane()) {
  const fw = await AgentFramework.create({
    storePath: join(dir, `${Math.random().toString(36).slice(2)}.chronicle`), membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    dendrite, modules: [], syncIntervalMs: 0,
  });
  fw.start();
  return fw;
}

describe('dendrite.beforeDerive', () => {
  it('sees the spec as it will be registered and can refuse a spawn with its reason; nothing is created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
    const seen: AgentSpec[] = [];
    try {
      const fw = await boot(dir, {
        beforeDerive: (spec: AgentSpec) => {
          seen.push(spec);
          return (spec.metadata as { budget?: string } | undefined)?.budget === 'none' ? { refuse: 'no budget this hour' } : undefined;
        },
      });
      const ok = await fw.createEphemeralAgent({ name: 'w-1', model: 'test-model', systemPrompt: 'x' }, { ...workerSpec('w-1', { spawnedBy: 'scout' }), name: undefined } as never);
      ok.cleanup();
      await assert.rejects(
        fw.createEphemeralAgent({ name: 'w-2', model: 'test-model', systemPrompt: 'x' }, { ...workerSpec('w-2', { spawnedBy: 'scout', metadata: { budget: 'none' } }), name: undefined } as never),
        /w-2 was not created: no budget this hour/,
      );
      assert.deepEqual(seen.map((s) => [s.name, s.kind, s.spawnedBy]), [['w-1', 'worker', 'scout'], ['w-2', 'worker', 'scout']]);
      assert.equal(fw.getAgentRecord('w-2'), null, 'nothing registered');
      await fw.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a spawn with no spec is shown the default worker spec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
    const seen: AgentSpec[] = [];
    try {
      const fw = await boot(dir, { beforeDerive: (spec: AgentSpec) => { seen.push(spec); } });
      const made = await fw.createEphemeralAgent({ name: 'bare', model: 'test-model', systemPrompt: 'x' });
      made.cleanup();
      assert.equal(seen[0]?.kind, 'worker');
      assert.equal(seen[0]?.name, 'bare');
      await fw.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is asked before an ended job resumes as a new incarnation, and can refuse it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
    const seen: AgentSpec[] = [];
    try {
      const membrane = new RoutedMembrane();
      const fw = await boot(dir, {
        beforeDerive: (spec: AgentSpec) => {
          seen.push(spec);
          return spec.model === 'other-model' ? { refuse: 'not on those weights' } : undefined;
        },
      }, membrane);
      membrane.script('job-h', say('job-h done'));
      const made = await fw.createEphemeralAgent({ name: 'job-h', model: 'test-model', systemPrompt: 'x' }, { ...workerSpec('job-h', { spawnedBy: 'scout' }), name: undefined } as never);
      made.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      await fw.runEphemeralToCompletion(made.agent, made.contextManager);
      await assert.rejects(fw.resumeAgent('job-h', { model: 'other-model', systemPrompt: 'x' }), /job-h was not resumed: not on those weights/);
      assert.equal(fw.getAgentRecord('job-h')?.incarnation, 1, 'still its first incarnation');
      assert.deepEqual(seen.map((s) => [s.name, s.model]), [['job-h', 'test-model'], ['job-h', 'other-model']]);
      await fw.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a derivation too, before the fork exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
    try {
      const fw = await boot(dir, { beforeDerive: (spec: AgentSpec) => (spec.kind === 'task-fork' ? { refuse: 'no forks of scout today' } : undefined) });
      await assert.rejects(fw.deriveAgent({ name: 'f-1', from: 'scout', mode: 'copy' }), /f-1 was not created: no forks of scout today/);
      assert.equal(fw.getAgentRecord('f-1'), null);
      await fw.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('dendrite.derivationNotice', () => {
  const lines = (fw: AgentFramework) => (fw.getAgent('scout')!.getContextManager().getAllMessages() as unknown as Array<{ content: Array<{ text?: string }>; metadata?: { kind?: string } }>)
    .filter((m) => m.metadata?.kind === 'agent-lifecycle').map((m) => m.content.map((b) => b.text ?? '').join(''));

  it('null tells the source nothing; the trace is still emitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
    try {
      const membrane = new RoutedMembrane();
      const fw = await boot(dir, { derivationNotice: () => null }, membrane);
      const traces: string[] = [];
      fw.onTrace((e) => { if (e.type === 'dendrite:agent-created') traces.push((e as { agentName: string }).agentName); });
      membrane.script('quiet-1', say('quiet-1 done'));
      const f = await fw.deriveAgent({ name: 'quiet-1', from: 'scout', mode: 'copy' });
      await fw.runEphemeralToCompletion(f.agent, f.contextManager);
      assert.ok(traces.includes('quiet-1'));
      assert.equal(lines(fw).length, 0);
      await fw.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("text replaces the framework's line; absent, the source is told nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
    try {
      const membrane = new RoutedMembrane();
      const custom = await boot(dir, { derivationNotice: (record: AgentRecord, from: string, def: string) => `[${from}: ${record.name} exists; the default would have said ${def.length} characters]` }, membrane);
      membrane.script('own-1', say('own-1 done'));
      const f = await custom.deriveAgent({ name: 'own-1', from: 'scout', mode: 'copy' });
      await custom.runEphemeralToCompletion(f.agent, f.contextManager);
      assert.match(lines(custom)[0] ?? '', /^\[scout: own-1 exists; the default would have said \d+ characters\]$/);
      await custom.stop();
      const plain = await boot(dir, {}, membrane);
      const traces: string[] = [];
      plain.onTrace((e) => { if (e.type === 'dendrite:agent-created') traces.push((e as { agentName: string }).agentName); });
      membrane.script('plain-1', say('plain-1 done'));
      const g = await plain.deriveAgent({ name: 'plain-1', from: 'scout', mode: 'copy' });
      await plain.runEphemeralToCompletion(g.agent, g.contextManager);
      assert.ok(traces.includes('plain-1'), 'the trace is emitted either way');
      assert.deepEqual(lines(plain).filter((l) => l.includes('plain-1')), []);
      await plain.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
