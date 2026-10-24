/**
 * What a script receives from a tool whose result carries structuredContent,
 * through the real dispatch. An MCPL peer's content blocks get the treatment
 * RFC-005 gives them on every lane the model reads, since what a script prints
 * comes back to the model: a reference arrives without its URI (a link
 * carries one only where the model's line shows it), as the host's
 * reference id, what the server said about it in that block, and `savedTo`,
 * the workspace path the dispatch fetched its payload to for the script; a
 * block the classifier rejects arrives as the notice the model's lanes show,
 * and inline data that claims a bulk disposition as the withheld notice; the
 * same holds for what RFC-005 governs nested at any depth in a block's other
 * fields, its references bound to the peer. A
 * standard peer's blocks arrive as the server sent them. A module's blocks,
 * such as an MCPL peer's it got through ctx.callTool and returns whole, are
 * read as the model's history reads a module's data: what RFC-005 governs,
 * at any depth, as the script lane shows it, and anything else as sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework, WorkspaceModule } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { EXPIRY_REASON, INLINE_WITHHELD_TEXT, UNBOUND_REASON, classifyBlock, referenceRegistry } from '../src/mcpl/references.js';
import type { ReferenceRecord, ReferenceTestimony } from '../src/mcpl/references.js';
import { nonErrorResultText } from '../src/tool-result-history.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const SAVED = 'board/references/report.pdf';
const DIGEST = 'sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';

/** The URIs of one test's references. The reference registry lives as long
 *  as the process, so each test names its own. */
const uris = (test: string) => ({
  report: `https://files.example.invalid/${test}/report.pdf?sig=secret-token`,
  big: `https://files.example.invalid/${test}/big.png?sig=other-token`,
  old: `https://files.example.invalid/${test}/old.png?sig=old-token`,
});

/** A block of each kind the dispatch decides about. */
const blocks = (test: string) => [
  // A reference whose payload the fetch saves. Its labels carry a bidi
  // override, a bidi mark and a control character.
  { type: 'resource', uri: uris(test).report, name: 'report\u202E.pdf\u0007', mimeType: 'application/pdf\u200F', sizeBytes: 1234,
    digest: DIGEST, expiresAt: '2099-12-31T00:00:00Z' },
  // The same reference again, saying something else about itself.
  { type: 'resource', uri: uris(test).report, name: 'report-copy.pdf' },
  // A reference the fetch doesn't save.
  { type: 'image', uri: uris(test).big, mimeType: 'image/png', disposition: 'ref', expiresAt: '2099-12-31T00:00:00Z' },
  // Inline data that claims a bulk disposition, and inline data with a uri
  // beside it: withheld.
  { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', disposition: 'ref' },
  { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav', uri: 'https://files.example.invalid/beside?sig=beside-token' },
  // Inline data that claims nothing.
  { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
  // Blocks the classifier rejects: a uri longer than its limit (4096 UTF-16
  // units), and an MCP embedded resource (its uri nested).
  { type: 'resource', uri: `https://files.example.invalid/long?sig=${'s'.repeat(4096)}`, name: 'long' },
  { type: 'resource', resource: { uri: 'https://files.example.invalid/embedded?sig=embedded-token', mimeType: 'text/plain', text: 'embedded' } },
  // A link (MCP's resource_link), a reference (RFC-005 §8.1) the host can
  // fetch here, so its uri, which also carries a signature, stays out.
  { type: 'resource_link', uri: 'https://files.example.invalid/link?sig=link-token', name: 'link' },
  { type: 'text', text: 'two attachments' },
  // A reference that counts as expired: with a bidi override after it, its
  // expiresAt doesn't parse, so it fails closed. It isn't fetched, and the
  // script is told why.
  { type: 'image', uri: uris(test).old, mimeType: 'image/png', expiresAt: '2099-12-31T00:00:00Z\u202E' },
];

/** A `never` reference, which RFC-005 withholds, with its uri, from every lane the model reads. */
const never = (test: string) => ({ type: 'resource', uri: `https://files.example.invalid/${test}/sealed.pdf?sig=never-token`, name: 'sealed.pdf', disposition: 'never' });

/**
 * A module that calls the MCPL peer's tool through ctx.callTool and hands the
 * result on: whole (`whole`), without its structured view (`unstructured`),
 * or a result of its own holding a reference deeper in its blocks (`nested`,
 * and `deep--nested`, a name a server's prefix `fwd--deep` would fit).
 * `during` runs while a call is in flight, before its result.
 */
class Forward implements Module {
  readonly name = 'fwd';
  private ctx: ModuleContext | null = null;
  nested: unknown[] = [];
  nestedStructured: unknown = { nested: true };
  during: () => void = () => {};
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  async onProcess(): Promise<EventResponse> { return {}; }
  getTools(): ToolDefinition[] {
    return ['whole', 'unstructured', 'nested', 'deep--nested', 'failing'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const name = call.name.includes('--') ? call.name.slice(call.name.lastIndexOf('--') + 2) : call.name;
    this.during();
    if (name === 'nested') return { success: true, data: this.nested, structured: this.nestedStructured };
    if (name === 'failing') return { success: false, isError: true, error: 'the module failed', data: this.nested, structured: { partial: true } };
    const result = await this.ctx!.callTool({ id: `fwd-${randomUUID()}`, name: 'mcpl--files--attach', input: {} });
    if (name === 'unstructured') {
      const { structured: _structured, ...rest } = result;
      return rest;
    }
    return result;
  }
}

/** A tools/call result as a server may send it, nonconformant blocks included. */
interface Answer { content: unknown[]; structuredContent?: unknown; isError?: boolean }

interface Harness {
  /** Sets what every tools/call answers from now on. */
  answer: (result: Answer) => void;
  /** A script's call to a tool of the MCPL peer `files`, or of the MCP-only peer `plain`. */
  script: (tool: string) => Promise<string>;
  /** A call the model makes to a tool of `files` (or of `plain`), through the same dispatch. */
  modelCall: (tool: string, server?: 'files' | 'plain') => Promise<ToolResult>;
  /** The URIs the fetcher was asked for, saved records aside. */
  fetched: string[];
  workspace: WorkspaceModule;
  forward: Forward;
  /** The script lane's exit itself, for a result, the tool name it answers, and whether its call went to a server. */
  exit: (result: ToolResult, tool: string, toServer: boolean) => Promise<string>;
  /** The framework's tool prefixes, by server, as a connect or disconnect changes them. */
  prefixes: Map<string, string>;
  /** Runs while a server answers a call, before its answer. */
  duringServerCall: (fn: () => void) => void;
  /** From now on, records what the tool lifecycle (RFC-007) is told, each
   *  method's name and arguments, and the framework's traces of tools' outcomes. */
  observe: () => { lifecycle: unknown[][]; outcomes: Array<{ type: string; error?: string }> };
}

async function withPeers(fn: (h: Harness) => Promise<void>, opts: { eager?: boolean } = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'script-structured-references-'));
  const board = join(dir, 'board');
  mkdirSync(board);
  const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: board, mode: 'read-write', watch: 'never' }] });
  const forward = new Forward();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }], modules: [workspace, forward],
  });
  workspace.initStore(framework.getStore());
  let answer: Answer = { content: [] };
  let during: () => void = () => {};
  // Two legacy-engine peers: `files` negotiated MCPL, `plain` is MCP-only.
  const peer = (id: string, capabilities: Record<string, unknown> | null) => ({ id, capabilities, sendToolsCall: async () => { during(); return answer; } });
  const peers = new Map([['files', peer('files', {})], ['plain', peer('plain', null)]]);
  const fetched: string[] = [];
  const internals = framework as unknown as {
    mcplServerRegistry: unknown;
    mcplPrefixMap: Map<string, string>;
    getReferenceFetcher: () => unknown;
    scriptToolCall: (agent: string, tool: string, argsJson: string, context: object) => Promise<{ ok: boolean; json: string }>;
    scriptResultAnswer: (result: ToolResult, tool: string, toServer: boolean) => Promise<{ json: string }>;
    dispatchMcplToolCall: (agent: string, call: { id: string; name: string; input: unknown }, serverId: string, prefix: string) => void;
    pushEvent: (event: { type: string; callId?: string; result?: ToolResult }) => void;
  };
  internals.mcplServerRegistry = { getServer: (id: string) => peers.get(id) ?? null, getAllServers: () => [], closeAll: async () => {} };
  internals.mcplPrefixMap.set('mcpl--files', 'files');
  internals.mcplPrefixMap.set('mcpl--plain', 'plain');
  // As configuring `files` records its address, which a reference's stub,
  // and a script's object for it, read for what a fetch would do.
  referenceRegistry.setServerAddress('files', { url: 'wss://files.example.invalid' }, framework);
  // Stands in for the host-mediated fetcher: every reference is eager or
  // none is, as the test asks, the report is saved and anything else
  // refused, and a saved record returns at once.
  internals.getReferenceFetcher = () => ({
    isEagerEligible: () => opts.eager === true,
    fetch: async (record: ReferenceRecord) => {
      if (record.fetchedPath) return { ok: true, path: record.fetchedPath };
      fetched.push(record.testimony.uri);
      if (!record.testimony.uri.includes('report.pdf')) return { ok: false, error: 'refused by the test' };
      record.fetchedPath = SAVED;
      return { ok: true, path: SAVED };
    },
  });
  const modelCall = (tool: string, server: 'files' | 'plain' = 'files') => new Promise<ToolResult>((resolve) => {
    const id = `model-${randomUUID()}`;
    const push = internals.pushEvent;
    internals.pushEvent = (event) => {
      if (event.type !== 'tool-result' || event.callId !== id) return push.call(framework, event);
      internals.pushEvent = push;
      resolve(event.result!);
    };
    internals.dispatchMcplToolCall('agent', { id, name: `mcpl--${server}--${tool}`, input: {} }, server, `mcpl--${server}`);
  });
  framework.start();
  try {
    await fn({
      answer: (result) => { answer = result; },
      // The JSON of the result a script's call gets: { content, structuredContent, isError }.
      script: async (tool) => (await internals.scriptToolCall.call(framework, 'agent', tool, '{}', {})).json,
      modelCall,
      fetched,
      workspace,
      forward,
      exit: async (result, tool, toServer) => (await internals.scriptResultAnswer.call(framework, result, tool, toServer)).json,
      prefixes: internals.mcplPrefixMap,
      duringServerCall: (fn) => { during = fn; },
      observe: () => {
        // Each method answers undefined, as an absent emitter's optional
        // call does, so the calls take the path a host with no lifecycle
        // observers takes, and onResult is told what a terminal reads.
        const lifecycle: unknown[][] = [];
        const outcomes: Array<{ type: string; error?: string }> = [];
        (framework as unknown as { toolLifecycleEmitter: unknown }).toolLifecycleEmitter = new Proxy({}, {
          get: (_target, method) => (...args: unknown[]) => { lifecycle.push([method, ...args]); return undefined; },
        });
        framework.onTrace((event) => {
          const { type, error } = event as { type: string; error?: string };
          if (type === 'tool:completed' || type === 'tool:failed') outcomes.push({ type, ...(error !== undefined ? { error } : {}) });
        });
        return { lifecycle, outcomes };
      },
    });
  } finally {
    await framework.stop();
    referenceRegistry.forgetServerAddress('files', framework);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What a script reads for those blocks from an MCPL peer, given each reference's id. */
const treated = (report: string, big: string, old: string, link: string) => [
  { type: 'resource', refId: report, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1234, digest: DIGEST,
    expiresAt: '2099-12-31T00:00:00Z', savedTo: SAVED },
  { type: 'resource', refId: report, name: 'report-copy.pdf', savedTo: SAVED },
  { type: 'image', refId: big, mimeType: 'image/png', expiresAt: '2099-12-31T00:00:00Z', savedTo: null },
  { type: 'text', text: INLINE_WITHHELD_TEXT },
  { type: 'text', text: INLINE_WITHHELD_TEXT },
  { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
  { type: 'text', text: '[Reference not shown: its link is longer than this host accepts.]' },
  { type: 'text', text: '[Reference not shown: it arrived without a link.]' },
  { type: 'resource_link', refId: link, name: 'link', savedTo: null },
  { type: 'text', text: 'two attachments' },
  { type: 'image', refId: old, mimeType: 'image/png', expiresAt: '2099-12-31T00:00:00Z', savedTo: null, expired: EXPIRY_REASON.unparseable,
    unfetchable: `the reference is ${EXPIRY_REASON.unparseable}` },
];

test("an MCPL peer's structured result reaches a script with each block treated as the model's lanes treat it", async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    answer({ content: blocks('treated'), structuredContent: { attachments: 2 } });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('example.invalid'), `no URI reaches the script: ${out.slice(0, 2000)}`);
    assert.deepEqual(fetched, [uris('treated').report, uris('treated').big],
      'every reference was fetched for the script before it read the result, except the one that counts as expired and the link, which is never fetched for a script');
    const object = JSON.parse(out) as { content: Array<{ refId?: string }>; structuredContent: unknown; isError: boolean };
    const [report, , big] = object.content;
    const link = object.content[8];
    const old = object.content[10];
    for (const ref of [report, big, link, old]) assert.match(String(ref!.refId), /^ref_/);
    assert.equal(new Set([report!.refId, big!.refId, link!.refId, old!.refId]).size, 4);
    assert.deepEqual(object, { content: treated(report!.refId!, big!.refId!, old!.refId!, link!.refId!), structuredContent: { attachments: 2 }, isError: false });
  });
});

