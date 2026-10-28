/**
 * A reference that arrives in a push event, a render result, an incoming
 * channel message, a context injection or the result of an MCPL tool called
 * in process is registered with the server that sent it, as a dispatched
 * tool result's references are, so fetch_reference can reach it through the
 * fetcher's origin check. RFC-005 §6.2 has the host keep each received
 * reference's connection binding.
 *
 * Run: node --import tsx --test test/mcpl-reference-binding.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixture, TS } from './helpers/coalescing-fixture.js';
import { noAddressReason, referenceRegistry, type ReferenceRecord } from '../src/mcpl/references.js';
import { HookOrchestrator } from '../src/mcpl/hook-orchestrator.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { PushHandler } from '../src/mcpl/push-handler.js';
import { AgentFramework } from '../src/framework.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

/** A reference block on a uri of its own, so each test has its own record in the process-wide registry. */
const reference = (name: string, type: 'resource' | 'image' | 'audio' = 'resource') => ({
  type, uri: `https://editor.example.invalid/binding/${name}`, disposition: 'ref',
  mimeType: { resource: 'application/pdf', image: 'image/png', audio: 'audio/wav' }[type],
});
/** One reference of each form a converter stubs: a resource, and uri-form image and audio. */
const everyForm = (name: string) => [reference(`${name}.pdf`), reference(`${name}.png`, 'image'), reference(`${name}.wav`, 'audio')];

/** The records behind the reference stubs in `text`, in order. */
function stubRecords(text: string): Array<ReferenceRecord | undefined> {
  return [...text.matchAll(/\[(ref_[0-9a-z]+_[0-9a-z]+)\]/g)].map((m) => referenceRegistry.get(m[1]!));
}

test("a push event's reference is registered with the server that sent it", async (t) => {
  const f = await fixture(); t.after(f.close);
  const r = await f.send('push/event', {
    featureSet: 'doc', eventId: 'push-ref', timestamp: TS, payload: { content: [{ type: 'text', text: 'pushed_ref' }, ...everyForm('push')] },
  });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  await f.framework.runUntilIdle();
  assert(f.context().includes('pushed_ref'), 'the push is stored');
  assert.deepEqual(stubRecords(f.context()).map((record) => record?.serverIds), [['editor'], ['editor'], ['editor']]);
});

