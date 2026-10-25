import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Module } from '../src/types/index.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { startScriptedServer, makeFramework, waitFor, callTool, resultText, windowText, type Json } from './helpers/toolset-servers.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import type { FrameworkConfig } from '../src/types/framework.js';

const ADVERT: Json = {
  toolHints: true,
  featureSets: { 'arc.tools': { description: 'tools', uses: ['tools'] } },
};
const STATUS: Json = { name: 'status', description: 'Status of the arcade.', inputSchema: { type: 'object', properties: {} } };

async function heldAtModuleAdd() {
  const fw = await makeFramework([]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let adding = false;
  const addModule = fw.framework.addModule.bind(fw.framework);
  fw.framework.addModule = async (module: Module) => { adding = true; await held; return addModule(module); };
  return { fw, release, adding: () => adding };
}

test('a disconnect while a toolHints server is still connecting ends the connect before it dials the server', async () => {
  const server = await startScriptedServer({ advert: ADVERT, tools: [STATUS] });
  const { fw, release, adding } = await heldAtModuleAdd();
  try {
    const config: McplServerConfig = { id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true };
    const connect = fw.framework.connectMcplServer(config);
    connect.catch(() => undefined);
    await waitFor(adding, 'the toolsets module being added');
    const disconnect = fw.framework.disconnectMcplServer('arc');
    release();
    await assert.rejects(connect, /"arc" was not connected: it was disconnected while connecting/);
    await disconnect;
    assert.equal(server.peers.length, 0, 'nothing dialed the server');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a stop while a toolHints server is still connecting ends the connect, which says the framework stopped', async () => {
  const server = await startScriptedServer({ advert: ADVERT, tools: [STATUS] });
  const { fw, release, adding } = await heldAtModuleAdd();
  try {
    const config: McplServerConfig = { id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true };
    const connect = fw.framework.connectMcplServer(config);
    connect.catch(() => undefined);
    await waitFor(adding, 'the toolsets module being added');
    const stopped = fw.framework.stop();
    release();
    await assert.rejects(connect, /"arc" was not connected: the framework stopped while it was connecting/);
    await stopped;
    assert.equal(server.peers.length, 0, 'nothing dialed the server');
  } finally {
    await fw.stop();
    await server.close();
  }
});

const PEEK: Json = { name: 'peek', description: 'Peek around.', inputSchema: { type: 'object', properties: {} }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': false } };
const EVENTS: Json = { 'arc.events': { description: 'events', uses: ['pushEvents'] } };

async function hintingServer(answer: Json, { pushEvents = true, listing = (): boolean => true, peek = PEEK } = {}) {
  let rev = 0;
  let statement: Json[] = [];
  const showPeek = () => {
    statement = [{ name: 'peek', visible: true }];
    return { rev: ++rev, tools: statement };
  };
  const server = await startScriptedServer({
    advert: { ...ADVERT, pushEvents, featureSets: { ...(ADVERT.featureSets as Json), ...(pushEvents ? EVENTS : {}) } },
    tools: [STATUS, peek],
    listRev: () => rev,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list' && !listing()) { peer.error(msg.id, -32000, 'busy'); return; }
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: ++rev, tools: statement } } }); return; }
      if (msg.method === 'tools/call') { peer.reply(msg.id, { ...answer, _meta: { 'mcpl/hints': showPeek() } }); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  return { server, showPeek };
}

async function connectedTo(server: Awaited<ReturnType<typeof startScriptedServer>>, options: Partial<FrameworkConfig> = {}) {
  const fw = await makeFramework([{ id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true }], options);
  await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arc--status'), 'static tools listed');
  await waitFor(() => server.received.some((m) => m.method === 'toolsets/list'), 'toolsets/list after connecting');
  return fw;
}

type Fw = Awaited<ReturnType<typeof makeFramework>>;

async function modelCalls(fw: Fw, blocks: Json[]): Promise<void> {
  fw.membrane.pushResponse(createMockResponse(blocks as never, 'tool_use'));
  fw.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'turn over' }]));
  fw.framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: 'go' }], metadata: {}, triggerInference: true } as never);
  await waitFor(() => windowText(fw.framework).some((x) => x.includes('turn over')), 'the turn ended');
}

function resultFor(fw: Fw, toolUseId: string): string {
  const results = (fw.membrane.lastStream?.receivedToolResults ?? []).flat() as Array<{ toolUseId: string; content: unknown }>;
  const found = results.find((r) => r.toolUseId === toolUseId);
  assert.ok(found, `a result for ${toolUseId}`);
  return typeof found.content === 'string' ? found.content : JSON.stringify(found.content);
}

