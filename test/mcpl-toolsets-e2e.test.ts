/**
 * MCPL RFC-014 host side, end to end: a real framework against mcpl-core's
 * reference ToolsetServer over WebSocket.
 *
 *  - static tools stay in the API tool list; dynamic tools never enter it;
 *  - the four meta-tools (toolsets--open/act/look/close) are there, constant;
 *  - an open announces the toolset's tools; act calls carry the instance and
 *    report what the call changed; close reports what closing meant;
 *  - an instance the server kept is adopted after a reconnect (vector 9).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolsetServerSpec, InstanceContext } from '@animalabs/mcpl-core/toolsets';

import { serveToolsetServer, makeFramework, waitFor, callTool, resultText, windowText } from './helpers/toolset-servers.js';

const txt = (text: string) => ({ type: 'text' as const, text });

/** Two toolsets: `game` (instances, options) and `build` (one, no instances). */
function arcadeSpec(log: string[]): ToolsetServerSpec {
  const games = new Map<string, InstanceContext>();
  return {
    name: 'arcade',
    version: '1.0.0',
    idleCloseMs: 0,
    staticTools: [{
      tool: { name: 'scores', description: 'Show the high scores. Always available.', inputSchema: { type: 'object', properties: {} } },
      call: () => ({ content: [txt('no scores yet')] }),
    }],
    toolsets: {
      game: {
        title: 'Game', summary: 'A board game against the bot', default: 'closed', instances: true,
        options: { type: 'object', properties: { size: { enum: [9, 13] } } },
        tools: [
          { name: 'play', description: 'Play a point on the board. Points are like D4.', inputSchema: { type: 'object', properties: { point: { type: 'string' } }, required: ['point'], additionalProperties: false } },
          { name: 'resign', description: 'Resign the game.', inputSchema: { type: 'object', properties: {} } },
        ],
        open(ctx, options) {
          games.set(ctx.instance!, ctx);
          let moves = 0;
          return {
            title: `Game ${ctx.instance} (${String(options.size ?? 9)})`,
            visible: () => (moves >= 2 ? ['resign'] : ['play', 'resign']),
            content: () => [txt(`board of ${ctx.instance}: ${moves} moves`)],
            async call(tool, args) {
              log.push(`${ctx.instance}:${tool}:${JSON.stringify(args)}`);
              if (tool === 'play') moves++;
              if (tool === 'resign') ctx.close('resigned');
              return { content: [txt(`${tool} ok`)] };
            },
            close: (reason) => `left ${ctx.instance}: ${reason}`,
          };
        },
      },
      build: {
        title: 'Building', summary: 'Place blocks', default: 'closed',
        tools: [{ name: 'place', description: 'Place a block.', inputSchema: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] } }],
        open: () => ({ title: 'Building', visible: () => ['place'], call: async () => ({ content: [txt('placed')] }), close: () => undefined }),
      },
    },
  };
}