test("a render result's reference is registered with the server that rendered it", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.renderer(async () => ({ content: [{ type: 'text', text: 'rendered_ref' }, reference('render.pdf')] }));
  await f.send('push/event', f.params('render-ref', 'render_fallback', { deferred: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1);
  assert(f.context().includes('rendered_ref'), 'the rendered content is delivered');
  assert.deepEqual(stubRecords(f.context()).map((record) => record?.serverIds), [['editor']]);
});

test("a channel-scoped render result's reference is registered with the server that rendered it", async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  f.renderer(async () => ({ content: [{ type: 'text', text: 'channel_rendered_ref' }, reference('channel-render.pdf')] }));
  await f.send('push/event', f.params('channel-render-ref', 'channel_render_fallback', { channelId: 'chat', key: 'message:cr', initial: true, deferred: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1);
  assert(f.context().includes('channel_rendered_ref'), 'the rendered content is delivered');
  assert.deepEqual(stubRecords(f.context()).map((record) => record?.serverIds), [['editor']]);
});

test("an incoming channel message's reference is registered with the server that sent it", async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const r = await f.send('channels/incoming', { messages: [{
    channelId: 'chat', messageId: 'channel-ref', timestamp: TS, author: { id: 'u', name: 'User' }, tags: ['chat:mention'],
    content: [{ type: 'text', text: 'channel_ref' }, ...everyForm('channel')],
  }] });
  assert.equal(r.result.results[0].accepted, true, JSON.stringify(r.result));
  await f.framework.runUntilIdle();
  assert(f.context().includes('channel_ref'), 'the message is stored');
  assert.deepEqual(stubRecords(f.context()).map((record) => record?.serverIds), [['editor'], ['editor'], ['editor']]);
});

test("a context injection's reference is registered with the server whose hook sent it", async () => {
  // A server listed first whose answer carries no injection, so the binding
  // is told apart from whichever server comes first.
  const quiet = {
    id: 'quiet',
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendBeforeInference: async () => ({ featureSet: 'fs', contextInjections: [] }),
  };
  const server = {
    id: 'hooks',
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendBeforeInference: async () => ({
      featureSet: 'fs',
      contextInjections: [{ namespace: 'n', position: 'system', content: [{ type: 'text', text: 'injected_ref' }, ...everyForm('hook')] }],
    }),
  };
  const orchestrator = new HookOrchestrator(
    { getAllServers: () => [quiet, server] } as unknown as McplServerRegistry,
    { validateInbound() {} } as unknown as FeatureSetManager,
  );
  const injections = await orchestrator.beforeInference({
    inferenceId: 'i', conversationId: 'c', turnIndex: 0, userMessage: null, model: { id: 'test' } as never,
  });
  const text = JSON.stringify(injections);
  assert(text.includes('injected_ref'), text);
  assert.deepEqual(stubRecords(text).map((record) => record?.serverIds), [['hooks'], ['hooks'], ['hooks']]);
});

test("fetch_reference reaches a push event's reference through its server's own address, and refuses one elsewhere, one from a server with no address, one from a server spawned from a command whatever url its config holds, and one from a server the host doesn't know, reading a server's transport as the host connects to it", async (t) => {
  const png = Buffer.from('not really a png, but bytes');
  let dialed = 0;
  const http = createServer((_req, res) => { dialed++; res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(png); });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  // What a WebSocket server on that origin is dialed at: the origin check reads ws as http.
  const wsOrigin = origin.replace(/^http:/, 'ws:');
  // The push path as the framework builds it, here with no coalescer.
  const pushed: unknown[] = [];
  const handler = new PushHandler({ validateInbound() {} } as unknown as FeatureSetManager, (event) => { pushed.push(event); }, () => {});
  const push = (serverId: string, eventId: string, uris: string[]) => handler.handlePushEvent(serverId, {
    featureSet: 'fs', eventId, timestamp: TS,
    payload: { content: [{ type: 'text', text: eventId }, ...uris.map((uri) => ({ type: 'image', uri, mimeType: 'image/png', sizeBytes: png.length, disposition: 'ref' }))] },
  } as never, { respond: () => {}, respondError: () => {} } as never);
  await push('push-srv', 'fetch-own', [`${origin}/binding/own.png`, 'https://cdn.example.invalid/binding/elsewhere.png']);
  await push('stdio-srv', 'fetch-stdio', [`${origin}/binding/stdio.png`]);
  await push('gone-srv', 'fetch-gone', [`${origin}/binding/gone.png`]);
  await push('spawned-srv', 'fetch-spawned', [`${origin}/binding/spawned.png`]);
  await push('ws-command-srv', 'fetch-ws-command', [`${origin}/binding/ws-command.png`]);
  await push('stdio-url-srv', 'fetch-stdio-url', [`${origin}/binding/stdio-url.png`]);
  await push('ws-http-srv', 'fetch-ws-http', [`${origin}/binding/ws-http.png`]);
  await push('ws-fragment-srv', 'fetch-ws-fragment', [`${origin}/binding/ws-fragment.png`]);
  const [own, elsewhere, stdio, gone, spawned, wsCommand, stdioUrl, wsHttp, wsFragment] = stubRecords(JSON.stringify(pushed));
  assert.deepEqual(
    [own, elsewhere, stdio, gone, spawned, wsCommand, stdioUrl, wsHttp, wsFragment].map((record) => record?.serverIds),
    [['push-srv'], ['push-srv'], ['stdio-srv'], ['gone-srv'], ['spawned-srv'], ['ws-command-srv'], ['stdio-url-srv'], ['ws-http-srv'], ['ws-fragment-srv']],
  );
  // The framework's own fetcher, resolving each server from its MCPL config:
  // push-srv has an address; stdio-srv, as a stdio server, has none, nor
  // has spawned-srv, which the host spawns from its command though its
  // config also holds a url on the uri's origin; and gone-srv isn't
  // configured at all. An explicit transport decides as the host connects:
  // ws-command-srv is a WebSocket server though its config holds a command,
  // and stdio-url-srv is spawned though its config holds only a url.
  // ws-http-srv and ws-fragment-srv are WebSocket servers whose url the
  // transport won't dial: the first isn't ws:// or wss://, and the second,
  // on the uri's origin, has a fragment.
  type Answer = { result: { success: boolean; data?: string; error?: string } };
  const framework = Object.create(AgentFramework.prototype) as {
    pushEvent(event: unknown): void;
    dispatchFetchReferenceToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
  };
  Object.assign(framework, {
    mcplServerConfigs: new Map(),
    getWorkspaceModule: () => ({ writeBinary: async () => ({ success: true }) }),
    firstWritableMountName: () => 'scratch',
    emitTrace: () => {},
  });
  // Configured as the framework configures a server: its config, which the
  // fetcher reads, and its address in the reference registry, which the
  // stub reads.
  for (const config of [
    { id: 'push-srv', url: wsOrigin },
    { id: 'stdio-srv', command: 'stdio-server' },
    { id: 'spawned-srv', command: 'stdio-server', url: wsOrigin },
    { id: 'ws-command-srv', transport: 'websocket', command: 'stdio-server', url: wsOrigin },
    { id: 'stdio-url-srv', transport: 'stdio', url: wsOrigin },
    { id: 'ws-http-srv', transport: 'websocket', url: origin },
    { id: 'ws-fragment-srv', url: `${wsOrigin}/mcpl#frag` },
  ]) (framework as unknown as { setMcplServerConfig(config: unknown): void }).setMcplServerConfig(config);
  // Bounded, so a dispatch that never answers fails the test rather than hanging it.
  const fetchReference = (refId: string): Promise<Answer['result']> => {
    let timer: NodeJS.Timeout | undefined;
    const answered = new Promise<Answer>((resolve) => { framework.pushEvent = (event) => resolve(event as Answer); });
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`fetch_reference never answered for ${refId}`)), 10_000); });
    framework.dispatchFetchReferenceToolCall('prime', { id: `call_${refId}`, name: 'fetch_reference', input: { ref_id: refId } });
    return Promise.race([answered, late]).then((a) => a.result).finally(() => clearTimeout(timer));
  };
  const fetched = await fetchReference(own!.refId);
  assert.equal(fetched.success, true, fetched.error);
  assert.equal(dialed, 1);
  // fetch_reference's sentence: the fetcher's clause, then what calling again can do.
  const refusedWith = (refId: string, clause: string, remedy = "Calling again won't change that.") =>
    `fetch_reference couldn't fetch "${refId}": ${clause}. ${remedy}`;
  const refused = await fetchReference(elsewhere!.refId);
  assert.equal(refused.success, false);
  assert.match(refused.error ?? '', /^fetch_reference couldn't fetch "ref_\S+": it points to \S+, not to the "\S+" server's own address /);
  const noAddress = await fetchReference(stdio!.refId);
  assert.equal(noAddress.success, false);
  assert.equal(noAddress.error, refusedWith(stdio!.refId, noAddressReason('stdio-srv')));
  const notDialed = await fetchReference(spawned!.refId);
  assert.equal(notDialed.success, false);
  assert.equal(notDialed.error, refusedWith(spawned!.refId, noAddressReason('spawned-srv')));
  const unknown = await fetchReference(gone!.refId);
  assert.equal(unknown.success, false);
  assert.equal(unknown.error, refusedWith(gone!.refId, 'this host no longer has the "gone-srv" server it came from',
    "Calling again won't change that unless whoever runs this host adds that server back."));
  assert.equal(dialed, 1, 'nothing dialed for the other four');
  const throughWebSocket = await fetchReference(wsCommand!.refId);
  assert.equal(throughWebSocket.success, true, throughWebSocket.error);
  assert.equal(dialed, 2);
  const spawnedByTransport = await fetchReference(stdioUrl!.refId);
  assert.equal(spawnedByTransport.success, false);
  assert.equal(spawnedByTransport.error, refusedWith(stdioUrl!.refId, noAddressReason('stdio-url-srv')));
  const undialable = await fetchReference(wsHttp!.refId);
  assert.equal(undialable.success, false);
  assert.equal(undialable.error, refusedWith(wsHttp!.refId, noAddressReason('ws-http-srv')));
  const fragment = await fetchReference(wsFragment!.refId);
  assert.equal(fragment.success, false);
  assert.equal(fragment.error, refusedWith(wsFragment!.refId, noAddressReason('ws-fragment-srv')));
  assert.equal(dialed, 2, 'nothing dialed for the last three');
});

