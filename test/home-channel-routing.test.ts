/**
 * Configured home channel for no-trigger turns (heartbeats, timers).
 *
 * Without `homeChannel`, a turn with no triggering channel resolves its speech
 * locus to `defaultPublishChannel` — the most-recent inbound across ALL
 * channels — so a heartbeat check-in lands wherever a message last happened to
 * arrive. With it, such turns speak in the configured channel, while a fork's
 * home or a real triggering channel still wins.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const HOME = 'discord:g1:home';
const BUSY = 'discord:g1:busy';
const TRIGGER = 'discord:g1:trigger';
const FORK_HOME = 'discord:g1:fork-home';

function makeRegistry(opts: {
  homeChannel?: string;
  homeChannelResolver?: (agentName: string) => string | undefined;
  activeChannelResolver?: (agentName: string) => string | undefined;
}) {
  const registry = new ChannelRegistry(
    { getServer: () => undefined } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    opts,
  );
  // The global most-recent-inbound locus: some unrelated channel was busy.
  (registry as unknown as { defaultPublishChannel: string | null }).defaultPublishChannel = BUSY;
  return registry;
}

describe('homeChannel: speech locus for no-trigger turns', () => {
  it('a no-trigger turn resolves to the configured home channel, not the last-active one', () => {
    const registry = makeRegistry({ homeChannel: HOME, activeChannelResolver: () => undefined });
    assert.equal(registry.resolveLocus('agent'), HOME);
  });

  it('without homeChannel the global most-recent-inbound fallback is unchanged', () => {
    const registry = makeRegistry({ activeChannelResolver: () => undefined });
    assert.equal(registry.resolveLocus('agent'), BUSY);
  });

  it('a triggering channel still wins over the home channel', () => {
    const registry = makeRegistry({ homeChannel: HOME, activeChannelResolver: () => TRIGGER });
    assert.equal(registry.resolveLocus('agent'), TRIGGER);
  });

  it("a conversation fork's home still wins over everything", () => {
    const registry = makeRegistry({
      homeChannel: HOME,
      homeChannelResolver: () => FORK_HOME,
      activeChannelResolver: () => TRIGGER,
    });
    assert.equal(registry.resolveLocus('agent'), FORK_HOME);
  });
});

describe('FrameworkConfig.homeChannel reaches the ChannelRegistry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'home-channel-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a heartbeat-style turn (no trigger) on a trunk agent resolves to homeChannel', async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
      homeChannel: HOME,
    });
    const internals = framework as unknown as {
      initializeMcpl(servers: unknown[], routing?: unknown): Promise<void>;
      channelRegistry: ChannelRegistry | null;
    };
    await internals.initializeMcpl([]);
    const registry = internals.channelRegistry!;
    (registry as unknown as { defaultPublishChannel: string | null }).defaultPublishChannel = BUSY;
    assert.equal(registry.resolveLocus('scout'), HOME);
    await framework.stop();
  });
});