test("an MCP-only peer's structured result reaches a script as the server sent it", async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    answer({ content: blocks('plain'), structuredContent: { attachments: 2 } });
    const object = JSON.parse(await script('mcpl--plain--attach'));
    assert.deepEqual(object, { content: blocks('plain'), structuredContent: { attachments: 2 }, isError: false },
      'resource links, embedded resources, uri-form media and inline data are ordinary MCP blocks there');
    assert.deepEqual(fetched, [], 'nothing is a reference, so nothing is fetched');
  });
});

test("content that isn't a list of blocks reaches a script as the model reads it, for each kind of peer", async () => {
  await withPeers(async ({ answer, script, modelCall }) => {
    answer({ content: 'not a list' as unknown as unknown[], structuredContent: { a: 1 } });
    const notice = '[malformed result: its content is not a list of blocks; the tool may already have completed]';
    // A standard peer's reading calls it a malformed result, on both paths.
    const plainModel = await modelCall('attach', 'plain');
    assert.equal(plainModel.isError, true);
    assert.ok(plainModel.error?.startsWith(notice), plainModel.error);
    assert.deepEqual(JSON.parse(await script('mcpl--plain--attach')), { content: [{ type: 'text', text: notice }], structuredContent: { a: 1 }, isError: true });
    // An MCPL peer's reading has no content and reads the structured view, on both paths.
    const filesModel = await modelCall('attach', 'files');
    assert.equal(filesModel.isError, false);
    assert.deepEqual(JSON.parse(await script('mcpl--files--attach')), { content: [], structuredContent: { a: 1 }, isError: false });
    // Content left out isn't malformed: no content, on either peer.
    answer({ structuredContent: { a: 1 } } as unknown as Answer);
    assert.equal((await modelCall('attach', 'plain')).isError, false);
    for (const tool of ['mcpl--plain--attach', 'mcpl--files--attach']) {
      assert.deepEqual(JSON.parse(await script(tool)), { content: [], structuredContent: { a: 1 }, isError: false }, tool);
    }
  });
});

test('without structured content, an MCPL peer\'s result reaches a script as stubs naming the same reference id and saved path', async () => {
  await withPeers(async ({ answer, script }) => {
    // Only blocks the text lane recognizes: one it doesn't sends the whole
    // array to the JSON fallback, which is older than this script path.
    const all = blocks('unstructured');
    const content = [all[0], all[2], all[9]];
    answer({ content, structuredContent: {} });
    const structuredId = String((JSON.parse(await script('mcpl--files--attach')) as { content: Array<{ refId?: string }> }).content[0]!.refId);
    answer({ content });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('example.invalid'), out);
    assert.ok(out.includes(`[${structuredId}]`), `the same reference id: ${out}`);
    assert.ok(out.includes(`saved: ${SAVED}`), `the same saved path: ${out}`);
  });
});

test("an MCPL peer's large structured result reaches a script whole, its references as their ids, no URI", async () => {
  await withPeers(async ({ answer, script }) => {
    // Past main's old 5 MB script cap, which saved such a result to the
    // workspace: a result now reaches the script whole up to its memory's
    // bound, past which it's refused as ResultTooLarge.
    answer({ content: blocks('oversized'), structuredContent: { pad: 'x'.repeat(5_000_000) } });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('example.invalid'), 'no URI reaches the script');
    const object = JSON.parse(out) as { content: Array<{ refId?: string }>; structuredContent: { pad: string }; isError: boolean };
    assert.equal(object.isError, false);
    assert.equal(object.structuredContent.pad.length, 5_000_000);
    assert.deepEqual(object.content, treated(object.content[0]!.refId!, object.content[2]!.refId!, object.content[10]!.refId!, object.content[8]!.refId!));
  });
});

test("only a script that reads the blocks gets the script-demand fetch: not the model's call, nor an error a script reads as text", async () => {
  await withPeers(async ({ answer, script, modelCall, fetched }) => {
    answer({ content: blocks('model'), structuredContent: { attachments: 2 } });
    const model = await modelCall('attach');
    assert.equal(model.success, true);
    assert.deepEqual(fetched, [], 'nothing here is eager-eligible, and the model\'s call gets no more than the eager pass');

    answer({ content: [blocks('error')[0], { type: 'text', text: 'the attach failed' }], isError: true });
    assert.equal(await script('mcpl--files--attach'), JSON.stringify({ content: [{ type: 'text', text: 'the attach failed' }], structuredContent: null, isError: true }));
    assert.deepEqual(fetched, [], 'a script that reads an error as its text alone gets no more than the eager pass');
  });
});

test("the eager pass still runs for the model's call and for an error a script reads as text", async () => {
  await withPeers(async ({ answer, script, modelCall, fetched }) => {
    answer({ content: [blocks('eager-model')[0]], structuredContent: { attachments: 1 } });
    assert.equal((await modelCall('attach')).success, true);
    assert.deepEqual(fetched, [uris('eager-model').report]);

    answer({ content: [blocks('eager-error')[0], { type: 'text', text: 'the attach failed' }], isError: true });
    assert.equal(await script('mcpl--files--attach'), JSON.stringify({ content: [{ type: 'text', text: 'the attach failed' }], structuredContent: null, isError: true }));
    assert.deepEqual(fetched, [uris('eager-model').report, uris('eager-error').report]);
  }, { eager: true });
});

test('an error with structured content is fetched for the script, and reaches it treated, with its error text and structured content', async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    answer({ content: [blocks('structured-error')[0], { type: 'text', text: 'the attach failed' }], structuredContent: { partial: true }, isError: true });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('example.invalid'), out);
    const object = JSON.parse(out) as { content: Array<{ refId?: string }>; structuredContent: unknown; isError: boolean };
    assert.deepEqual(object, {
      content: [treated(object.content[0]!.refId!, '', '', '')[0], { type: 'text', text: 'the attach failed' }],
      structuredContent: { partial: true },
      isError: true,
    });
    assert.deepEqual(fetched, [uris('structured-error').report], 'the script reads the blocks, so its reference was fetched first');
  });
});