/** The admin puppet's route to an MCPL tool, executeMcplToolCall, with a
 *  server whose tool answers `answer`, and the given fetcher. Returns the
 *  call's result, and the tool result's content as the puppet stored it, as
 *  JSON. */
async function puppetCall(answer: unknown, fetcher: unknown): Promise<{ result: { success: boolean; error?: string }; text: string }> {
  const stored: Array<{ participant: string; content: Array<Record<string, unknown>> }> = [];
  const store = (participant: string, content: Array<Record<string, unknown>>) => {
    stored.push({ participant, content });
    return `msg-${stored.length}`;
  };
  const agent = {
    name: 'princess',
    state: { status: 'idle' },
    canUseTool: () => true,
    deniesAtDispatch: () => false,
    getContextManager: () => ({ addMessage: store }),
  };
  const framework = Object.create(AgentFramework.prototype) as AgentFramework;
  const fw = framework as unknown as Record<string, unknown>;
  Object.assign(fw, {
    agents: new Map([['princess', agent]]),
    toolImageLedgers: new Map(),
    activeTurnTokens: new Map(),
    nextTurnToken: 1,
    deferredMessages: [],
    unackedDeferredWrites: [],
    deferredSeq: 0,
    deferredScanFrom: new Map(),
    pendingAssistantBlocks: new Map(),
    operatorOperations: new Set(),
    primaryAgentName: 'princess',
    addMessage: store,
    getToolsForAgent: () => [{ name: 'mcpl--eido--look' }],
    resolveToolResultInlineCap: () => ({ cap: undefined }),
    emitTrace: () => {},
    mcplServerConfigs: new Map([['eido', { id: 'eido' }]]),
    mcplPrefixMap: new Map([['mcpl--eido', 'eido']]),
    mcplServerRegistry: {
      getServer: (id: string) => (id === 'eido' ? {
        sendToolsCall: async () => answer,
      } : undefined),
    },
    getReferenceFetcher: () => fetcher,
  });
  // eido is dialed on its references' origin, so a stub of one can offer
  // the fetch: the reference registry records its address, as the
  // framework does for a server it configures.
  (framework as unknown as { setMcplServerConfig(config: unknown): void })
    .setMcplServerConfig({ id: 'eido', url: 'wss://editor.example.invalid' });
  const quiet = console.log;
  console.log = () => {};
  const { result } = await framework.puppetToolCall('princess', 'mcpl--eido--look', {})
    .finally(() => { console.log = quiet; });
  const toolResult = stored.find((s) => s.participant === 'user')?.content[0];
  assert.equal(toolResult?.type, 'tool_result');
  return { result, text: JSON.stringify(toolResult?.content) };
}