describe('RFC-014 host, end to end against the reference ToolsetServer', () => {
  const calls: string[] = [];
  let srv: Awaited<ReturnType<typeof serveToolsetServer>>;
  let fw: Awaited<ReturnType<typeof makeFramework>>;

  before(async () => {
    srv = await serveToolsetServer(arcadeSpec(calls));
    fw = await makeFramework([{ id: 'arcade', toolPrefix: 'arcade', url: srv.url, toolHints: true, reconnect: true, reconnectIntervalMs: 100 }]);
    await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arcade--scores'), 'static tools listed');
  });
  after(async () => {
    await fw?.stop();
    await srv?.close();
  });

  it('lists static tools and the meta-tools, never a dynamic tool', () => {
    const names = fw.framework.getAllTools().map((t) => t.name);
    assert.ok(names.includes('arcade--scores'));
    for (const meta of ['toolsets--open', 'toolsets--act', 'toolsets--look', 'toolsets--close']) assert.ok(names.includes(meta), meta);
    for (const dyn of ['arcade--play', 'arcade--resign', 'arcade--place']) assert.ok(!names.includes(dyn), `${dyn} stays out of the tool list`);
  });

  it('opens a named instance, announces its tools, and act carries the instance (vectors 5, 6 host side)', async () => {
    const before = fw.framework.getAllTools().map((t) => t.name).join(',');
    const opened = await callTool(fw.framework, 'toolsets--open', { server: 'arcade', toolset: 'game', instance: 'g1', options: { size: 13 } });
    const text = resultText(opened);
    assert.ok(!opened.isError, text);
    assert.match(text, /\[arcade\/game:g1\] Game g1 \(13\)/);
    assert.match(text, /play\(point: string\) — Play a point on the board\./);
    assert.match(text, /toolsets--close \{server:"arcade", toolset:"game", instance:"g1"\} closes it\./);
    assert.equal(fw.framework.getAllTools().map((t) => t.name).join(','), before, 'the API tool list did not change');

    await callTool(fw.framework, 'toolsets--open', { toolset: 'game', instance: 'g2' });
    // Two open: act without instance fails, naming them; nothing is sent.
    const ambiguous = await callTool(fw.framework, 'toolsets--act', { tool: 'play', args: { point: 'D4' } });
    assert.ok(ambiguous.isError);
    assert.match(resultText(ambiguous), /several game instances are open \(g1, g2\)/);
    const played = await callTool(fw.framework, 'toolsets--act', { tool: 'play', instance: 'g1', args: { point: 'D4' } });
    assert.ok(!played.isError, resultText(played));
    assert.deepEqual(calls, ['g1:play:{"point":"D4"}']);
  });

  it('checks arguments against the current definition before sending', async () => {
    const bad = await callTool(fw.framework, 'toolsets--act', { tool: 'play', instance: 'g1', args: { point: 4 } });
    assert.ok(bad.isError);
    assert.match(resultText(bad), /Invalid arguments for play in \[arcade\/game:g1\]: args\.point: must be string\. Nothing was sent/);
    assert.equal(calls.length, 1, 'nothing reached the server');
  });

  it('a call that hides a tool reports it; a host\'s own call, whose result the agent may not see, as a notice', async () => {
    const second = await callTool(fw.framework, 'toolsets--act', { tool: 'play', instance: 'g1', args: { point: 'E5' } });
    assert.match(resultText(second), /play ok/);
    await waitFor(() => windowText(fw.framework).some((t) => t.includes('tool changes') && t.includes('now unavailable: play')), 'the change told');
  });

  it('a dynamic tool called by a namespaced name is refused, pointing at act', async () => {
    const refused = await fw.framework.executeToolCall({ id: 'x1', name: 'arcade--play', input: { point: 'A1' } } as never);
    assert.ok(refused.isError);
    assert.match(String(refused.error), /dynamic tool of arcade, called with toolsets--act/);
  });

  it('look restates what is open and what can be opened', async () => {
    const look = resultText(await callTool(fw.framework, 'toolsets--look', {}));
    assert.match(look, /\[arcade\/game:g1\]/);
    assert.match(look, /\[arcade\/game:g2\]/);
    assert.match(look, /build — Building: Place blocks/);
    const tool = resultText(await callTool(fw.framework, 'toolsets--look', { server: 'arcade', tool: 'play', instance: 'g2' }));
    assert.match(tool, /"point"/);
  });

  it('a call that ends its instance reports the close (no separate push)', async () => {
    const r = await callTool(fw.framework, 'toolsets--act', { tool: 'resign', instance: 'g2', args: {} });
    assert.ok(!r.isError, resultText(r));
    await waitFor(() => windowText(fw.framework).some((t) => t.includes('[arcade/game:g2] closed')), 'the close told');
    const look = resultText(await callTool(fw.framework, 'toolsets--look', { server: 'arcade' }));
    assert.doesNotMatch(look, /\[arcade\/game:g2\][^\n]*tools now/, 'g2 is no longer open');
    // RFC §5.3: an end the host didn't ask for is in `ended`; told once.
    assert.match(look, /\[arcade\/game:g2\] ended: resigned\./);
    const again = resultText(await callTool(fw.framework, 'toolsets--look', { server: 'arcade' }));
    assert.doesNotMatch(again, /ended: resigned/, 'each ended id is told once');
  });

  it('after a reconnect, an instance the server kept is adopted, not opened again (vector 9)', async () => {
    const opens = () => srv.received.filter((m) => m === 'toolsets/open').length;
    const lists = () => srv.received.filter((m) => m === 'toolsets/list').length;
    const opensBefore = opens();
    const listsBefore = lists();
    srv.dropAll();
    await waitFor(() => (fw.framework.listMcplServers().find((s) => s.id === 'arcade')?.connected ?? false) === false, 'the drop seen', 5000).catch(() => {});
    await waitFor(() => fw.framework.listMcplServers().find((s) => s.id === 'arcade')?.connected === true, 'reconnected');
    // Its toolsets/list is read after the policy settles.
    await waitFor(() => lists() > listsBefore, 'toolsets/list after the reconnect');
    await new Promise((r) => setTimeout(r, 200));
    const look = resultText(await callTool(fw.framework, 'toolsets--look', { server: 'arcade' }));
    assert.match(look, /\[arcade\/game:g1\]/, 'g1 adopted');
    assert.equal(opens(), opensBefore, 'no toolsets/open was sent across the reconnect');
    const act = await callTool(fw.framework, 'toolsets--act', { tool: 'resign', instance: 'g1', args: {} });
    assert.ok(!act.isError, resultText(act));
  });

  it('close reports what closing meant; a host\'s own close, whose result the agent may not see, is told as a notice too', async () => {
    await callTool(fw.framework, 'toolsets--open', { server: 'arcade', toolset: 'build' });
    const closed = await callTool(fw.framework, 'toolsets--close', { server: 'arcade', toolset: 'build' });
    assert.match(resultText(closed), /\[arcade\/build\] closed/);
    await waitFor(() => windowText(fw.framework).some((t) => t.includes('tool changes') && t.includes('[arcade/build] closed')), 'the close told');
  });
});

