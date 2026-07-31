import { describe, it } from 'node:test';
import assert from 'node:assert';

import { AgentFramework } from '../src/framework.js';
import { CheckpointManager } from '../src/mcpl/checkpoint-manager.js';
import type {
  McpToolCallResult,
  McpToolDefinition,
  StateCheckpoint,
} from '../src/mcpl/types.js';

// Minimal in-memory JsStore covering the slots CheckpointManager touches.
function fakeStore(): any {
  const m = new Map<string, unknown>();
  return {
    registerState(_opts: { id: string; strategy: string }) {},
    getStateJson(id: string) { return m.has(id) ? m.get(id) : null; },
    setStateJson(id: string, v: unknown) { m.set(id, v); },
  };
}

type AttributedTool = McpToolDefinition & {
  featureSet?: string;
  _meta?: { featureSet?: string };
};

function tool(name: string, attribution?: { direct?: string; meta?: string }): AttributedTool {
  return {
    name,
    inputSchema: { type: 'object' },
    ...(attribution?.direct ? { featureSet: attribution.direct } : {}),
    ...(attribution?.meta ? { _meta: { featureSet: attribution.meta } } : {}),
  };
}

function makeFrameworkHarness(
  tools: AttributedTool[],
  resultFor: (name: string) => McpToolCallResult,
) {
  const checkpointManager = new CheckpointManager(fakeStore(), () => {});
  const calls: Array<{
    name: string;
    stateParams: { state?: unknown; checkpoint?: string } | undefined;
  }> = [];
  const server = {
    id: 'srv',
    async sendToolsList() { return { tools }; },
    async sendToolsCall(
      name: string,
      _args: Record<string, unknown>,
      stateParams?: { state?: unknown; checkpoint?: string },
    ) {
      calls.push({ name, stateParams });
      return resultFor(name);
    },
  };

  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplTools = [];
  framework.mcplToolFeatureSets = new Map();
  framework.mcplServerConfigs = new Map([['srv', { id: 'srv', toolPrefix: 'test' }]]);
  framework.mcplServerRegistry = {
    getAllServers: () => [server],
    getServer: (id: string) => id === 'srv' ? server : null,
  };
  framework.checkpointManager = checkpointManager;
  framework.channelRegistry = null;
  framework.emitTrace = () => {};

  async function callTool(name: string): Promise<void> {
    await framework.refreshMcplTools();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for ${name} result`)),
        1000,
      );
      framework.pushEvent = (event: { type: string; callId?: string }) => {
        if (event.type === 'tool-result' && event.callId === `call-${name}`) {
          clearTimeout(timeout);
          resolve();
        }
      };
      framework.dispatchMcplToolCall(
        'agent',
        { id: `call-${name}`, name: `test--${name}`, input: {} },
        'srv',
        'test',
      );
    });
  }

  return { checkpointManager, calls, callTool };
}

function checkpoint(checkpoint: string, featureSet?: string): StateCheckpoint {
  return { checkpoint, parent: null, ...(featureSet ? { featureSet } : {}) };
}

describe('CheckpointManager host-managed attribution', () => {
  it('threads the host-managed set even when server-managed sets register first', () => {
    const cm = new CheckpointManager(fakeStore(), () => {});
    const srv = 'xgate';
    cm.registerFeatureSet(srv, 'x.post', { hostState: false, rollback: true });
    cm.registerFeatureSet(srv, 'x.feed', { hostState: true, rollback: true });
    cm.registerFeatureSet(srv, 'x.dm', { hostState: false, rollback: true });

    assert.equal(cm.getStatefulFeatureSet(srv), null);
    assert.equal(cm.hasAmbiguousServerManagedFeatureSets(srv), true);
    assert.equal(cm.getStatefulFeatureSet(srv, 'x.post'), 'x.post');
    assert.equal(cm.getHostManagedFeatureSet(srv), 'x.feed');

    cm.recordCheckpoint(srv, 'x.feed', {
      checkpoint: '1', parent: null, featureSet: 'x.feed', data: { sources: ['alice'] },
    });
    assert.deepEqual(cm.getCurrentState(srv, 'x.feed'), { sources: ['alice'] });
    assert.equal(cm.getCurrentState(srv, 'x.post'), undefined);
  });

  it('keeps the unique server-managed fallback when there is no host-managed set', () => {
    const cm = new CheckpointManager(fakeStore(), () => {});
    cm.registerFeatureSet('s', 'x.post', { hostState: false, rollback: true });
    assert.equal(cm.getHostManagedFeatureSet('s'), null);
    assert.equal(cm.getStatefulFeatureSet('s'), 'x.post');
    assert.equal(cm.hasAmbiguousServerManagedFeatureSets('s'), false);
  });
});

describe('AgentFramework tool-call checkpoint attribution', () => {
  it('uses direct tool featureSet metadata for injection and untagged recording', async () => {
    const harness = makeFrameworkHarness(
      [tool('post', { direct: 'x.post' })],
      () => ({ content: [], state: checkpoint('post-2') }),
    );
    harness.checkpointManager.registerFeatureSet('srv', 'x.post', { hostState: false, rollback: true });
    harness.checkpointManager.registerFeatureSet('srv', 'x.dm', { hostState: false, rollback: true });
    harness.checkpointManager.recordCheckpoint('srv', 'x.post', checkpoint('post-1'));
    harness.checkpointManager.recordCheckpoint('srv', 'x.dm', checkpoint('dm-1'));

    await harness.callTool('post');

    assert.deepEqual(harness.calls[0]?.stateParams, { checkpoint: 'post-1' });
    assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.post'), 'post-2');
    assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.dm'), 'dm-1');
  });

  it('uses _meta.featureSet metadata the same way', async () => {
    const harness = makeFrameworkHarness(
      [tool('dm', { meta: 'x.dm' })],
      () => ({ content: [], state: checkpoint('dm-2') }),
    );
    harness.checkpointManager.registerFeatureSet('srv', 'x.post', { hostState: false, rollback: true });
    harness.checkpointManager.registerFeatureSet('srv', 'x.dm', { hostState: false, rollback: true });
    harness.checkpointManager.recordCheckpoint('srv', 'x.post', checkpoint('post-1'));
    harness.checkpointManager.recordCheckpoint('srv', 'x.dm', checkpoint('dm-1'));

    await harness.callTool('dm');

    assert.deepEqual(harness.calls[0]?.stateParams, { checkpoint: 'dm-1' });
    assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.post'), 'post-1');
    assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.dm'), 'dm-2');
  });

  it('keeps explicit result.state.featureSet authoritative over tool metadata', async () => {
    const harness = makeFrameworkHarness(
      [tool('post', { direct: 'x.post' })],
      () => ({ content: [], state: checkpoint('dm-2', 'x.dm') }),
    );
    harness.checkpointManager.registerFeatureSet('srv', 'x.post', { hostState: false, rollback: true });
    harness.checkpointManager.registerFeatureSet('srv', 'x.dm', { hostState: false, rollback: true });
    harness.checkpointManager.recordCheckpoint('srv', 'x.post', checkpoint('post-1'));
    harness.checkpointManager.recordCheckpoint('srv', 'x.dm', checkpoint('dm-1'));

    await harness.callTool('post');

    assert.deepEqual(harness.calls[0]?.stateParams, { checkpoint: 'post-1' });
    assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.post'), 'post-1');
    assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.dm'), 'dm-2');
  });

  it('does not fall back when explicit result attribution is not stateful', async () => {
    const harness = makeFrameworkHarness(
      [tool('post', { direct: 'x.post' })],
      () => ({ content: [], state: checkpoint('wrong-2', 'x.events') }),
    );
    harness.checkpointManager.registerFeatureSet('srv', 'x.post', { hostState: false, rollback: true });
    harness.checkpointManager.recordCheckpoint('srv', 'x.post', checkpoint('post-1'));

    await harness.callTool('post');

    assert.deepEqual(harness.calls[0]?.stateParams, { checkpoint: 'post-1' });
    assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.post'), 'post-1');
  });

  it('records explicit result attribution even when an untagged tool is ambiguous', async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const harness = makeFrameworkHarness(
        [tool('explicit')],
        () => ({ content: [], state: checkpoint('dm-2', 'x.dm') }),
      );
      harness.checkpointManager.registerFeatureSet('srv', 'x.post', { hostState: false, rollback: true });
      harness.checkpointManager.registerFeatureSet('srv', 'x.dm', { hostState: false, rollback: true });
      harness.checkpointManager.recordCheckpoint('srv', 'x.post', checkpoint('post-1'));
      harness.checkpointManager.recordCheckpoint('srv', 'x.dm', checkpoint('dm-1'));

      await harness.callTool('explicit');

      assert.equal(harness.calls[0]?.stateParams, undefined);
      assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.post'), 'post-1');
      assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.dm'), 'dm-2');
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('retains injection and recording for an untagged tool with one stateful set', async () => {
    const harness = makeFrameworkHarness(
      [tool('single')],
      () => ({ content: [], state: checkpoint('only-2') }),
    );
    harness.checkpointManager.registerFeatureSet('srv', 'x.only', { hostState: false, rollback: true });
    harness.checkpointManager.recordCheckpoint('srv', 'x.only', checkpoint('only-1'));

    await harness.callTool('single');

    assert.deepEqual(harness.calls[0]?.stateParams, { checkpoint: 'only-1' });
    assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.only'), 'only-2');
  });

  it('warns and skips untagged state exchange when server-managed sets are ambiguous', async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const harness = makeFrameworkHarness(
        [tool('ambiguous')],
        () => ({ content: [], state: checkpoint('wrong-2') }),
      );
      harness.checkpointManager.registerFeatureSet('srv', 'x.post', { hostState: false, rollback: true });
      harness.checkpointManager.registerFeatureSet('srv', 'x.dm', { hostState: false, rollback: true });
      harness.checkpointManager.recordCheckpoint('srv', 'x.post', checkpoint('post-1'));
      harness.checkpointManager.recordCheckpoint('srv', 'x.dm', checkpoint('dm-1'));

      await harness.callTool('ambiguous');

      assert.equal(harness.calls[0]?.stateParams, undefined);
      assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.post'), 'post-1');
      assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.dm'), 'dm-1');
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]?.[0]), /multiple server-managed/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('warns and skips state exchange for unknown or non-stateful tool tags', async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const harness = makeFrameworkHarness(
        [tool('unknown', { direct: 'x.missing' }), tool('stateless', { meta: 'x.events' })],
        () => ({ content: [], state: checkpoint('wrong-2') }),
      );
      harness.checkpointManager.registerFeatureSet('srv', 'x.post', { hostState: false, rollback: true });
      harness.checkpointManager.recordCheckpoint('srv', 'x.post', checkpoint('post-1'));

      await harness.callTool('unknown');
      await harness.callTool('stateless');

      assert.equal(harness.calls[0]?.stateParams, undefined);
      assert.equal(harness.calls[1]?.stateParams, undefined);
      assert.equal(harness.checkpointManager.getCurrentCheckpoint('srv', 'x.post'), 'post-1');
      assert.equal(warnings.length, 2);
      assert.match(String(warnings[0]?.[0]), /unknown or non-stateful/);
      assert.match(String(warnings[1]?.[0]), /unknown or non-stateful/);
    } finally {
      console.warn = originalWarn;
    }
  });
});