/** puppetCall with a successful result carrying one reference, `name`. */
async function puppetLook(name: string, fetcher: unknown): Promise<string> {
  const { result, text } = await puppetCall({ content: [{ type: 'text', text: 'looked' }, reference(name)] }, fetcher);
  assert.equal(result.success, true, result.error);
  assert(text.includes('looked'), text);
  return text;
}

test("an MCPL tool called in process that fails registers none of its result's references and fetches nothing", async () => {
  // A failure keeps only its text, so no stub is made of its references.
  const failed = reference('puppet-failed.pdf');
  let fetches = 0;
  const fetchFake = async () => { fetches++; return { ok: true, path: 'scratch/refs/puppet-failed.pdf' }; };
  const { result, text } = await puppetCall({ isError: true, content: [{ type: 'text', text: 'look failed' }, failed] }, {
    isEagerEligible: () => true,
    fetch: fetchFake,
    fetchEager: fetchFake,
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'look failed');
  assert(text.includes('look failed'), text);
  assert.equal(referenceRegistry.findByUri(failed.uri), undefined, 'not registered');
  assert.equal(fetches, 0, 'nothing fetched');
});

test("an MCPL tool called in process, as the admin puppet calls one, has its result's references registered with its server, and fetches none of them", async () => {
  // executeToolCall and a module's ctx.callTool reach the server through
  // executeMcplToolCall, not the agent's dispatch; its result's references
  // are bound before the puppet stores the pair, as a dispatched call's are,
  // so the stored stub offers the fetch. Nothing is fetched, even a
  // reference the eager default would fetch for a call the agent makes.
  let fetches = 0;
  const fetchFake = async () => { fetches++; return { ok: true, path: 'scratch/refs/puppet.pdf' }; };
  const text = await puppetLook('puppet.pdf', {
    isEagerEligible: () => true,
    fetch: fetchFake,
    fetchEager: fetchFake,
  });
  assert.deepEqual(stubRecords(text).map((record) => record?.serverIds), [['eido']]);
  assert.match(text, /\[ref_[0-9a-z]+_[0-9a-z]+\] application\/pdf[^"]* — fetch with fetch_reference/, text);
  assert.equal(fetches, 0, 'nothing fetched');
});