test("an MCPL peer's link reads every reference in its result, so a never anywhere in it withholds the link's uri from a script", { timeout: 30_000 }, async () => {
  await withPeers(async (h) => {
    // Off the server's origin, so the host can't fetch it and its line would
    // show its uri, but a reference in the same result says never, and a
    // later one, registered last, doesn't.
    const uri = 'https://elsewhere.example.invalid/never-in-result.csv';
    h.answer({
      content: [
        { type: 'resource', uri, name: 'kept.csv', disposition: 'never' },
        { type: 'resource', uri, name: 'kept.csv' },
        { type: 'resource_link', uri, name: 'kept.csv' },
      ],
      structuredContent: {},
    });
    const out = await h.script('mcpl--files--attach');
    assert.ok(!out.includes('elsewhere.example.invalid'), out);
    // Each block reached the script, the link as a reference object.
    const object = JSON.parse(out) as { content: Array<{ type: string; refId?: string; uri?: string }>; isError: boolean };
    assert.equal(object.isError, false);
    assert.deepEqual(object.content.map((b) => b.type), ['resource', 'resource', 'resource_link']);
    assert.match(String(object.content[2]!.refId), /^ref_/);
    assert.equal(object.content[2]!.uri, undefined);
  });
});

test("a script's view reads the claims of the references nested in its blocks, so a nested never withholds a link's uri there", { timeout: 30_000 }, async () => {
  await withPeers(async (h) => {
    // Off the server's origin and with no credential in it, so the host can't
    // fetch it and its line shows its uri: the control shows the script gets it.
    const uri = 'https://elsewhere.example.invalid/nested-never/plain.csv';
    const link = { type: 'resource_link', uri, name: 'plain.csv' };
    h.answer({ content: [{ type: 'text', text: 'one link' }, link], structuredContent: {} });
    const control = JSON.parse(await h.script('mcpl--files--attach')) as { content: Array<{ uri?: string }> };
    assert.equal(control.content[1]!.uri, uri, 'with nothing claiming it, the link carries its uri');
    // A reference nested in another block's fields says never for that uri.
    // The script is shown it, as its stub, so its claim counts for the view
    // (Ada-1017, room-203 #200094), where the model's line, which shows the
    // text block and not its fields, doesn't read it.
    const sealed = { type: 'resource', uri, name: 'plain.csv', disposition: 'never' };
    h.answer({ content: [{ type: 'text', text: 'one link', attachment: sealed }, link], structuredContent: {} });
    const out = await h.script('mcpl--files--attach');
    assert.ok(!out.includes('elsewhere.example.invalid'), out);
    const object = JSON.parse(out) as { content: Array<Record<string, unknown>> };
    assert.equal(object.content[1]!.uri, undefined);
    assert.equal(typeof (object.content[0]!.attachment as Record<string, unknown>).refId, 'string');
  });
});

test("an MCPL peer's structured failure reaches a script with what's nested in its blocks treated too", async () => {
  await withPeers(async ({ answer, script }) => {
    const sealed = never('nested-failure');
    answer({ content: [{ type: 'text', text: 'the attach failed', attachment: sealed }], structuredContent: { partial: true }, isError: true });
    const out = await script('mcpl--files--attach');
    assert.equal(out.includes('never-token'), false, out);
    const object = JSON.parse(out) as { content: Array<Record<string, unknown>>; isError: boolean };
    const attachment = object.content[0]!.attachment as Record<string, unknown>;
    assert.deepEqual([object.isError, attachment.refId, 'uri' in attachment], [true, referenceRegistry.findByUri(sealed.uri)?.refId, false]);
    assert.equal(typeof attachment.refId, 'string');
  });
});

test("a module's structured result, an MCPL peer's it got through ctx.callTool, reaches a script with each block read as the model's lanes read a module's", async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    answer({ content: [...blocks('module'), never('module')], structuredContent: { attachments: 2 } });
    const out = await script('fwd--whole');
    for (const token of ['secret-token', 'other-token', 'old-token', 'beside-token', 'embedded-token', 'never-token']) {
      assert.ok(!out.includes(token), `${token} doesn't reach the script: ${out.slice(0, 2000)}`);
    }
    const object = JSON.parse(out) as { content: Array<{ refId?: string }>; structuredContent: unknown; isError: boolean };
    const [report, , big] = object.content;
    const link = object.content[8];
    const old = object.content[10];
    const sealed = object.content[11];
    // A resource_link is a reference (RFC-005 §8.1), a module's as an MCPL
    // peer's: its object, its uri left out where the model's line for it
    // leaves it out, as here, where it carries a signature.
    const expected: unknown[] = [...treated(report!.refId!, big!.refId!, old!.refId!, link!.refId!)];
    expected.push({ type: 'resource', refId: sealed!.refId!, name: 'sealed.pdf', savedTo: null });
    assert.deepEqual(object, { content: expected, structuredContent: { attachments: 2 }, isError: false });
    // The one that counts as expired isn't fetched, as the model's lanes'
    // fetch passes over it (autoFetchReferences).
    assert.deepEqual(fetched, [uris('module').report, uris('module').big, never('module').uri],
      'the module\'s references were fetched for the script, but the expired one');
    // Each came through ctx.callTool, whose arrival bound it to the server
    // that sent it, and the exit adds no other server.
    for (const uri of [uris('module').report, never('module').uri]) {
      assert.deepEqual(referenceRegistry.findByUri(uri)?.serverIds, ['files'], uri);
    }
  });
});

test("a module's result without structured content reaches a script as the model's stubs, its reference ids the structured reading's", async () => {
  await withPeers(async ({ answer, script }) => {
    const all = blocks('module-text');
    const content = [all[0], all[2], all[9], never('module-text')];
    answer({ content, structuredContent: {} });
    const structured = JSON.parse(await script('fwd--whole')) as { content: Array<{ refId?: string }> };
    const out = await script('fwd--unstructured');
    for (const token of ['secret-token', 'other-token', 'never-token']) assert.ok(!out.includes(token), `${token}: ${out}`);
    for (const block of [structured.content[0], structured.content[3]]) assert.ok(out.includes(`[${block!.refId}]`), `the same reference id: ${out}`);
  });
});

test("a module's reference deeper in its blocks reaches a script as the model's lanes show it, and other values as sent", async () => {
  await withPeers(async ({ script, forward }) => {
    const sealed = never('module-nested');
    forward.nested = [
      { type: 'text', text: 'one sealed report' },
      { type: 'json', value: { attachment: sealed, list: [sealed, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: { sig: 'object-token' } }], kept: { uri: 'https://files.example.invalid/plain-data' } } },
    ];
    const out = await script('fwd--nested');
    assert.ok(!out.includes('never-token') && !out.includes('object-token'), out);
    const object = JSON.parse(out) as { content: [unknown, { value: { attachment: { refId: string } } }] };
    const refId = object.content[1].value.attachment.refId;
    // A reference the module made itself, bound to no server, says why its
    // fetch would be refused.
    const stub = { type: 'resource', refId, name: 'sealed.pdf', savedTo: null, unfetchable: `it's ${UNBOUND_REASON}` };
    assert.deepEqual(object, {
      content: [
        { type: 'text', text: 'one sealed report' },
        { type: 'json', value: { attachment: stub, list: [stub, { type: 'text', text: INLINE_WITHHELD_TEXT }], kept: { uri: 'https://files.example.invalid/plain-data' } } },
      ],
      structuredContent: { nested: true },
      isError: false,
    }, 'inline data beside a uri of any type is withheld, and a value RFC-005 doesn\'t govern keeps its fields');
    // A reference the module made itself is bound to no server.
    assert.deepEqual(referenceRegistry.findByUri(sealed.uri)?.serverIds, []);
  });
});

test("an MCPL peer's treated blocks, returned again as a module's, are left as they are, while a raw reference beside them is treated", async () => {
  await withPeers(async ({ answer, script, exit }) => {
    answer({ content: [...blocks('twice'), never('twice')], structuredContent: { attachments: 2 } });
    const once = JSON.parse(await script('mcpl--files--attach')) as { content: unknown[]; structuredContent: unknown };
    // A raw reference beside the treated blocks shows that the exit treats
    // this result at all, so the blocks left as they are were treated again.
    const raw = { type: 'resource', uri: 'https://files.example.test/raw.pdf?sig=RAW-TWICE', name: 'raw.pdf', mimeType: 'application/pdf' };
    const again = JSON.parse(await exit({ success: true, data: [...once.content, raw], structured: once.structuredContent }, 'fwd--whole', false)) as { content: unknown[] };
    assert.deepEqual({ ...again, content: again.content.slice(0, -1) }, { content: once.content, structuredContent: { attachments: 2 }, isError: false });
    const last = again.content.at(-1) as Record<string, unknown>;
    assert.deepEqual([last.type, last.name, typeof last.refId, 'uri' in last], ['resource', 'raw.pdf', 'string', false]);
    assert.equal(last.refId, referenceRegistry.findByUri(raw.uri)?.refId, 'the stub names the raw reference\'s own record');
    assert.equal(JSON.stringify(again).includes('files.example.test/raw.pdf'), false);
  });
});

test("a server's result reaches a script as its dispatch gave it when its server disconnects while the call is in flight", async () => {
  await withPeers(async ({ answer, script, prefixes, duringServerCall, fetched }) => {
    const content = blocks('disconnect');
    answer({ content, structuredContent: { attachments: 2 } });
    // The MCP-only peer's blocks reach a script as sent, so a treatment at
    // the exit would show. Its prefix leaves the map as a disconnect takes
    // it, after the dispatch sent the call.
    duringServerCall(() => { prefixes.delete('mcpl--plain'); });
    const object = JSON.parse(await script('mcpl--plain--attach')) as { content: unknown };
    assert.equal(prefixes.has('mcpl--plain'), false, 'the prefix left while the call ran');
    assert.deepEqual(object.content, content);
    assert.deepEqual(fetched, [], 'nothing is fetched for a server\'s result at the exit');
  });
});

test("a module tool's result is treated when a server with a prefix that fits its name connects while its call is in flight", async () => {
  await withPeers(async ({ script, forward, prefixes, fetched }) => {
    forward.nested = [never('connect')];
    // The prefix arrives as a runtime connect gives it, after the dispatch
    // sent the call to the module.
    forward.during = () => { prefixes.set('fwd--deep', 'files'); };
    const out = await script('fwd--deep--nested');
    assert.equal(prefixes.get('fwd--deep'), 'files', 'the prefix arrived while the call ran');
    assert.ok(!out.includes('never-token'), out);
    const object = JSON.parse(out) as { content: [{ refId: string }] };
    assert.deepEqual(object.content, [{ type: 'resource', refId: object.content[0].refId, name: 'sealed.pdf', savedTo: null, unfetchable: `it's ${UNBOUND_REASON}` }]);
    assert.deepEqual(fetched, [never('connect').uri], 'the exit fetches for it as for any module\'s result');
  });
});