const notices = (fw: Fw) => windowText(fw.framework).filter((x) => x.includes('tool changes:'));
const nextMacrotask = () => new Promise((r) => setImmediate(r));

function storedResult(fw: Fw, toolUseId: string): string {
  const stored = fw.framework.getAgent('scout')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content as unknown as Array<Record<string, unknown>>)
    .find((b) => b.type === 'tool_result' && b.toolUseId === toolUseId);
  assert.ok(stored, 'the pair is stored');
  return JSON.stringify(stored.content);
}

test('a model\'s call whose result is structured content alone shows that content, then the tool change its hints made', async () => {
  const { server } = await hintingServer({ content: [], structuredContent: { score: 42 } });
  const fw = await connectedTo(server);
  try {
    await modelCalls(fw, [{ type: 'tool_use', id: 'toolu_status', name: 'arc--status', input: {} }]);
    const result = resultFor(fw, 'toolu_status');
    assert.match(result, /"score":42/);
    assert.match(result, /peek\(\)/);
    assert.ok(result.indexOf('"score":42') < result.indexOf('peek()'), 'the change after the content');
    assert.equal(notices(fw).length, 0, 'not told again as a notice');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a script\'s call whose result carries a tool change leaves the change to a notice: the script\'s result doesn\'t hold it', async () => {
  const { server } = await hintingServer({ content: [{ type: 'text', text: 'all quiet' }] });
  const fw = await connectedTo(server, { codeExecution: { enabled: true } });
  try {
    const code = 'const r = await tools["arc--status"]({}); text(JSON.stringify(r.content));';
    await modelCalls(fw, [{ type: 'tool_use', id: 'toolu_script', name: 'code_execution', input: { code } }]);
    const script = resultFor(fw, 'toolu_script');
    assert.match(script, /all quiet/);
    assert.doesNotMatch(script, /peek/, 'the script\'s result doesn\'t hold the change');
    await waitFor(() => notices(fw).some((x) => x.includes('peek()')), 'the change told as a notice');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('the operator\'s puppet call stores its result with the tool change its hints made, and the change isn\'t told again', async () => {
  const { server } = await hintingServer({ content: [{ type: 'text', text: 'all quiet' }] });
  const fw = await connectedTo(server);
  try {
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    const text = storedResult(fw, toolUseId);
    assert.match(text, /all quiet/);
    assert.match(text, /peek\(\)/);
    await nextMacrotask();
    assert.equal(notices(fw).length, 0, 'not told again as a notice');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('the puppet stores a result that is structured content alone as that content\'s JSON, then the tool change', async () => {
  const { server } = await hintingServer({ content: [], structuredContent: { score: 42 } });
  const fw = await connectedTo(server);
  try {
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    const text = storedResult(fw, toolUseId);
    assert.match(text, /\\"score\\":42/);
    assert.match(text, /peek\(\)/);
    assert.ok(text.indexOf('score') < text.indexOf('peek()'), 'the change after the content');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('the puppet\'s toolsets--act stores the dynamic tool\'s result with the tool change its call made, and the change isn\'t told again', async () => {
  const { server } = await hintingServer({ content: [{ type: 'text', text: 'peeked' }] });
  const fw = await connectedTo(server);
  try {
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'toolsets--act', { server: 'arc', tool: 'peek', args: {} });
    const text = storedResult(fw, toolUseId);
    assert.match(text, /peeked/);
    assert.match(text, /peek\(\)/);
    await nextMacrotask();
    assert.equal(notices(fw).length, 0, 'not told again as a notice');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a puppet call whose pair can\'t be stored tells the tool change its result carried, as a notice', async () => {
  const { server } = await hintingServer({ content: [{ type: 'text', text: 'all quiet' }] });
  const fw = await connectedTo(server);
  try {
    const cm = fw.framework.getAgent('scout')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    let refused = false;
    cm.addMessage = ((...args: Parameters<typeof add>) => {
      if (!refused) {
        refused = true;
        throw new Error('the store refused the write');
      }
      return add(...args);
    }) as typeof cm.addMessage;
    await assert.rejects(fw.framework.puppetToolCall('scout', 'arc--status', {}), /the store refused the write/);
    await waitFor(() => notices(fw).some((x) => x.includes('peek()')), 'the change told as a notice');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a model\'s call whose result, with its tool change after it, would pass the inline cap keeps its result whole and tells the change as a notice', async () => {
  const content = 'x'.repeat(990);
  const { server } = await hintingServer({ content: [{ type: 'text', text: content }] });
  const fw = await connectedTo(server, { toolResultInlineMaxChars: 1000 });
  try {
    await modelCalls(fw, [{ type: 'tool_use', id: 'toolu_long', name: 'arc--status', input: {} }]);
    assert.equal(resultFor(fw, 'toolu_long'), content, 'the result whole, without the change');
    await waitFor(() => notices(fw).some((x) => x.includes('peek()')), 'the change told as a notice');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a model\'s call whose tool change fits goes with its result even where a definition holds a lone surrogate', async () => {
  const { server } = await hintingServer({ content: [{ type: 'text', text: 'all quiet' }] }, { peek: { ...PEEK, description: 'Peek \uD800 around.' } });
  const fw = await connectedTo(server);
  try {
    await modelCalls(fw, [{ type: 'tool_use', id: 'toolu_odd', name: 'arc--status', input: {} }]);
    assert.match(resultFor(fw, 'toolu_odd'), /all quiet[\s\S]*peek\(\)/);
    await nextMacrotask();
    assert.equal(notices(fw).length, 0, 'not told as a notice');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a model\'s call whose result the host can\'t read still tells the tool change it carried, as a notice', async () => {
  let rev = 0;
  const nestedPastStringify = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
  const server = await startScriptedServer({
    advert: { ...ADVERT, pushEvents: true, featureSets: { ...(ADVERT.featureSets as Json), ...EVENTS } },
    tools: [STATUS, PEEK],
    listRev: () => rev,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: ++rev, tools: [] } } }); return; }
      if (msg.method === 'tools/call') {
        const meta = JSON.stringify({ 'mcpl/hints': { rev: ++rev, tools: [{ name: 'peek', visible: true }] } });
        peer.ws.send(`{"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},"result":{"content":[],"structuredContent":${nestedPastStringify},"_meta":${meta}}}`);
        return;
      }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const fw = await connectedTo(server);
  try {
    await modelCalls(fw, [{ type: 'tool_use', id: 'toolu_deep', name: 'arc--status', input: {} }]);
    assert.doesNotMatch(resultFor(fw, 'toolu_deep'), /peek/, 'the failed call\'s result doesn\'t hold it');
    await waitFor(() => notices(fw).some((x) => x.includes('peek()')), 'the change told as a notice');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a tool change the host can\'t tell for want of an agent is logged, as one it can\'t tell for want of pushEvents is', async () => {
  const { server, showPeek } = await hintingServer({ content: [] });
  const fw = await connectedTo(server, { agents: [] });
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    server.peer.notify('tools/hints', showPeek());
    await waitFor(() => logged.some((line) => line.includes('arc: a tool change was not told')), 'the drop logged');
    assert.ok(logged.some((line) => /arc: a tool change was not told \(no agent is registered to tell\); toolsets--look shows the state it left/.test(line)));
  } finally {
    console.error = error;
    await fw.stop();
    await server.close();
  }
});

test('a tool change with no result to ride on is a notice only where pushEvents is granted, and a notice starts no turn', async () => {
  const granted = await hintingServer({ content: [] });
  const withGrant = await connectedTo(granted.server);
  try {
    const requests = withGrant.membrane.calls.length;
    granted.server.peer.notify('tools/hints', granted.showPeek());
    await waitFor(() => notices(withGrant).some((x) => x.includes('peek()')), 'the notice written');
    const scheduler = withGrant.framework as unknown as { pendingRequests: unknown[] };
    assert.equal(scheduler.pendingRequests.length, 0, 'no inference requested');
    assert.equal(withGrant.framework.getAgent('scout')!.state.status, 'idle', 'no turn running');
    assert.equal(withGrant.membrane.calls.length, requests, 'no request sent: the notice started no turn');
  } finally {
    await withGrant.stop();
    await granted.server.close();
  }

  let listing = true;
  const refused = await hintingServer({ content: [] }, { pushEvents: false, listing: () => listing });
  const withoutGrant = await connectedTo(refused.server);
  try {
    listing = false;
    refused.server.peer.notify('tools/hints', refused.showPeek());
    const looked = resultText(await callTool(withoutGrant.framework, 'toolsets--look', { server: 'arc' }));
    assert.match(looked, /arc couldn't be asked just now/, 'look didn\'t re-read the server\'s state');
    assert.match(looked, /peek\(/, 'look shows the change the hint made');
    assert.equal(notices(withoutGrant).length, 0, 'nothing written to the conversation');
  } finally {
    await withoutGrant.stop();
    await refused.server.close();
  }
});
