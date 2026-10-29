import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Module, ToolCall, ToolResult, EventResponse, ToolDefinition } from '../src/types/index.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { startScriptedServer, makeFramework, waitFor, callTool, resultText, windowText, type Json } from './helpers/toolset-servers.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import type { FrameworkConfig } from '../src/types/framework.js';

const ADVERT: Json = {
  toolHints: true,
  featureSets: { 'arc.tools': { description: 'tools', uses: ['tools'] } },
};
const STATUS: Json = { name: 'status', description: 'Status of the arcade.', inputSchema: { type: 'object', properties: {} } };

test('the toolsets module is registered at creation, so a hinted server\'s connect adds no module', async () => {
  const server = await startScriptedServer({ advert: ADVERT, tools: [STATUS] });
  const fw = await makeFramework([]);
  try {
    assert.ok(fw.framework.getAllTools().some((t) => t.name === 'toolsets--open'), 'the meta-tools before any server');
    const toolsets = fw.framework.getModule('toolsets');
    assert.ok(toolsets, 'the toolsets module, from creation');
    let added = 0;
    const addModule = fw.framework.addModule.bind(fw.framework);
    fw.framework.addModule = async (module) => { added += 1; return addModule(module); };
    await fw.framework.connectMcplServer({ id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true });
    assert.equal(fw.framework.getModule('toolsets'), toolsets, 'the same module after the connect');
    assert.equal(added, 0, 'no module was added by the connect');
    assert.equal(server.peers.length, 1, 'the server was dialed');
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

async function connectedTo(server: Awaited<ReturnType<typeof startScriptedServer>>, options: Partial<FrameworkConfig> = {}, config: Partial<McplServerConfig> = {}) {
  const fw = await makeFramework([{ id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true, ...config }], options);
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
  const content = found.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof (b as { text?: unknown })?.text === 'string' ? (b as { text: string }).text : JSON.stringify(b))).join('\n');
  return JSON.stringify(content);
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

test('a server without toolHints keeps 0.27.0\'s reading of a structured-only result: the puppet stores it as 0.27.0 did', async () => {
  const server = await startScriptedServer({
    advert: { featureSets: ADVERT.featureSets },
    tools: [STATUS],
    on: (msg, peer) => {
      if (msg.method === 'tools/call') { peer.reply(msg.id, { content: [], structuredContent: { seen: ['a', 'b'] } }); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const fw = await makeFramework([{ id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: false } as McplServerConfig]);
  try {
    await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arc--status'), 'static tools listed');
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    assert.equal(storedResult(fw, toolUseId), '""', 'stored as 0.27.0 stored it');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a server without toolHints keeps 0.27.0\'s reading of a structured-only error: the puppet stores the error\'s text, not the content', async () => {
  const server = await startScriptedServer({
    advert: { featureSets: ADVERT.featureSets },
    tools: [STATUS],
    on: (msg, peer) => {
      if (msg.method === 'tools/call') { peer.reply(msg.id, { content: [], structuredContent: { reason: 'jammed' }, isError: true }); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const fw = await makeFramework([{ id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: false } as McplServerConfig]);
  try {
    await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arc--status'), 'static tools listed');
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    const text = storedResult(fw, toolUseId);
    assert.match(text, /without saying what went wrong/);
    assert.doesNotMatch(text, /jammed/);
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('the puppet stores a result that is structured content alone as that content\'s JSON, with the tool change', async () => {
  const { server } = await hintingServer({ content: [], structuredContent: { score: 42 } });
  const fw = await connectedTo(server);
  try {
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    const text = storedResult(fw, toolUseId);
    assert.match(text, /\\"score\\":42/);
    assert.match(text, /peek\(\)/);
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('the puppet stores a server\'s error that is structured content alone as that content\'s JSON, with the tool change', async () => {
  const { server } = await hintingServer({ content: [], structuredContent: { reason: 'jammed' }, isError: true });
  const fw = await connectedTo(server);
  try {
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    const text = storedResult(fw, toolUseId);
    assert.match(text, /\\"reason\\":\\"jammed\\"/);
    assert.match(text, /peek\(\)/);
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('the puppet stores a structured-only error\'s JSON when its tool change won\'t fit under the cap, and the change goes as a notice', async () => {
  const { server } = await hintingServer({ content: [], structuredContent: { s: 'x'.repeat(980) }, isError: true });
  const fw = await connectedTo(server, { toolResultInlineMaxChars: 1000 });
  try {
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    const text = storedResult(fw, toolUseId);
    assert.match(text, /x{980}/);
    assert.doesNotMatch(text, /peek\(\)/);
    await waitFor(() => notices(fw).some((x) => x.includes('peek()')), 'the change told as a notice');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('the puppet reads a server\'s error whose structured content is null as one that said nothing, with the tool change', async () => {
  const { server } = await hintingServer({ content: [], structuredContent: null, isError: true });
  const fw = await connectedTo(server);
  try {
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    const text = storedResult(fw, toolUseId);
    assert.match(text, /without saying what went wrong/);
    assert.match(text, /peek\(\)/, 'the result holds the tool change');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('the puppet stores a structured-only result as 0.27.0 did when its tool change won\'t fit under the cap, and the change goes as a notice', async () => {
  const { server } = await hintingServer({ content: [], structuredContent: { s: 'x'.repeat(980) } });
  const fw = await connectedTo(server, { toolResultInlineMaxChars: 1000 });
  try {
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    assert.equal(storedResult(fw, toolUseId), '""', 'stored as 0.27.0 stored it');
    await waitFor(() => notices(fw).some((x) => x.includes('peek()')), 'the change told as a notice');
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

test('a module that passes the model\'s call on to toolsets--act keeps its result whole under the agent\'s cap, and the change goes as a notice', async () => {
  const { server } = await hintingServer({ content: [{ type: 'text', text: 'x'.repeat(990) }] });
  class Relay implements Module {
    readonly name = 'relay';
    framework: { executeToolCall(call: never): Promise<ToolResult> } | null = null;
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    getTools(): ToolDefinition[] { return [{ name: 'peek_for_me', description: 'Peek, through act.', inputSchema: { type: 'object', properties: {} } } as ToolDefinition]; }
    // Passed on by id, as a call built afresh: no resultMaxChars.
    async handleToolCall(call: ToolCall): Promise<ToolResult> {
      return this.framework!.executeToolCall({ id: call.id, name: 'toolsets--act', input: { server: 'arc', tool: 'peek', args: {} }, callerAgentName: call.callerAgentName } as never);
    }
    async onProcess(event: { type: string }): Promise<EventResponse> {
      return event.type === 'external-message' ? { addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }], requestInference: true } : {};
    }
  }
  const relay = new Relay();
  const fw = await connectedTo(server, { toolResultInlineMaxChars: 1000, modules: [relay] });
  relay.framework = fw.framework as never;
  try {
    await modelCalls(fw, [{ type: 'tool_use', id: 'toolu_relay', name: 'relay--peek_for_me', input: {} }]);
    assert.equal(resultFor(fw, 'toolu_relay'), 'x'.repeat(990), 'the result whole, without the change');
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

const nestedPastStringify = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
// The host reads a structured-only result with JSON.stringify, which throws on
// this nesting where the runtime's stack runs out (Node 24) and writes it out
// where it doesn't (Node 26).
const stringifyOverflows = (() => {
  const nested: unknown = JSON.parse(nestedPastStringify);
  try { JSON.stringify(nested); return false; } catch { return true; }
})();

test('a model\'s call whose result the host can\'t read still tells the tool change it carried, as a notice', { skip: !stringifyOverflows && 'this runtime writes the nesting out, so the host reads the result' }, async () => {
  let rev = 0;
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

test('the puppet stores a server\'s error whose structured content the host can\'t write as 0.27.0 read it, with the tool change', { skip: !stringifyOverflows && 'this runtime writes the nesting out, so the host reads the content' }, async () => {
  let rev = 0;
  const server = await startScriptedServer({
    advert: { ...ADVERT, pushEvents: true, featureSets: { ...(ADVERT.featureSets as Json), ...EVENTS } },
    tools: [STATUS, PEEK],
    listRev: () => rev,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: ++rev, tools: [] } } }); return; }
      if (msg.method === 'tools/call') {
        const meta = JSON.stringify({ 'mcpl/hints': { rev: ++rev, tools: [{ name: 'peek', visible: true }] } });
        peer.ws.send(`{"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},"result":{"content":[],"structuredContent":${nestedPastStringify},"isError":true,"_meta":${meta}}}`);
        return;
      }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const fw = await connectedTo(server);
  try {
    const { toolUseId } = await fw.framework.puppetToolCall('scout', 'arc--status', {});
    const text = storedResult(fw, toolUseId);
    assert.match(text, /reported an error for arc--status without saying what went wrong/);
    assert.match(text, /peek\(\)/, 'the result holds the tool change');
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
    const line = logged.find((l) => l.includes('arc: a tool change was not told'))!;
    assert.match(line, /no agent/, 'says why');
    assert.match(line, /toolsets--look/, 'and names look');
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
    const status = withGrant.framework.getHostModeStatus();
    assert.equal(status.gatedRequests, 0, 'no inference requested');
    assert.equal(status.activeTurns, 0, 'no turn running');
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

test('a capability mask that names none of RFC-014\'s declarations leaves them alone: none is logged as masked, and hints still apply', async () => {
  const advert: Json = {
    ...ADVERT,
    toolsets: { build: { title: 'Building', summary: 'Blocks', default: 'closed' } },
    surface: { title: 'Arcade' },
  };
  const server = await startScriptedServer({
    advert,
    tools: [STATUS, PEEK],
    listRev: () => 0,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [] } } }); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let fw: Fw | undefined;
  try {
    fw = await connectedTo(server, {}, { enabledCapabilities: ['pushEvents'] });
    const masked = logged.filter((line) => line.includes('masked by host config'));
    assert.ok(!masked.some((line) => /toolHints|toolsets|surface/.test(line)), `nothing of RFC-014 masked: ${masked.join(' | ')}`);
    const names = fw.framework.getAllTools().map((t) => t.name);
    assert.ok(names.includes('arc--status'), 'the static tool is listed');
    assert.ok(!names.includes('arc--peek'), 'the dynamic tool is not: hints apply');
    assert.ok(names.includes('toolsets--look'), 'the meta-tools are offered');
  } finally {
    console.error = error;
    await fw?.stop();
    await server.close();
  }
});

test('a toolHints server removed while its reconnect is pending leaves no toolset state: a server added again under its id with hints off lists every tool', async () => {
  const first = await hintingServer({ content: [] });
  const fw = await connectedTo(first.server, {}, { reconnect: true, reconnectIntervalMs: 50 });
  const second = await startScriptedServer({ advert: { featureSets: ADVERT.featureSets }, tools: [STATUS, PEEK] });
  try {
    assert.ok(!fw.framework.getAllTools().some((t) => t.name === 'arc--peek'), 'a dynamic tool, while hints apply');
    await first.server.close();
    await waitFor(() => fw.framework.listMcplServers().some((s) => s.id === 'arc' && !s.connected), 'the connection lost, its reconnect pending');
    await fw.framework.disconnectMcplServer('arc');
    await fw.framework.connectMcplServer({ id: 'arc', toolPrefix: 'arc', url: second.url, toolHints: false });
    await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arc--status'), 'the new server\'s tools listed');
    assert.ok(fw.framework.getAllTools().some((t) => t.name === 'arc--peek'), 'peek is listed: no toolset state of the removed server hides it');
    assert.match(resultText(await callTool(fw.framework, 'toolsets--look', {})), /No MCPL server presents toolsets/);
  } finally {
    await fw.stop();
    await second.close();
  }
});

test('a toolHints server whose reconnect is pending, restarted with toolHints off, leaves no toolset state: every tool is listed', async () => {
  const first = await hintingServer({ content: [] });
  const fw = await connectedTo(first.server, {}, { reconnect: true, reconnectIntervalMs: 50 });
  const second = await startScriptedServer({ advert: { featureSets: ADVERT.featureSets }, tools: [STATUS, PEEK] });
  try {
    assert.ok(!fw.framework.getAllTools().some((t) => t.name === 'arc--peek'), 'a dynamic tool, while hints apply');
    await first.server.close();
    await waitFor(() => fw.framework.listMcplServers().some((s) => s.id === 'arc' && !s.connected), 'the connection lost, its reconnect pending');
    await fw.framework.restartMcplServer('arc', { id: 'arc', toolPrefix: 'arc', url: second.url, toolHints: false });
    await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arc--status'), 'the restarted server\'s tools listed');
    assert.ok(fw.framework.getAllTools().some((t) => t.name === 'arc--peek'), 'peek is listed: no toolset state from before the restart hides it');
    assert.match(resultText(await callTool(fw.framework, 'toolsets--look', {})), /No MCPL server presents toolsets/);
  } finally {
    await fw.stop();
    await second.close();
  }
});

test('a toolHints server whose reconnect is pending, restarted under another id, leaves no toolset state under the old one', async () => {
  const first = await hintingServer({ content: [] });
  const fw = await connectedTo(first.server, {}, { reconnect: true, reconnectIntervalMs: 50 });
  const second = await startScriptedServer({ advert: { featureSets: ADVERT.featureSets }, tools: [STATUS, PEEK] });
  const third = await startScriptedServer({ advert: { featureSets: ADVERT.featureSets }, tools: [STATUS, PEEK] });
  try {
    await first.server.close();
    await waitFor(() => fw.framework.listMcplServers().some((s) => s.id === 'arc' && !s.connected), 'the connection lost, its reconnect pending');
    await fw.framework.restartMcplServer('arc', { id: 'moved', toolPrefix: 'moved', url: second.url, toolHints: true });
    await fw.framework.connectMcplServer({ id: 'arc', toolPrefix: 'arc', url: third.url });
    await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arc--status'), 'the server added under the old id listed');
    assert.ok(fw.framework.getAllTools().some((t) => t.name === 'arc--peek'), 'peek is listed: no toolset state of the moved server hides it');
  } finally {
    await fw.stop();
    await second.close();
    await third.close();
  }
});

test('a server-chosen value the toolset host logs is redacted with the server\'s configuration and stays one field of one line', async () => {
  const token = 'sekret-token-4417';
  const { server, showPeek } = await hintingServer({ content: [] });
  const fw = await connectedTo(server, {}, { token });
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const eventId = `evt ${token}\nnext line`;
    const push = (hints: Json) => server.peer.request('push/event', {
      featureSet: 'arc.events', eventId, timestamp: new Date().toISOString(), payload: { content: [{ type: 'text', text: 'moved' }] }, hints,
    });
    await push(showPeek());
    await push(showPeek());
    await waitFor(() => logged.some((line) => line.includes('was read before')), 'the duplicate logged');
    const line = logged.find((l) => l.includes('was read before'))!;
    assert.ok(!line.includes(token), `no credential: ${line}`);
    assert.ok(!line.includes('\n'), `one line: ${JSON.stringify(line)}`);
    assert.match(line, /push "evt[^"]*next[^"]*line" was read before/, `one quoted field: ${line}`);
  } finally {
    console.error = error;
    await fw.stop();
    await server.close();
  }
});

test('a class rule naming a dynamic tool counts as matched; one naming no tool is still reported', async () => {
  const { server } = await hintingServer({ content: [] });
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let fw: Fw | undefined;
  try {
    fw = await connectedTo(server, { toolClassOverrides: { 'arc--peek': ['computer'], 'arc--nosuch': ['computer'] } });
    await waitFor(() => logged.some((line) => line.includes('arc--nosuch')), 'the unmatched pattern reported');
    assert.ok(!logged.some((line) => line.includes('arc--peek')), `the dynamic tool's pattern isn't reported: ${logged.filter((l) => l.includes('peek')).join(' | ')}`);
  } finally {
    console.error = error;
    await fw?.stop();
    await server.close();
  }
});

test('a programmatic toolsets--act that is refused is traced as a failed tool call', async () => {
  const { server } = await hintingServer({ content: [] });
  const fw = await connectedTo(server);
  const traces: Array<Record<string, unknown>> = [];
  fw.framework.onTrace((event) => traces.push(event as unknown as Record<string, unknown>));
  try {
    const r = await callTool(fw.framework, 'toolsets--act', { server: 'arc', tool: 'nosuch' });
    assert.ok(r.isError);
    const failed = traces.filter((t) => t.type === 'tool:failed' && t.tool === 'toolsets--act');
    assert.equal(failed.length, 1, 'one tool:failed trace for the act');
    assert.match(String(failed[0]!.error), /arc has no tool "nosuch"/);
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a refused act\'s trace carries the server\'s text redacted, from a caller in process and from the model', async () => {
  const token = 'sekret-token-4417';
  const pick: Json = { name: 'pick', description: 'Pick one.', inputSchema: { type: 'object', properties: { x: { enum: [token, 'b'] } }, required: ['x'] }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true } };
  const server = await startScriptedServer({
    advert: ADVERT,
    tools: [STATUS, pick],
    listRev: () => 1,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [{ name: 'pick', visible: true }] } } }); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const fw = await connectedTo(server, {}, { token });
  const traces: Array<Record<string, unknown>> = [];
  fw.framework.onTrace((event) => traces.push(event as unknown as Record<string, unknown>));
  try {
    const r = await callTool(fw.framework, 'toolsets--act', { server: 'arc', tool: 'pick', args: { x: 'c' } });
    assert.match(resultText(r), /must be one of/);
    await modelCalls(fw, [{ type: 'tool_use', id: 'toolu_pick', name: 'toolsets--act', input: { server: 'arc', tool: 'pick', args: { x: 'c' } } }]);
    const failed = traces.filter((t) => t.type === 'tool:failed' && t.tool === 'toolsets--act').map((t) => String(t.error));
    assert.equal(failed.length, 2, 'both refusals traced');
    for (const error of failed) {
      assert.match(error, /must be one of/);
      assert.ok(!error.includes(token), `no credential: ${error}`);
    }
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a model\'s call of a dynamic tool by its listed name, and a model\'s act that can\'t resolve, are each refused, and nothing is sent', async () => {
  const { server, showPeek } = await hintingServer({ content: [{ type: 'text', text: 'ran' }] });
  const fw = await connectedTo(server);
  try {
    server.peer.notify('tools/hints', showPeek());
    await waitFor(() => !fw.framework.getAllTools().some((t) => t.name === 'arc--peek'), 'peek is dynamic');
    await modelCalls(fw, [
      { type: 'tool_use', id: 'toolu_named', name: 'arc--peek', input: {} },
      { type: 'tool_use', id: 'toolu_unresolved', name: 'toolsets--act', input: { server: 'arc', tool: 'nosuch', args: {} } },
    ]);
    assert.match(resultFor(fw, 'toolu_named'), /There's no tool "arc--peek" in your tool list, so nothing ran: peek is a dynamic tool of arc, called with toolsets--act/);
    assert.match(resultFor(fw, 'toolu_unresolved'), /arc has no tool "nosuch"/);
    assert.ok(!server.received.some((m) => m.method === 'tools/call'), 'nothing sent');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('act\'s results arrive as a direct call\'s do: structured content to a script, and a server\'s error to the model', async () => {
  let rev = 0;
  const server = await startScriptedServer({
    advert: { ...ADVERT, featureSets: { ...(ADVERT.featureSets as Json), ...EVENTS } },
    tools: [STATUS, { ...PEEK, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true } }],
    listRev: () => rev,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: ++rev, tools: [{ name: 'peek', visible: true }] } } }); return; }
      if (msg.method === 'tools/call') {
        const failing = (msg.params as Json).arguments && ((msg.params as Json).arguments as Json).fail === true;
        peer.reply(msg.id, failing
          ? { content: [{ type: 'text', text: 'the board is locked' }], isError: true }
          : { content: [{ type: 'text', text: 'peeked' }, { type: 'text', text: 'twice' }], structuredContent: { seen: ['a', 'b'] } });
        return;
      }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const fw = await connectedTo(server, { codeExecution: { enabled: true } });
  try {
    const code = 'const a = await tools["toolsets--act"]({ server: "arc", tool: "peek", args: {} }); const d = await tools["arc--status"]({}); text(JSON.stringify([a.content, a.structuredContent, d.content, d.structuredContent]));';
    await modelCalls(fw, [
      { type: 'tool_use', id: 'toolu_script', name: 'code_execution', input: { code } },
      { type: 'tool_use', id: 'toolu_error', name: 'toolsets--act', input: { server: 'arc', tool: 'peek', args: { fail: true } } },
    ]);
    const printed = resultFor(fw, 'toolu_script');
    const [actContent, actStructured, directContent, directStructured] = JSON.parse(printed.slice(printed.indexOf('[['), printed.lastIndexOf(']') + 1)) as unknown[];
    assert.deepEqual(actStructured, { seen: ['a', 'b'] });
    assert.deepEqual([actContent, actStructured], [directContent, directStructured], 'as the static tool\'s direct call reads the same answer');
    assert.equal((actContent as unknown[]).length, 2, 'each of the server\'s blocks');
    assert.match(resultFor(fw, 'toolu_error'), /the board is locked/);
    const results = (fw.membrane.lastStream?.receivedToolResults ?? []).flat() as Array<{ toolUseId: string; isError?: boolean }>;
    assert.equal(results.find((r) => r.toolUseId === 'toolu_error')?.isError, true, 'an error result');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a dynamic tool keeps its own feature set: through act, each call is sent its own set\'s state', async () => {
  let n = 0;
  const calls: Json[] = [];
  const server = await startScriptedServer({
    advert: {
      ...ADVERT,
      featureSets: {
        'arc.tools': { description: 'tools', uses: ['tools'], hostState: true },
        'arc.games': { description: 'games', uses: ['tools'], hostState: true },
      },
    },
    tools: [
      { ...STATUS, _meta: { featureSet: 'arc.tools' } },
      { ...PEEK, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true, featureSet: 'arc.games' } },
    ],
    listRev: () => 0,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [{ name: 'peek', visible: true }] } } }); return; }
      if (msg.method === 'tools/call') {
        n++;
        calls.push(msg.params as Json);
        peer.reply(msg.id, { content: [{ type: 'text', text: 'ok' }], state: { checkpoint: `c${n}`, parent: null, data: { n } } });
        return;
      }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const fw = await connectedTo(server);
  try {
    const use = (id: string, name: string, input: Json) => createMockResponse([{ type: 'tool_use', id, name, input }] as never, 'tool_use');
    fw.membrane.pushResponse(use('toolu_s1', 'arc--status', {}));
    fw.membrane.pushResponse(use('toolu_p1', 'toolsets--act', { server: 'arc', tool: 'peek', args: {} }));
    fw.membrane.pushResponse(use('toolu_p2', 'toolsets--act', { server: 'arc', tool: 'peek', args: {} }));
    fw.membrane.pushResponse(use('toolu_s2', 'arc--status', {}));
    fw.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'turn over' }]));
    fw.framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: 'go' }], metadata: {}, triggerInference: true } as never);
    await waitFor(() => calls.length === 4, 'four calls, one after another');
    assert.deepEqual(calls.map((c) => `${String(c.name)}:${JSON.stringify(c.state ?? null)}`),
      ['status:null', 'peek:null', 'peek:{"n":2}', 'status:{"n":1}']);
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a classed dynamic tool called through act is observed with its class and, where the operator grants inputs, its arguments', async () => {
  const classed = { ...PEEK, inputSchema: { type: 'object', properties: { x: { type: 'integer' } } }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true, 'mcpl/class': ['computer'] } };
  const server = await startScriptedServer({
    advert: ADVERT,
    tools: [STATUS, classed],
    listRev: () => 0,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [{ name: 'peek', visible: true }] } } }); return; }
      if (msg.method === 'tools/call') { peer.reply(msg.id, { content: [{ type: 'text', text: 'ran' }] }); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const lifecycle: Json[] = [];
  let observing = false;
  const observer = await startScriptedServer({
    advert: { toolLifecycle: { observe: true, inputs: true }, featureSets: { 'obs.watch': { description: 'watch', uses: ['toolLifecycle.observe', 'toolLifecycle.inputs'] } } },
    tools: [],
    on: (msg, peer) => {
      if (msg.method === 'tools/lifecycle') { lifecycle.push(msg.params as Json); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const fw = await makeFramework([
    { id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true },
    { id: 'obs', toolPrefix: 'obs', url: observer.url, toolLifecycle: { observe: {}, inputs: { classes: ['computer'] } } },
  ] as McplServerConfig[]);
  try {
    await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arc--status'), 'static tools listed');
    for (let tries = 0; !observing && tries < 50; tries++) {
      const answer = await observer.peer.request('tools/observe', { rules: [{ match: {}, input: true }] });
      observing = !answer.error;
      if (!observing) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(observing, 'the observer filter applied');
    await modelCalls(fw, [{ type: 'tool_use', id: 'toolu_act', name: 'toolsets--act', input: { server: 'arc', tool: 'peek', args: { x: 3 } } }]);
    await waitFor(() => lifecycle.some((p) => p.phase === 'started'), 'the call observed');
    const started = lifecycle.find((p) => p.phase === 'started')!;
    assert.equal(started.tool, 'arc--peek');
    assert.deepEqual(started.class, ['computer']);
    assert.deepEqual(started.input, { x: 3 });
  } finally {
    await fw.stop();
    await server.close();
    await observer.close();
  }
});