test("a module's failed result with structured content reaches a script with its blocks treated and its error", async () => {
  await withPeers(async ({ script, forward }) => {
    forward.nested = [{ type: 'text', text: 'partly attached' }, never('module-failing')];
    const out = await script('fwd--failing');
    assert.ok(!out.includes('never-token'), out);
    const object = JSON.parse(out) as { content: [unknown, { refId: string }]; structuredContent: unknown; isError: boolean };
    assert.deepEqual(object, {
      content: [{ type: 'text', text: 'partly attached' }, { type: 'resource', refId: object.content[1].refId, name: 'sealed.pdf', savedTo: null, unfetchable: `it's ${UNBOUND_REASON}` }],
      structuredContent: { partial: true },
      isError: true,
    });
  });
});

test("a module's structured content reaches a script whole, a reference in it included, while its blocks are treated", async () => {
  await withPeers(async ({ script, forward }) => {
    const inStructured = { type: 'resource', uri: 'https://files.example.invalid/structured/sealed.pdf?sig=structured-token', disposition: 'never' };
    forward.nested = [never('module-structured')];
    forward.nestedStructured = { attachment: inStructured };
    const object = JSON.parse(await script('fwd--nested')) as { content: [{ refId?: string; uri?: string }]; structuredContent: unknown };
    assert.equal(object.content[0].uri, undefined, 'the block is its stub');
    assert.deepEqual(object.structuredContent, { attachment: inStructured }, 'RFC-005 governs content blocks, so the structured view is as the module gave it');
  });
});

test("a module's structured blocks that JSON can't convert reach a script as a failure naming the tool", async () => {
  await withPeers(async ({ exit }) => {
    const object = JSON.parse(await exit({ success: true, data: [{ type: 'text', text: 'a count', count: BigInt(1) }], structured: {} }, 'fwd--whole', false)) as {
      content: [{ text: string }]; structuredContent: unknown; isError: boolean;
    };
    assert.equal(object.isError, true);
    assert.equal(object.structuredContent, null);
    assert.match(object.content[0].text, /^tool 'fwd--whole' returned a result that can't be converted to JSON/);
  });
});

test("an MCPL peer's structured blocks too deep to convert to JSON reach a script as a failure naming the tool, the call completed", async () => {
  await withPeers(async ({ answer, script, observe }) => {
    const seen = observe();
    // JSON.stringify overflows the stack past some depth where JSON.parse
    // doesn't: on Node 24.19 an array 5,000 deep does, on Bun 1.4.4 one
    // 200,000 deep. This one is 200,000 deep, for both.
    let deep: unknown = 'bottom';
    for (let i = 0; i < 200_000; i++) deep = [deep];
    answer({ content: [{ type: 'text', text: 'a deep report', deep }], structuredContent: {} });
    // The host's log gets the line the script gets (unconvertibleScriptResult).
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let out = '';
    try {
      out = await script('mcpl--files--attach');
    } finally {
      console.error = consoleError;
    }
    const object = JSON.parse(out) as {
      content: [{ text: string }]; structuredContent: unknown; isError: boolean;
    };
    assert.equal(object.isError, true);
    assert.equal(object.structuredContent, null);
    // The reason is the overflow the guard caught, in both runtimes' words.
    assert.match(object.content[0].text, /^tool 'mcpl--files--attach' returned a result that can't be converted to JSON, so the script can't receive it \(Maximum call stack size exceeded\.?\)\. The call itself completed\.$/);
    assert.deepEqual(logged.filter((line) => line.startsWith('[code_execution] ')), [`[code_execution] ${object.content[0].text}`]);
    // No failed dispatch: only the script lane's treatment failed, so the
    // trace and the call's terminal read the peer's own answer, a success,
    // as on v0.26.1.
    assert.deepEqual(seen.outcomes, [{ type: 'tool:completed' }]);
    assert.deepEqual(seen.lifecycle.filter(([method]) => method === 'markDispatchFailure'), []);
    const terminals = seen.lifecycle.filter(([method]) => method === 'onResult').map(([, , , result]) => result as ToolResult);
    assert.deepEqual(terminals.map((r) => [r.success, r.isError === true, r.data]), [[true, false, []]]);
    // A failing answer that deep keeps the peer's own error, as the exit's
    // answer to any failing result it can't convert does.
    answer({ content: [{ type: 'text', text: 'the vault refused', deep }], structuredContent: {}, isError: true });
    const failing = JSON.parse(await script('mcpl--files--attach')) as { content: [{ text: string }]; isError: boolean };
    assert.equal(failing.isError, true);
    assert.match(failing.content[0].text, /\. The call itself completed, with this error: the vault refused$/);
    // Its trace and terminal read the peer's error answer, with no blocks,
    // and no failed dispatch is marked for either call.
    assert.deepEqual(seen.outcomes[1], { type: 'tool:failed', error: 'the vault refused' });
    assert.deepEqual(seen.lifecycle.filter(([method]) => method === 'markDispatchFailure'), []);
    const both = seen.lifecycle.filter(([method]) => method === 'onResult').map(([, , , result]) => result as ToolResult);
    assert.deepEqual(both.map((r) => [r.success, r.isError === true, r.data]), [[true, false, []], [false, true, []]]);
  });
});

test("a RangeError from serializing an MCPL peer's blocks, as a result past the runtime's longest string gives, reaches a script as a result it can't convert", async () => {
  await withPeers(async ({ answer, script, observe }) => {
    const seen = observe();
    // A result past the runtime's longest string makes JSON.stringify throw
    // a RangeError ("Invalid string length" on V8), and a test can't build
    // one in memory. A toJSON that JSON.stringify calls, and that throws
    // that error, stands in for it: the throw comes from inside the
    // serializer, as the real one does, and isn't the overflow's.
    const tooLong = { toJSON(): never { throw new RangeError('Invalid string length'); } };
    answer({ content: [{ type: 'text', text: 'a long report', tooLong }], structuredContent: {} });
    const object = JSON.parse(await script('mcpl--files--attach')) as { content: [{ text: string }]; isError: boolean };
    assert.equal(object.isError, true);
    assert.equal(object.content[0].text, "tool 'mcpl--files--attach' returned a result that can't be converted to JSON, so the script can't receive it (Invalid string length). The call itself completed.");
    assert.deepEqual(seen.outcomes, [{ type: 'tool:completed' }]);
    assert.deepEqual(seen.lifecycle.filter(([method]) => method === 'markDispatchFailure'), []);
  });
});

test("a nested never decides over a plain reference to its uri at the top, for a link at the top or nested, from a peer or a module", { timeout: 30_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    // The top-level blocks alone claim nothing that withholds the uri, so
    // only a reading of the claims the whole view shows (scriptViewClaims)
    // keeps it from the link. Each link comes before the references, so a
    // registry that read them as it went wouldn't have them yet.
    // A uri of its own for each route, so neither finds the other's
    // references in the registry.
    const content = (route: string, where: string) => {
      const uri = `https://elsewhere.example.invalid/strictest-${route}-${where}/plain.csv`;
      const link = { type: 'resource_link', uri, name: 'plain.csv' };
      return [
        where === 'top' ? link : { type: 'text', text: 'a nested link', link },
        { type: 'resource', uri, name: 'plain.csv' },
        { type: 'text', text: 'sealed', attachment: { type: 'resource', uri, name: 'plain.csv', disposition: 'never' } },
      ];
    };
    for (const where of ['top', 'nested']) {
      answer({ content: content('peer', where), structuredContent: {} });
      const fromPeer = await script('mcpl--files--attach');
      const fromModule = await exit({ success: true, data: content('module', where), structured: {} }, 'fwd--whole', false);
      for (const out of [fromPeer, fromModule]) {
        assert.ok(!out.includes('elsewhere.example.invalid'), `${where}: ${out}`);
        // The view was written, each block in it, the link as its object.
        const object = JSON.parse(out) as { content: Array<Record<string, unknown>>; isError: boolean };
        assert.equal(object.isError, false, out);
        assert.equal(object.content.length, 3, out);
        const link = (where === 'top' ? object.content[0] : object.content[0]!.link) as Record<string, unknown>;
        assert.equal(link.type, 'resource_link', out);
        assert.match(String(link.refId), /^ref_/, out);
        assert.equal(link.uri, undefined, out);
      }
    }
  });
});

test("a link's uri reaches a script only where the model's line shows it: a nested expiry, which makes the link unfetchable, doesn't show it", { timeout: 30_000 }, async () => {
  await withPeers(async ({ answer, script, modelCall }) => {
    // On the server's origin and with no credential in it, so the host can
    // fetch it, and the model's line, reading the top-level blocks, shows no
    // uri. A reference nested in another block's field says the uri has
    // expired, which a script's view reads: the host couldn't fetch it then,
    // and a link it can't fetch shows its uri, so reading more claims would
    // show the script what the line withholds (Ada-1017, room-203 #201013).
    const uri = 'https://files.example.invalid/line-claims/report.csv';
    const content = () => [
      { type: 'resource_link', uri, name: 'report.csv' },
      { type: 'text', text: 'an old copy', attachment: { type: 'resource', uri, name: 'report.csv', expiresAt: '2000-01-01T00:00:00Z' } },
    ];
    answer({ content: content(), structuredContent: {} });
    // The model's line for the same result, as history stores it.
    const line = nonErrorResultText(await modelCall('attach'));
    assert.match(line, /report\.csv/);
    assert.ok(!line.includes('line-claims'), line);
    answer({ content: content(), structuredContent: {} });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('line-claims'), out);
    const object = JSON.parse(out) as { content: Array<Record<string, unknown>>; isError: boolean };
    assert.equal(object.isError, false);
    // Its words still read the view's claims: a fetch with its id would be refused.
    assert.equal(object.content[0]!.expired, EXPIRY_REASON.passed);
  });
});

