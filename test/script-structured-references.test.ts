/**
 * What a script receives from a tool whose result carries structuredContent,
 * through the real dispatch. An MCPL peer's content blocks get the treatment
 * RFC-005 gives them on every lane the model reads, since what a script prints
 * comes back to the model: a reference arrives without its URI, as the host's
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
import { EXPIRY_REASON, INLINE_WITHHELD_TEXT, referenceRegistry } from '../src/mcpl/references.js';
import type { ReferenceRecord } from '../src/mcpl/references.js';
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
    digest: DIGEST, expiresAt: '2026-12-31T00:00:00Z' },
  // The same reference again, saying something else about itself.
  { type: 'resource', uri: uris(test).report, name: 'report-copy.pdf' },
  // A reference the fetch doesn't save.
  { type: 'image', uri: uris(test).big, mimeType: 'image/png', disposition: 'ref', expiresAt: '2027-01-01T00:00:00Z' },
  // Inline data that claims a bulk disposition, and inline data with a uri
  // beside it: withheld.
  { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', disposition: 'ref' },
  { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav', uri: 'https://files.example.invalid/beside?sig=beside-token' },
  // Inline data that claims nothing.
  { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
  // Blocks the classifier rejects: a uri longer than its limit (4096 UTF-16
  // units), an MCP embedded resource (its uri nested), and a type RFC-005
  // doesn't define.
  { type: 'resource', uri: `https://files.example.invalid/long?sig=${'s'.repeat(4096)}`, name: 'long' },
  { type: 'resource', resource: { uri: 'https://files.example.invalid/embedded?sig=embedded-token', mimeType: 'text/plain', text: 'embedded' } },
  { type: 'resource_link', uri: 'https://files.example.invalid/link?sig=link-token', name: 'link' },
  { type: 'text', text: 'two attachments' },
  // A reference that counts as expired: with a bidi override after it, its
  // expiresAt doesn't parse, so it fails closed. It isn't fetched, and the
  // script is told why.
  { type: 'image', uri: uris(test).old, mimeType: 'image/png', expiresAt: '2027-01-01T00:00:00Z\u202E' },
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
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What a script reads for those blocks from an MCPL peer, given each reference's id. */
const treated = (report: string, big: string, old: string) => [
  { type: 'resource', refId: report, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1234, digest: DIGEST,
    expiresAt: '2026-12-31T00:00:00Z', savedTo: SAVED },
  { type: 'resource', refId: report, name: 'report-copy.pdf', savedTo: SAVED },
  { type: 'image', refId: big, mimeType: 'image/png', expiresAt: '2027-01-01T00:00:00Z', savedTo: null },
  { type: 'text', text: INLINE_WITHHELD_TEXT },
  { type: 'text', text: INLINE_WITHHELD_TEXT },
  { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
  { type: 'text', text: '[Reference not shown: its link is longer than this host accepts.]' },
  { type: 'text', text: '[Reference not shown: it arrived without a link.]' },
  { type: 'text', text: `[Content not shown: this host can't display "resource_link" content.]` },
  { type: 'text', text: 'two attachments' },
  { type: 'image', refId: old, mimeType: 'image/png', expiresAt: '2027-01-01T00:00:00Z', savedTo: null, expired: EXPIRY_REASON.unparseable },
];

test("an MCPL peer's structured result reaches a script with each block treated as the model's lanes treat it", async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    answer({ content: blocks('treated'), structuredContent: { attachments: 2 } });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('example.invalid'), `no URI reaches the script: ${out.slice(0, 2000)}`);
    assert.deepEqual(fetched, [uris('treated').report, uris('treated').big],
      'every reference was fetched for the script before it read the result, except the one that counts as expired');
    const object = JSON.parse(out) as { content: Array<{ refId?: string }>; structuredContent: unknown; isError: boolean };
    const [report, , big] = object.content;
    const old = object.content[10];
    assert.match(String(report!.refId), /^ref_/);
    assert.match(String(big!.refId), /^ref_/);
    assert.match(String(old!.refId), /^ref_/);
    assert.equal(new Set([report!.refId, big!.refId, old!.refId]).size, 3);
    assert.deepEqual(object, { content: treated(report!.refId!, big!.refId!, old!.refId!), structuredContent: { attachments: 2 }, isError: false });
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
    assert.deepEqual(object.content, treated(object.content[0]!.refId!, object.content[2]!.refId!, object.content[10]!.refId!));
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
      content: [treated(object.content[0]!.refId!, '', '')[0], { type: 'text', text: 'the attach failed' }],
      structuredContent: { partial: true },
      isError: true,
    });
    assert.deepEqual(fetched, [uris('structured-error').report], 'the script reads the blocks, so its reference was fetched first');
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
    const old = object.content[10];
    const sealed = object.content[11];
    const expected: unknown[] = [...treated(report!.refId!, big!.refId!, old!.refId!)];
    // A resource_link isn't a reference RFC-005 governs: the model's history
    // shows a module's as its fields, and so does the script.
    expected[8] = blocks('module')[8]!;
    expected.push({ type: 'resource', refId: sealed!.refId!, name: 'sealed.pdf', savedTo: null });
    assert.deepEqual(object, { content: expected, structuredContent: { attachments: 2 }, isError: false });
    assert.deepEqual(fetched, [uris('module').report, uris('module').big, uris('module').old, never('module').uri],
      'the module\'s references were fetched for the script, as before');
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
    const stub = { type: 'resource', refId, name: 'sealed.pdf', savedTo: null };
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
    assert.deepEqual(object.content, [{ type: 'resource', refId: object.content[0].refId, name: 'sealed.pdf', savedTo: null }]);
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
      content: [{ type: 'text', text: 'partly attached' }, { type: 'resource', refId: object.content[1].refId, name: 'sealed.pdf', savedTo: null }],
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
    const object = JSON.parse(await script('mcpl--files--attach')) as {
      content: [{ text: string }]; structuredContent: unknown; isError: boolean;
    };
    assert.equal(object.isError, true);
    assert.equal(object.structuredContent, null);
    // The reason is the overflow the guard caught, in both runtimes' words.
    assert.match(object.content[0].text, /^tool 'mcpl--files--attach' returned a result that can't be converted to JSON, so the script can't receive it \(Maximum call stack size exceeded\.?\)\. The call itself completed\.$/);
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

test("inline data beside an empty uri reaches a script as sent from a module, as history reads it, and withheld from an MCPL peer", async () => {
  await withPeers(async ({ answer, script, forward }) => {
    const inline = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: '' };
    forward.nested = [inline];
    assert.deepEqual((JSON.parse(await script('fwd--nested')) as { content: unknown }).content, [inline]);
    answer({ content: [inline], structuredContent: {} });
    assert.deepEqual((JSON.parse(await script('mcpl--files--attach')) as { content: unknown }).content, [{ type: 'text', text: INLINE_WITHHELD_TEXT }]);
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
    // An empty uri beside inline data is the classifier's contradiction on a peer's lane.
    assert.deepEqual(block.emptyUri, { type: 'text', text: INLINE_WITHHELD_TEXT });
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
