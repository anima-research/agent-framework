import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

class ToolModule implements Module {
  readonly name = 'tools';
  calls: ToolCall[] = [];
  speeches: string[] = [];
  private ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext) { this.ctx = ctx; ctx.registerSpeechHandler('*'); }
  async stop() { this.ctx?.unregisterSpeechHandler(); this.ctx = null; }
  async onProcess() { return {}; }
  async onAgentSpeech(_agent: string, content: ContentBlock[]) {
    const text = content.filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n');
    if (text) this.speeches.push(text);
  }
  getTools(): ToolDefinition[] { return [{ name: 'ping', description: 'explicit action', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(call: ToolCall): Promise<ToolResult> { this.calls.push(call); return { success: true, data: { ok: true } }; }
}

function silentEvent() {
  return {
    type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat',
    eventId: `hb-${Math.random()}`, content: [], timestamp: new Date().toISOString(),
    origin: { source: 'heartbeat', reason: 'schedule', silent: true, scheduledAt: '2026-10-02 12:00:00 PT' },
    inferenceId: `inf-${Math.random()}`, triggerInference: true,
  };
}

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'silent-hb-af-'));
  const membrane = new MockMembrane();
  const mod = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', proseRouting: 'locus' }],
    modules: [mod],
  });
  const routed: string[] = [];
  const typing: string[] = [];
  (framework as any).channelRegistry = new Proxy({
    resolveLocus: () => 'world:commons', getDefaultPublishChannel: () => 'world:commons',
    routeSpeech: async (_a: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'world:commons' }; },
    startTyping: (channel: string) => { typing.push(channel); },
    stopTyping: () => {},
    getChannelTools: () => [], getDescriptor: () => undefined, publishTarget: () => 'root',
  }, { get: (t, p: string) => p in t ? (t as any)[p] : () => undefined });
  return { dir, membrane, mod, framework, routed, typing };
}

describe('silent heartbeat', () => {
  it('wakes once with ephemeral control context, stores no push message, and routes no prose', async () => {
    const x = await make();
    try {
      x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'private self-check prose' }] as ContentBlock[]));
      let pushRows = 0; let starts = 0;
      x.framework.onTrace((e: any) => { if (e.type === 'message:added' && e.source === 'mcpl:push-event') pushRows++; if (e.type === 'inference:started') starts++; });
      (x.framework as any).handleMcplPushEvent(silentEvent());
      await x.framework.runUntilIdle();
      assert.equal(starts, 1, 'exactly one inference');
      assert.equal(pushRows, 0, 'no durable push message');
      assert.deepEqual(x.routed, [], 'no automatic prose delivery');
      assert.deepEqual(x.mod.speeches, [], 'no module speech callback');
      assert.deepEqual(x.typing, [], 'no typing indicator');
      const wire = JSON.stringify(x.membrane.calls[0]);
      assert.match(wire, /silent heartbeat/);
      assert.match(wire, /Scheduled private self-check/);
      assert.doesNotMatch(wire, /private self-check prose/);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('keeps explicit tools available while suppressing adjacent prose', async () => {
    const x = await make();
    try {
      x.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'should remain private' },
        { type: 'tool_use', id: 't1', name: 'tools--ping', input: {} },
      ] as ContentBlock[], 'tool_use'));
      x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'also private' }] as ContentBlock[]));
      (x.framework as any).handleMcplPushEvent(silentEvent());
      await x.framework.runUntilIdle();
      assert.equal(x.mod.calls.length, 1, 'explicit tool executed once');
      assert.equal(x.mod.calls[0]?.name, 'ping');
      assert.deepEqual(x.routed, [], 'no adjacent or trailing prose delivered');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });


  it('does not silence a genuine request batched with the heartbeat', async () => {
    const x = await make();
    try {
      x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'reply to human' }] as ContentBlock[]));
      (x.framework as any).handleMcplPushEvent(silentEvent());
      (x.framework as any).pendingRequests.push({
        agentName: 'assistant', reason: 'channel-message', source: 'discord',
        timestamp: Date.now() + 1, channelId: 'discord:g:c', addressed: true,
      });
      await x.framework.runUntilIdle();
      assert.deepEqual(x.routed, ['reply to human'], 'ordinary addressed prose was delivered');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  // A spoofed marker is not a silent tick. With no content it is not a
  // message either: it would wake the agent to nothing it could see, so it
  // stores no row and wakes nobody (agent-framework#235 F2).
  for (const [label, spoof] of [
    ['a non-heartbeat feature set', (ev: { featureSet: string }) => { ev.featureSet = 'other'; }],
    ['another server', (ev: { serverId: string }) => { ev.serverId = 'other'; }],
  ] as const) {
    it(`drops an empty heartbeat-shaped marker from ${label}: no row, no wake, no prose`, async () => {
      const x = await make();
      try {
        x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'invented cause' }] as ContentBlock[]));
        let pushRows = 0; let starts = 0;
        x.framework.onTrace((e: any) => { if (e.type === 'message:added' && e.source === 'mcpl:push-event') pushRows++; if (e.type === 'inference:started') starts++; });
        const ev = silentEvent(); spoof(ev);
        (x.framework as any).handleMcplPushEvent(ev);
        await x.framework.runUntilIdle();
        assert.equal(pushRows, 0, 'no stored row for an empty spoofed marker');
        assert.equal(starts, 0, 'no uncaused wake');
        assert.deepEqual(x.routed, []);
      } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
    });

    it(`stores a marker-bearing push with content from ${label} as ordinary content`, async () => {
      const x = await make();
      try {
        x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ordinary output' }] as ContentBlock[]));
        let pushRows = 0;
        x.framework.onTrace((e: any) => { if (e.type === 'message:added' && e.source === 'mcpl:push-event') pushRows++; });
        const ev = { ...silentEvent(), content: [{ type: 'text', text: 'visible tick' }] }; spoof(ev);
        (x.framework as any).handleMcplPushEvent(ev);
        await x.framework.runUntilIdle();
        assert.equal(pushRows, 1, 'marker cannot hide content: stored as ordinary push content');
        assert.deepEqual(x.routed, ['ordinary output'], 'ordinary prose routing remained');
      } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
    });
  }

});