test("an MCPL peer's script-demand fetch reads the view's claims: a nested expiry isn't fetched, and a view that can't be read fetches nothing", async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    // A reference the demand fetch would save, and a reference nested in
    // another block that says its uri has expired, which only a reading of
    // the whole view's claims sees (Ada-1017, room-203 #201013).
    const expiredNested = blocks('nested-expiry')[0] as { uri: string };
    answer({
      content: [expiredNested, { type: 'text', text: 'an old copy', attachment: { type: 'resource', uri: expiredNested.uri, expiresAt: '2000-01-01T00:00:00Z' } }],
      structuredContent: {},
    });
    const object = JSON.parse(await script('mcpl--files--attach')) as { content: Array<Record<string, unknown>>; isError: boolean };
    assert.equal(object.isError, false);
    assert.deepEqual(fetched, [], 'the uri a nested reference calls expired was not fetched');
    assert.equal(object.content[0]!.expired, EXPIRY_REASON.passed);
    // A view whose claims walk stops isn't written, and nothing is fetched for it first.
    const stuck = { get type(): string { throw new RangeError('Maximum call stack size exceeded'); } };
    answer({ content: [blocks('stopped-walk')[0], { type: 'text', text: 'deep', deep: stuck }], structuredContent: {} });
    const failed = JSON.parse(await script('mcpl--files--attach')) as { content: [{ text: string }]; isError: boolean };
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /can't be converted to JSON/);
    assert.deepEqual(fetched, [], 'nothing was fetched for a view that was never written');
  });
});