describe('RFC-014 against the reference ToolsetServer, toolHints off (vectors 26, 36)', () => {
  const calls: string[] = [];
  let srv: Awaited<ReturnType<typeof serveToolsetServer>>;
  let fw: Awaited<ReturnType<typeof makeFramework>>;

  before(async () => {
    srv = await serveToolsetServer(arcadeSpec(calls), 'agent:plain');
    fw = await makeFramework([{ id: 'arcade', toolPrefix: 'arcade', url: srv.url }]);
    await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arcade--scores'), 'tools listed');
  });
  after(async () => {
    await fw?.stop();
    await srv?.close();
  });

  it('every tool is static there, with the server\'s compat tools, and no meta-tools (36)', () => {
    const names = fw.framework.getAllTools().map((t) => t.name);
    for (const n of ['scores', 'play', 'resign', 'place', 'toolset_open', 'toolset_close', 'toolset_use']) assert.ok(names.includes(`arcade--${n}`), n);
    assert.ok(!names.some((n) => n.startsWith('toolsets--')));
  });

  it('two instances: a call without a choice fails naming them; after choosing, each plays (26)', async () => {
    const call = (name: string, input: Record<string, unknown>) => fw.framework.executeToolCall({ id: `c-${name}-${Math.random()}`, name: `arcade--${name}`, input } as never);
    await call('toolset_open', { toolset: 'game', instance: 'p1' });
    await call('toolset_open', { toolset: 'game', instance: 'p2' });
    // The connection's current instance is the one it last opened.
    await call('toolset_use', { toolset: 'game', instance: 'p1' });
    const first = await call('play', { point: 'D4' });
    assert.ok(!first.isError, String(first.error));
    await call('toolset_use', { toolset: 'game', instance: 'p2' });
    await call('play', { point: 'E5' });
    assert.deepEqual(calls, ['p1:play:{"point":"D4"}', 'p2:play:{"point":"E5"}']);
    // A second connection of the principal has no current instance: it must choose.
    const other = await makeFramework([{ id: 'arcade', toolPrefix: 'arcade', url: srv.url }]);
    try {
      await waitFor(() => other.framework.getAllTools().some((t) => t.name === 'arcade--play'), 'listed');
      const blind = await other.framework.executeToolCall({ id: 'blind', name: 'arcade--play', input: { point: 'F6' } } as never);
      assert.ok(blind.isError);
      assert.match(String(blind.error), /Several game instances are open \(p1, p2\)/);
    } finally { await other.stop(); }
  });
});