test("a nested link's uri doesn't turn on the order of the blocks: a reference nested before it doesn't change what its line reads", { timeout: 30_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    // Fetchable, so the line, reading no claim of this result for the uri,
    // shows no uri. A nested expired reference registered before the link,
    // as the treatment's own pass registers what it shows, would make the
    // record unfetchable for the link and show its uri, in one order only.
    for (const [i, order] of ([['expired', 'link'], ['link', 'expired']] as const).entries()) {
      const uri = `https://files.example.invalid/block-order-${i}/report.csv`;
      const fields: Record<string, unknown> = {};
      for (const name of order) {
        fields[name] = name === 'link'
          ? { type: 'resource_link', uri, name: 'report.csv' }
          : { type: 'resource', uri, name: 'report.csv', expiresAt: '2000-01-01T00:00:00Z' };
      }
      const content = [{ type: 'text', text: 'two attachments', ...fields }];
      answer({ content, structuredContent: {} });
      const fromPeer = await script('mcpl--files--attach');
      assert.ok(!fromPeer.includes(`block-order-${i}`), `${order.join(' then ')}: ${fromPeer}`);
      const view = JSON.parse(fromPeer) as { content: Array<Record<string, Record<string, unknown>>>; isError: boolean };
      assert.deepEqual([view.isError, typeof view.content[0]!.link!.refId, 'uri' in view.content[0]!.link!], [false, 'string', false], fromPeer);
    }
    // An earlier result's never, which a later result's plain reference,
    // nested before the link, would clear on the record.
    const sealedUri = 'https://elsewhere.example.invalid/order-never/report.csv';
    answer({ content: [{ type: 'resource', uri: sealedUri, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
    await script('mcpl--files--attach');
    const later = [{ type: 'text', text: 'again', plain: { type: 'resource', uri: sealedUri, name: 'report.csv' }, link: { type: 'resource_link', uri: sealedUri, name: 'report.csv' } }];
    answer({ content: later, structuredContent: {} });
    const out = await script('mcpl--files--attach');
    // The view reads the result's plain reference, the latest word, so its
    // never no longer holds there; the line, which shows neither, reads the
    // record as it stood, and withholds the uri; so does the script.
    assert.ok(!out.includes('order-never'), out);
    const view = JSON.parse(out) as { content: Array<Record<string, Record<string, unknown>>>; isError: boolean };
    assert.deepEqual([view.isError, typeof view.content[0]!.link!.refId], [false, 'string'], out);
    // A module's result the same way, for a uri of its own, in both orders.
    for (const [i, nestedFirst] of [true, false].entries()) {
      const moduleUri = `https://elsewhere.example.invalid/order-never-module-${i}/report.csv`;
      answer({ content: [{ type: 'resource', uri: moduleUri, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
      await script('mcpl--files--attach');
      const plain = { type: 'resource', uri: moduleUri, name: 'report.csv' };
      const link = { type: 'resource_link', uri: moduleUri, name: 'report.csv' };
      const block = nestedFirst ? { type: 'text', text: 'again', plain, link } : { type: 'text', text: 'again', link, plain };
      const fromModule = await exit({ success: true, data: [block], structured: {} }, 'fwd--whole', false);
      assert.ok(!fromModule.includes(`order-never-module-${i}`), fromModule);
      const moduleView = JSON.parse(fromModule) as { content: Array<Record<string, Record<string, unknown>>>; isError: boolean };
      assert.deepEqual([moduleView.isError, typeof moduleView.content[0]!.link!.refId], [false, 'string'], fromModule);
    }
  });
});

test("a link's uri reads its record as it stood before the script lane registered anything, through an eviction the treatment's own registrations make", { timeout: 60_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    for (const route of ['peer', 'module'] as const) {
      // An earlier result marks the uri never; off the server's origin, so a
      // link to it with no such claim shows its uri.
      const uri = `https://elsewhere.example.invalid/evicted-${route}/report.csv`;
      answer({ content: [{ type: 'resource', uri, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
      await script('mcpl--files--attach');
      // More references nested before the link than the registry holds, so
      // the treatment evicts the uri's record before it reaches the link.
      const many = Array.from({ length: 2001 }, (_, i) => ({ type: 'resource', uri: `https://files.example.invalid/many-${route}/${i}.csv`, name: `${i}.csv` }));
      const content = [{ type: 'text', text: 'many attachments', many, link: { type: 'resource_link', uri, name: 'report.csv' } }];
      let out: string;
      if (route === 'peer') {
        answer({ content, structuredContent: {} });
        out = await script('mcpl--files--attach');
      } else {
        out = await exit({ success: true, data: content, structured: {} }, 'fwd--whole', false);
      }
      assert.ok(!out.includes(`evicted-${route}/report.csv`), `${route}: ${out.slice(-600)}`);
      const view = JSON.parse(out) as { content: Array<Record<string, Record<string, unknown>>>; isError: boolean };
      assert.deepEqual([view.isError, typeof view.content[0]!.link!.refId], [false, 'string'], route);
      // The never record was evicted: the uri's record now is the link's own.
      assert.equal(referenceRegistry.findByUri(uri)?.testimony.fromLink, true, route);
      assert.equal(referenceRegistry.journalCount, 0, `${route}: the lane closed its journal`);
    }
  });
});

/** A testimony, as the classifier reads a block. */
const testimonyOf = (block: Record<string, unknown>): ReferenceTestimony => (classifyBlock(block) as { testimony: ReferenceTestimony }).testimony;

/** Make `uri`'s record the registry's oldest, with the registry full: it
 *  holds 2,000, so 1,999 new records after it take the place of every older
 *  one. */
const fillAfter = (tag: string): void => {
  for (let i = 0; i < 1999; i++) referenceRegistry.register(testimonyOf({ type: 'resource', uri: `https://files.example.invalid/fill-${tag}/${i}.csv`, name: `${i}.csv` }));
};

test("a module's result a script reads as text registers its links in the result's order, so a later reference keeps the model's line's never on a link before it", { timeout: 60_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    const uri = 'https://elsewhere.example.invalid/text-order/report.csv';
    answer({ content: [{ type: 'resource', uri, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
    await script('mcpl--files--attach');
    fillAfter('text-order');
    // The model's render reaches the link first, which keeps its record, and
    // then registers the new reference, which evicts another.
    const data = [
      { type: 'resource_link', uri, name: 'report.csv' },
      { type: 'resource', uri: 'https://files.example.invalid/text-order/new.csv', name: 'new.csv' },
    ];
    const out = await exit({ success: true, data }, 'fwd--whole', false);
    assert.ok(!out.includes('text-order/report.csv'), out);
    const reply = JSON.parse(out) as { content: [{ text: string }]; isError: boolean };
    assert.equal(reply.isError, false, out);
    // The link's line rendered, as the withheld stub that names it.
    assert.match(reply.content[0].text, /^\[ref_\w+\] report\.csv/m, out);
    assert.equal(referenceRegistry.findByUri(uri)?.testimony.disposition, 'never');
  });
});

test("a module's view reads the registry as the model's line leaves it: where the result's own reference evicts an earlier never before its link, script and line both show the uri", { timeout: 60_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    // The demand loop registers the result's blocks in the order the model's
    // render does, so the new reference evicts the never record before the
    // link, for both: an earlier result's never lasts as long as the registry
    // keeps it (Ada-1017, room-203 #203011).
    const uri = 'https://elsewhere.example.invalid/view-evicted/report.csv';
    const data = () => [
      { type: 'resource', uri: 'https://files.example.invalid/view-evicted/new.csv', name: 'new.csv' },
      { type: 'resource_link', uri, name: 'report.csv' },
    ];
    const seed = async (): Promise<void> => {
      answer({ content: [{ type: 'resource', uri, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
      await script('mcpl--files--attach');
    };
    await seed();
    fillAfter('view-evicted-line');
    const line = nonErrorResultText({ data: data() });
    assert.ok(line.includes('view-evicted/report.csv'), line);
    await seed();
    fillAfter('view-evicted-script');
    const out = await exit({ success: true, data: data(), structured: {} }, 'fwd--whole', false);
    const link = (JSON.parse(out) as { content: Array<Record<string, unknown>> }).content[1]!;
    assert.equal(link.uri, uri, out);
    assert.equal(referenceRegistry.journalCount, 0);
  });
});

test("a module's array the model's line walks at depth keeps its never on a nested link the walk reaches before a later top-level one, as a script reads it", { timeout: 90_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    // Not a content array, so the model's line walks it depth-first: it
    // reaches the nested link first, which keeps its record, and then the
    // later top-level link, whose registration evicts another.
    const uri = 'https://elsewhere.example.invalid/walk-order/report.csv';
    const data = () => [
      { wrap: { type: 'resource_link', uri, name: 'report.csv' } },
      { type: 'resource_link', uri: 'https://files.example.invalid/walk-order/new.csv', name: 'new.csv' },
    ];
    const seed = async (tag: string): Promise<void> => {
      answer({ content: [{ type: 'resource', uri, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
      await script('mcpl--files--attach');
      fillAfter(`walk-order-${tag}`);
    };
    await seed('line');
    const line = nonErrorResultText({ data: data() });
    assert.ok(!line.includes('walk-order/report.csv'), line);
    for (const structured of [true, false]) {
      await seed(structured ? 'view' : 'text');
      const out = await exit({ success: true, data: data(), ...(structured ? { structured: {} } : {}) }, 'fwd--whole', false);
      assert.ok(!out.includes('walk-order/report.csv'), `${structured ? 'view' : 'text'}: ${out}`);
      const reply = JSON.parse(out) as { content: Array<Record<string, Record<string, unknown>> & { text?: string }>; isError: boolean };
      assert.equal(reply.isError, false, out);
      // The nested link was shown, as its object or its stub, not dropped.
      if (structured) assert.equal(typeof reply.content[0]!.wrap!.refId, 'string', out);
      else assert.match(String(reply.content[0]!.text), /\[ref_\w+\] report\.csv/, out);
    }
    assert.equal(referenceRegistry.journalCount, 0);
  });
});

test("a module's array the model's line walks at depth reads its records from before the demand loop, so the loop's own reference can't evict a never the view's nested link keeps", { timeout: 60_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    // The later top-level element is a reference, which the loop registers,
    // in a full registry evicting the never record; the journal, open before
    // the loop for data the line walks at depth, keeps it.
    const uri = 'https://elsewhere.example.invalid/walk-resource/report.csv';
    answer({ content: [{ type: 'resource', uri, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
    await script('mcpl--files--attach');
    fillAfter('walk-resource');
    const data = [
      { wrap: { type: 'resource_link', uri, name: 'report.csv' } },
      { type: 'resource', uri: 'https://files.example.invalid/walk-resource/new.csv', name: 'new.csv' },
    ];
    const out = await exit({ success: true, data, structured: {} }, 'fwd--whole', false);
    assert.ok(!out.includes('walk-resource/report.csv'), out);
    const view = JSON.parse(out) as { content: Array<Record<string, Record<string, unknown>>>; isError: boolean };
    assert.deepEqual([view.isError, typeof view.content[0]!.wrap!.refId], [false, 'string'], out);
    assert.equal(referenceRegistry.findByUri(uri)?.testimony.fromLink, true, 'the loop evicted the never record');
    assert.equal(referenceRegistry.journalCount, 0);
  });
});

test("a module's array its result says is content has its links registered in order, an unknown block among them", { timeout: 60_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    // Content by the result's own flag, though one element is of no MCP
    // type: the model's render shows it block by block, so the loop
    // registers the link first, as the render does, keeping its record.
    const uri = 'https://elsewhere.example.invalid/flag-order/report.csv';
    answer({ content: [{ type: 'resource', uri, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
    await script('mcpl--files--attach');
    fillAfter('flag-order');
    const data = [
      { type: 'resource_link', uri, name: 'report.csv' },
      { type: 'resource', uri: 'https://files.example.invalid/flag-order/new.csv', name: 'new.csv' },
      { type: 'zz-unknown', value: 1 },
    ];
    const out = await exit({ success: true, data, dataIsContent: true } as ToolResult, 'fwd--whole', false);
    assert.ok(!out.includes('flag-order/report.csv'), out);
    assert.equal((JSON.parse(out) as { isError: boolean }).isError, false, out);
    assert.equal(referenceRegistry.findByUri(uri)?.testimony.disposition, 'never');
  });
});

test("a module's failed result, whose model's line is its error and registers nothing, keeps a never its blocks' registrations would evict, as a script reads it", { timeout: 60_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    const uri = 'https://elsewhere.example.invalid/error-order/report.csv';
    answer({ content: [{ type: 'resource', uri, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
    await script('mcpl--files--attach');
    fillAfter('error-order');
    const data = [
      { type: 'resource', uri: 'https://files.example.invalid/error-order/new.csv', name: 'new.csv' },
      { type: 'resource_link', uri, name: 'report.csv' },
    ];
    const out = await exit({ success: false, isError: true, error: 'the attach failed', data, structured: {} } as unknown as ToolResult, 'fwd--whole', false);
    const view = JSON.parse(out) as { content: Array<Record<string, unknown>>; isError: boolean };
    assert.equal(view.isError, true, out);
    assert.ok(!out.includes('error-order/report.csv'), out);
    assert.equal(typeof view.content[1]!.refId, 'string', out);
    assert.equal(referenceRegistry.journalCount, 0);
  });
});

test("a link's line reads its record's server binding as it stood before an eviction the treatment makes, so a link the host could fetch shows a script no uri", { timeout: 60_000 }, async () => {
  await withPeers(async ({ answer, script, exit }) => {
    // Bound to the files server, on its origin, by the peer's dispatch.
    const uri = 'https://files.example.invalid/bound-evicted/report.csv';
    answer({ content: [{ type: 'resource', uri, name: 'report.csv' }], structuredContent: {} });
    await script('mcpl--files--attach');
    assert.deepEqual(referenceRegistry.findByUri(uri)?.serverIds, ['files']);
    // A module's nested references, registered with no server, evict it
    // before the link, whose own registration then makes it unbound.
    const many = Array.from({ length: 2001 }, (_, i) => ({ type: 'resource', uri: `https://files.example.invalid/bound-many/${i}.csv`, name: `${i}.csv` }));
    const out = await exit({ success: true, data: [{ type: 'text', text: 'many', many, link: { type: 'resource_link', uri, name: 'report.csv' } }], structured: {} }, 'fwd--whole', false);
    assert.ok(!out.includes('bound-evicted/report.csv'), out.slice(-600));
    assert.deepEqual(referenceRegistry.findByUri(uri)?.serverIds, [], 'evicted, and made again unbound');
    const view = JSON.parse(out) as { content: Array<Record<string, Record<string, unknown>>> };
    assert.equal(typeof view.content[0]!.link!.refId, 'string');
  });
});

test("an earlier result's never on one uri doesn't withhold, from a script, a link to another that shows as the same text, where the model's line shows it", { timeout: 30_000 }, async () => {
  await withPeers(async ({ answer, script, modelCall }) => {
    // Each record speaks for its own uri: the earlier never is the marked
    // uri's, and the link names the clean one, whose record has none.
    const marked = 'https://elsewhere.example.invalid/cut-history/\u200Freport.csv';
    const clean = 'https://elsewhere.example.invalid/cut-history/report.csv';
    answer({ content: [{ type: 'resource', uri: marked, name: 'report.csv', disposition: 'never' }], structuredContent: {} });
    await script('mcpl--files--attach');
    const content = () => [
      { type: 'text', text: 'again', attachment: { type: 'resource', uri: marked, name: 'report.csv' } },
      { type: 'resource_link', uri: clean, name: 'report.csv' },
    ];
    answer({ content: content(), structuredContent: {} });
    const line = nonErrorResultText(await modelCall('attach'));
    assert.ok(line.includes('cut-history/report.csv'), line);
    answer({ content: content(), structuredContent: {} });
    const out = await script('mcpl--files--attach');
    const link = (JSON.parse(out) as { content: Array<Record<string, unknown>> }).content[1]!;
    assert.equal(link.uri, clean, out);
  });
});

test("an MCPL peer's result a script reads as text has its demand fetch read each top-level block's own expiry, as a model's call does, not a view it never gets", async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    // No structured content: the script reads the model lane's text, whose
    // stubs read the top-level blocks' claims, so a reference nested in a
    // block's field, which the text doesn't show, stops no fetch.
    const top = blocks('text-route')[0] as { uri: string };
    answer({ content: [top, { type: 'text', text: 'an old copy', attachment: { type: 'resource', uri: top.uri, expiresAt: '2000-01-01T00:00:00Z' } }] });
    const out = await script('mcpl--files--attach');
    assert.deepEqual(fetched, [top.uri]);
    assert.ok(out.includes(SAVED), out);
  });
});

test("an MCPL peer's view reads the claims its dispatch read for the demand fetch, not a second reading of its blocks", { timeout: 30_000 }, async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    // A nested reference that says never until the demand fetch has run, as
    // only a value read twice could: a view that read its claims again would
    // see none, and show the link's uri.
    const uri = 'https://elsewhere.example.invalid/read-once/report.csv';
    const sealed = { type: 'resource', uri, name: 'report.csv', get disposition(): string | undefined { return fetched.length === 0 ? 'never' : undefined; } };
    answer({
      content: [blocks('read-once')[0], { type: 'text', text: 'sealed', sealed }, { type: 'resource_link', uri, name: 'report.csv' }],
      structuredContent: {},
    });
    const out = await script('mcpl--files--attach');
    assert.equal(fetched.length, 1, 'the demand fetch ran between the two readings');
    assert.ok(!out.includes('read-once/report.csv'), out);
    const view = JSON.parse(out) as { content: Array<Record<string, unknown>>; isError: boolean };
    assert.deepEqual([view.isError, view.content.length, typeof view.content[2]!.refId], [false, 3, 'string'], out);
  });
});

test("inline data's expiry claims nothing for a link to its uri, which the host can fetch, so the link shows no uri", { timeout: 30_000 }, async () => {
  await withPeers(async ({ answer, script, modelCall }) => {
    // Fetchable, so only an expiry claimed for the uri would make it a link
    // the host can't fetch, whose uri shows. Inline data's claims beside its
    // data count for nothing but never (Ada-1017, room-203 #201013).
    const uri = 'https://files.example.invalid/inline-expiry/report.csv';
    const content = () => [
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri, disposition: 'ref', expiresAt: '2000-01-01T00:00:00Z' },
      { type: 'resource_link', uri, name: 'report.csv' },
    ];
    answer({ content: content(), structuredContent: {} });
    const line = nonErrorResultText(await modelCall('attach'));
    assert.ok(!line.includes('inline-expiry'), line);
    answer({ content: content(), structuredContent: {} });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('inline-expiry'), out);
    const view = JSON.parse(out) as { content: Array<Record<string, unknown>>; isError: boolean };
    assert.deepEqual([view.isError, typeof view.content[1]!.refId], [false, 'string'], out);
  });
});

test("a never nested where only the script's view reads it withholds a link whose uri shows as the same text", { timeout: 30_000 }, async () => {
  await withPeers(async ({ answer, script, modelCall }) => {
    // Off the server's origin, so the line, which reads the top-level blocks
    // alone, shows the link's uri; the view reads the nested never, found by
    // the text the link shows.
    const uri = 'https://elsewhere.example.invalid/view-cut/report.csv';
    const content = () => [
      { type: 'text', text: 'sealed', attachment: { type: 'resource', uri, name: 'report.csv', disposition: 'never' } },
      { type: 'resource_link', uri: 'https://elsewhere.example.invalid/view-cut/\u200Freport.csv', name: 'report.csv' },
    ];
    answer({ content: content(), structuredContent: {} });
    const line = nonErrorResultText(await modelCall('attach'));
    assert.ok(line.includes('view-cut/report.csv'), line);
    answer({ content: content(), structuredContent: {} });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('view-cut'), out);
    const link = (JSON.parse(out) as { content: Array<Record<string, unknown>> }).content[1]!;
    assert.deepEqual(['uri' in link, typeof link.refId], [false, 'string'], out);
  });
});

test("an expiry on one uri says nothing of a link to another that shows as the same text, which the host can fetch", { timeout: 30_000 }, async () => {
  await withPeers(async ({ answer, script, modelCall }) => {
    // Only a `never` is found by the text a link shows; an expiry is about the
    // record, which the fetch reads by its raw uri (Ada-1017, room-203
    // #202239). Read by the text, this expiry would make the link one the
    // host can't fetch, showing its uri and words saying so.
    const uri = 'https://files.example.invalid/expiry-cut/report.csv';
    const content = () => [
      { type: 'resource', uri, name: 'old.csv', expiresAt: '2000-01-01T00:00:00Z' },
      { type: 'resource_link', uri: 'https://files.example.invalid/expiry-cut/\u200Freport.csv', name: 'report.csv' },
    ];
    answer({ content: content(), structuredContent: {} });
    const line = nonErrorResultText(await modelCall('attach'));
    assert.ok(!line.includes('expiry-cut'), line);
    answer({ content: content(), structuredContent: {} });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('expiry-cut'), out);
    const link = (JSON.parse(out) as { content: Array<Record<string, unknown>> }).content[1]!;
    assert.deepEqual(['uri' in link, 'unfetchable' in link, 'expired' in link, typeof link.refId], [false, false, false, 'string'], out);
  });
});

test("an MCPL peer's top-level link, treated once, keeps the record of the uri its result named, whatever sanitizeLabel cut from the uri it shows", async () => {
  await withPeers(async ({ answer, script }) => {
    // Off the server's origin, so its uri is shown, cut of its bidi override.
    // The nested pass leaves the top-level blocks to the treatment above it,
    // so the link's object isn't read again as a link to the cut uri.
    const raw = 'https://elsewhere.example.invalid/re\u202Eport.csv';
    answer({ content: [{ type: 'resource_link', uri: raw, name: 'report.csv' }], structuredContent: {} });
    const object = JSON.parse(await script('mcpl--files--attach')) as { content: Array<Record<string, unknown>> };
    assert.equal(object.content[0]!.uri, 'https://elsewhere.example.invalid/report.csv');
    assert.equal(object.content[0]!.refId, referenceRegistry.findByUri(raw)?.refId);
    assert.equal(referenceRegistry.findByUri('https://elsewhere.example.invalid/report.csv'), undefined);
  });
});

test("where the treatment fails after the claims walk read the view, a peer's result is one the script can't convert and a module's a failure naming the tool", async () => {
  await withPeers(async ({ answer, script, exit }) => {
    // The claims walk reads a reference and registers nothing; the treatment
    // registers what it shows. A registry that throws a RangeError for one
    // nested reference stands in for a treatment that runs out of stack where
    // the claims walk, with lighter replacers, didn't.
    const uri = 'https://files.example.invalid/treatment-stop/report.csv';
    const real = referenceRegistry.register;
    referenceRegistry.register = function (this: typeof referenceRegistry, ...args: Parameters<typeof real>) {
      if (args[0].uri === uri) throw new RangeError('Maximum call stack size exceeded');
      return real.apply(this, args);
    } as typeof real;
    try {
      const content = () => [{ type: 'text', text: 'a report', attachment: { type: 'resource', uri, name: 'report.csv' } }];
      answer({ content: content(), structuredContent: {} });
      const fromPeer = JSON.parse(await script('mcpl--files--attach')) as { content: [{ text: string }]; isError: boolean };
      assert.equal(fromPeer.isError, true);
      assert.match(fromPeer.content[0].text, /^tool 'mcpl--files--attach' returned a result that can't be converted to JSON/);
      // Each route closed its journal on the way out of the failure too.
      assert.equal(referenceRegistry.journalCount, 0, 'peer');
      const fromModule = JSON.parse(await exit({ success: true, data: content(), structured: {} }, 'fwd--whole', false)) as { content: [{ text: string }]; isError: boolean };
      assert.equal(fromModule.isError, true);
      assert.match(fromModule.content[0].text, /^tool 'fwd--whole' returned a result that can't be converted to JSON/);
      assert.equal(referenceRegistry.journalCount, 0, 'module');
    } finally {
      referenceRegistry.register = real;
    }
  });
});

test("a peer's top-level block the classifier rejects shows none of its fields, so a never among them claims nothing in a script's view", { timeout: 30_000 }, async () => {
  await withPeers(async ({ answer, script }) => {
    const uri = 'https://elsewhere.example.invalid/rejected-fields/plain.csv';
    const content = [
      { type: 'video', uri: 'https://elsewhere.example.invalid/clip.mp4', sealed: { type: 'resource', uri, disposition: 'never' } },
      { type: 'resource', uri, name: 'plain.csv' },
      { type: 'resource_link', uri, name: 'plain.csv' },
    ];
    answer({ content, structuredContent: {} });
    const object = JSON.parse(await script('mcpl--files--attach')) as { content: Array<Record<string, unknown>> };
    assert.equal(object.content[0]!.type, 'text', 'the video is its notice');
    assert.equal(object.content[2]!.uri, uri, 'the view shows no never for the uri, so the link carries it, as the model\'s line shows it');
  });
});

test("where the walk of a script view's claims stops, the view isn't written, though the treatment's own walk would pass", async () => {
  await withPeers(async ({ answer, script, exit }) => {
    // A value that stops the claims walk and not the treatment's: its type
    // throws a RangeError the first time it's read, as a stack can run out
    // one frame sooner in one walk than in the other, and then reads as data.
    const once = () => {
      let read = false;
      return { get type(): string { if (!read) { read = true; throw new RangeError('Maximum call stack size exceeded'); } return 'note'; } };
    };
    const uri = 'https://elsewhere.example.invalid/stopped-walk/plain.csv';
    const content = () => [{ type: 'text', text: 'one link', deep: once(), attachment: { type: 'resource', uri, disposition: 'never' } }, { type: 'resource_link', uri, name: 'plain.csv' }];
    answer({ content: content(), structuredContent: {} });
    const fromPeer = JSON.parse(await script('mcpl--files--attach')) as { content: [{ text: string }]; isError: boolean };
    assert.equal(fromPeer.isError, true);
    assert.match(fromPeer.content[0].text, /^tool 'mcpl--files--attach' returned a result that can't be converted to JSON/);
    // A module's result, as the exit receives it.
    const fromModule = JSON.parse(await exit({ success: true, data: content(), structured: {} }, 'fwd--whole', false)) as { content: [{ text: string }]; isError: boolean };
    assert.equal(fromModule.isError, true);
    assert.match(fromModule.content[0].text, /^tool 'fwd--whole' returned a result that can't be converted to JSON/);
    for (const out of [fromPeer, fromModule]) assert.ok(!JSON.stringify(out).includes('elsewhere.example.invalid'), JSON.stringify(out));
  });
});

test("where the walk of a result's claims stops, a script's text route fails naming the tool, as its structured view does, for an object or a list", async () => {
  await withPeers(async ({ exit }) => {
    // A type that throws a RangeError the first time it's read stops the
    // claims walk only: the render's walk would read it as data.
    const once = () => {
      let read = false;
      return { get type(): string { if (!read) { read = true; throw new RangeError('Maximum call stack size exceeded'); } return 'note'; } };
    };
    // No structured content, so the text route; data that isn't content.
    // No data and an error that can't be read: still a failure, never the
    // model lane's notice (nonErrorResultTextOrThrow).
    const noError = { success: true, data: null, get error(): string { throw new Error('zz-unreadable error'); } };
    const failedRead = JSON.parse(await exit(noError as unknown as ToolResult, 'fwd--whole', false)) as { content: [{ text: string }]; isError: boolean };
    assert.equal(failedRead.isError, true, JSON.stringify(failedRead));
    assert.match(failedRead.content[0].text, /^tool 'fwd--whole' returned a result that can't be converted to JSON/);
    for (const data of [{ deep: once() }, [{ deep: once() }]]) {
      const out = JSON.parse(await exit({ success: true, data }, 'fwd--whole', false)) as { content: [{ text: string }]; isError: boolean };
      assert.equal(out.isError, true, JSON.stringify(out));
      assert.match(out.content[0].text, /^tool 'fwd--whole' returned a result that can't be converted to JSON, so the script can't receive it/);
    }
  });
});

test("a fault in an MCPL peer's round trip other than a RangeError fails the dispatch, as any fault does, with its own message", async () => {
  await withPeers(async ({ answer, script, observe }) => {
    const seen = observe();
    // Wire JSON has neither, so each stands in for a fault: a getter that
    // throws when the treatment reads a nested block's type, and a BigInt,
    // on which JSON.stringify itself throws. Each is a TypeError, not the
    // RangeError of a result too deep or too long to convert.
    const faulty = { get type(): string { throw new TypeError('a nested block\'s type could not be read'); } };
    const faults: Array<[unknown, RegExp]> = [
      [{ type: 'text', text: 'a report', attachment: faulty }, /a nested block's type could not be read/],
      [{ type: 'text', text: 'a count', count: BigInt(1) }, /BigInt/],
    ];
    for (const [i, [block, message]] of faults.entries()) {
      answer({ content: [block], structuredContent: {} });
      const object = JSON.parse(await script('mcpl--files--attach')) as { content: [{ text: string }]; isError: boolean };
      assert.equal(object.isError, true);
      assert.match(object.content[0].text, message);
      assert.doesNotMatch(object.content[0].text, /can't be converted to JSON/);
      assert.equal(seen.lifecycle.filter(([method]) => method === 'markDispatchFailure').length, i + 1);
      assert.equal(seen.outcomes[i]?.type, 'tool:failed');
      assert.match(String((seen.outcomes[i] as { error?: unknown }).error), message);
    }
  });
});

test("a reference nested in an MCPL peer's block reaches a script with savedTo: null, as it isn't fetched", async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    // Both would be saved if fetched (the test's fetcher saves a report.pdf).
    const top = { type: 'resource', uri: 'https://files.example.invalid/top/report.pdf?sig=top-token', name: 'report.pdf', mimeType: 'application/pdf' };
    const nested = { ...top, uri: 'https://files.example.invalid/nested/report.pdf?sig=nested-token' };
    answer({ content: [top, { type: 'text', text: 'see attached', attachment: nested }], structuredContent: {} });
    const [shownTop, block] = (JSON.parse(await script('mcpl--files--attach')) as { content: Array<Record<string, unknown>> }).content;
    assert.equal(shownTop.savedTo, SAVED, 'a top-level reference is fetched for the script');
    const attachment = block.attachment as Record<string, unknown>;
    assert.deepEqual([typeof attachment.refId, attachment.savedTo, 'uri' in attachment], ['string', null, false]);
    assert.deepEqual(fetched, [top.uri], 'the nested reference is registered, not fetched');
  });
});

test("an MCPL peer's inline data beside a uri that isn't a string reaches a script as the withheld notice", async () => {
  await withPeers(async ({ answer, script, modelCall }) => {
    const inline = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: { sig: 'object-token' } };
    answer({ content: [{ type: 'text', text: 'one image' }, inline], structuredContent: { images: 1 } });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('object-token'), out);
    assert.deepEqual((JSON.parse(out) as { content: unknown }).content, [{ type: 'text', text: 'one image' }, { type: 'text', text: INLINE_WITHHELD_TEXT }]);
    // The model's lanes show no uri, so they keep the image.
    const model = JSON.stringify((await modelCall('attach')).data);
    assert.ok(model.includes('iVBORw0KGgo=') && !model.includes(INLINE_WITHHELD_TEXT), model);
  });
});

test("inline data beside an empty uri reaches a script as sent, from a module and from an MCPL peer alike, and beside a disposition is withheld", async () => {
  await withPeers(async ({ answer, script, forward }) => {
    // An empty uri carries nothing a credential could ride on, so it's no
    // uri here, as at any depth (Ada-1017, room-203 #200094).
    const inline = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: '' };
    forward.nested = [inline];
    assert.deepEqual((JSON.parse(await script('fwd--nested')) as { content: unknown }).content, [inline]);
    answer({ content: [inline], structuredContent: {} });
    assert.deepEqual((JSON.parse(await script('mcpl--files--attach')) as { content: unknown }).content, [inline]);
    // A disposition is a reference's claim, so beside one it's withheld,
    // from either, at the top and nested.
    const claiming = { ...inline, disposition: 'never' };
    for (const content of [[claiming], [{ type: 'text', text: 'nested', inline: claiming }]]) {
      answer({ content, structuredContent: {} });
      const fromPeer = JSON.stringify((JSON.parse(await script('mcpl--files--attach')) as { content: unknown }).content);
      forward.nested = content;
      const fromModule = JSON.stringify((JSON.parse(await script('fwd--nested')) as { content: unknown }).content);
      for (const out of [fromPeer, fromModule]) {
        assert.ok(out.includes(INLINE_WITHHELD_TEXT) && !out.includes('iVBORw0KGgo='), out);
      }
    }
  });
});

test("inline data beside a null uri reaches a script as sent, from an MCPL peer and from a module", async () => {
  await withPeers(async ({ answer, script, forward }) => {
    const inline = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: null };
    answer({ content: [inline], structuredContent: {} });
    assert.deepEqual((JSON.parse(await script('mcpl--files--attach')) as { content: unknown }).content, [inline]);
    forward.nested = [inline];
    assert.deepEqual((JSON.parse(await script('fwd--nested')) as { content: unknown }).content, [inline]);
  });
});

test("an MCPL peer's reference nested under another block's fields reaches a script as its stub's facts, bound to the peer, while its structured content stays whole", async () => {
  await withPeers(async ({ answer, script }) => {
    const sealed = never('nested-peer');
    const inline = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: 'https://files.example.invalid/nested-peer/pic.png?sig=inline-token' };
    const text = { type: 'text', text: 'one report', attachment: sealed, deeper: { list: [inline, { note: 'plain data', type: 'note' }] } };
    answer({ content: [text], structuredContent: { attachment: sealed } });
    const object = JSON.parse(await script('mcpl--files--attach')) as { content: Array<Record<string, unknown>>; structuredContent: unknown };
    const [block] = object.content;
    const attachment = block.attachment as Record<string, unknown>;
    assert.deepEqual([block.type, block.text, attachment.type, attachment.name, typeof attachment.refId, 'uri' in attachment], ['text', 'one report', 'resource', 'sealed.pdf', 'string', false]);
    assert.equal(attachment.refId, referenceRegistry.findByUri(sealed.uri)?.refId, 'the stub names the nested reference\'s own record');
    assert.deepEqual(referenceRegistry.findByUri(sealed.uri)?.serverIds, ['files'], 'a nested reference is bound to the peer that sent it');
    // Inline data beside a uri, nested, is withheld; other nested data is as sent.
    assert.deepEqual(block.deeper, { list: [{ type: 'text', text: INLINE_WITHHELD_TEXT }, { note: 'plain data', type: 'note' }] });
    assert.equal(JSON.stringify(object.content).includes('never-token') || JSON.stringify(object.content).includes('inline-token'), false);
    assert.deepEqual(object.structuredContent, { attachment: sealed }, 'structuredContent is the server\'s own data, whole');
  });
});

test("each shape RFC-005 governs, nested in an MCPL peer's block, reaches a script by the peer's reading", async () => {
  await withPeers(async ({ answer, script }) => {
    const embedded = { type: 'resource', resource: { uri: 'https://files.example.invalid/nested-shapes/doc.txt?sig=embedded-token', text: 'the doc' } };
    const byUri = { type: 'image', uri: 'https://files.example.invalid/nested-shapes/pic.png?sig=image-token', mimeType: 'image/png' };
    const emptyUri = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: '' };
    const sealedInline = { type: 'audio', data: 'AAAA', mimeType: 'audio/wav', disposition: 'never' };
    const objectUri = { type: 'resource', uri: { href: 'https://files.example.invalid/nested-shapes/obj?sig=object-token' }, name: 'obj' };
    const text = { type: 'text', text: 'shapes', embedded, byUri, emptyUri, sealedInline, objectUri };
    answer({ content: [text], structuredContent: {} });
    const [block] = (JSON.parse(await script('mcpl--files--attach')) as { content: Array<Record<string, unknown>> }).content;
    // An MCP-form embedded resource is the classifier's invalid block, so its notice, without its text.
    const shownEmbedded = block.embedded as Record<string, unknown>;
    assert.equal(shownEmbedded.type, 'text');
    assert.equal(String(shownEmbedded.text).includes('the doc'), false);
    // A reference by uri alone is a stub bound to the peer.
    const shownByUri = block.byUri as Record<string, unknown>;
    assert.deepEqual([typeof shownByUri.refId, 'uri' in shownByUri], ['string', false]);
    assert.deepEqual(referenceRegistry.findByUri(byUri.uri)?.serverIds, ['files']);
    // An empty uri beside inline data is no uri, on a peer's lane as on a
    // module's (Ada-1017, room-203 #200094).
    assert.deepEqual(block.emptyUri, emptyUri);
    // Inline data claiming only a disposition is withheld, and a uri that isn't a string is the classifier's notice.
    assert.deepEqual(block.sealedInline, { type: 'text', text: INLINE_WITHHELD_TEXT });
    assert.equal((block.objectUri as Record<string, unknown>).type, 'text');
    assert.equal(/embedded-token|image-token|object-token/.test(JSON.stringify(block)), false);
  });
});

test("an MCPL peer's block already in the script lane's shapes is left as it is by the nested pass", async () => {
  await withPeers(async ({ answer, script }) => {
    // A stub's facts and a notice aren't governed, so neither is read twice.
    const stub = { type: 'resource', refId: 'ref_9_abcd', name: 'sealed.pdf', mimeType: 'application/pdf', savedTo: null };
    const notice = { type: 'text', text: INLINE_WITHHELD_TEXT };
    const text = { type: 'text', text: 'already treated', attachment: stub, withheld: notice };
    answer({ content: [text, notice], structuredContent: {} });
    assert.deepEqual((JSON.parse(await script('mcpl--files--attach')) as { content: unknown }).content, [text, notice]);
  });
});
