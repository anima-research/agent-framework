/**
 * What a script receives from a tool whose result carries structuredContent,
 * through the real dispatch. An MCPL peer's content blocks get the treatment
 * RFC-005 gives them on every lane the model reads, since what a script prints
 * comes back to the model: a reference arrives without its URI (a link
 * carries one only where the model's line shows it), as the host's
 * reference id, what the server said about it in that block, and `savedTo`,
 * the workspace path the dispatch fetched its payload to for the script; a
 * block the classifier rejects arrives as the notice the model's lanes show,
 * and inline data that claims a bulk disposition as the withheld notice. A
 * standard peer's blocks arrive as the server sent them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework, WorkspaceModule } from '../src/index.js';
import type { ScriptToolResult, ToolResult } from '../src/index.js';
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
  { type: 'image', uri: uris(test).old, mimeType: 'image/png', expiresAt: '2027-01-01T00:00:00Z\u202E' },
];

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
}

async function withPeers(fn: (h: Harness) => Promise<void>, opts: { eager?: boolean } = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'script-structured-references-'));
  const board = join(dir, 'board');
  mkdirSync(board);
  const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: board, mode: 'read-write', watch: 'never' }] });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }], modules: [workspace],
  });
  workspace.initStore(framework.getStore());
  let answer: Answer = { content: [] };
  // Two legacy-engine peers: `files` negotiated MCPL, `plain` is MCP-only.
  const peer = (id: string, capabilities: Record<string, unknown> | null) => ({ id, capabilities, sendToolsCall: async () => answer });
  const peers = new Map([['files', peer('files', {})], ['plain', peer('plain', null)]]);
  const fetched: string[] = [];
  const internals = framework as unknown as {
    mcplServerRegistry: unknown;
    mcplPrefixMap: Map<string, string>;
    getReferenceFetcher: () => unknown;
    handleScriptToolCall: (agent: string, tool: string, args: Record<string, unknown>) => Promise<ScriptToolResult>;
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
      // The string a script's call returns; its flags are pinned in
      // mcp-modern-framework and code-execution.
      script: async (tool) => (await internals.handleScriptToolCall.call(framework, 'agent', tool, {})).text,
      modelCall,
      fetched,
      workspace,
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
    expiresAt: '2026-12-31T00:00:00Z', savedTo: SAVED },
  { type: 'resource', refId: report, name: 'report-copy.pdf', savedTo: SAVED },
  { type: 'image', refId: big, mimeType: 'image/png', expiresAt: '2027-01-01T00:00:00Z', savedTo: null },
  { type: 'text', text: INLINE_WITHHELD_TEXT },
  { type: 'text', text: INLINE_WITHHELD_TEXT },
  { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
  { type: 'text', text: '[Reference not shown: its link is longer than this host accepts.]' },
  { type: 'text', text: '[Reference not shown: it arrived without a link.]' },
  { type: 'resource_link', refId: link, name: 'link', savedTo: null },
  { type: 'text', text: 'two attachments' },
  { type: 'image', refId: old, mimeType: 'image/png', expiresAt: '2027-01-01T00:00:00Z', savedTo: null, expired: EXPIRY_REASON.unparseable,
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
    assert.deepEqual(JSON.parse(await script('mcpl--plain--attach')), { content: [], structuredContent: { a: 1 }, isError: true, error: notice });
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

test("an MCPL peer's structured result past the script cap is saved with its references as their ids, no URI in the file", async () => {
  await withPeers(async ({ answer, script, workspace }) => {
    answer({ content: blocks('oversized'), structuredContent: { pad: 'x'.repeat(5_000_000) } });
    const out = JSON.parse(await script('mcpl--files--attach')) as { isError: boolean; oversized: { chars: number; savedTo: string } };
    assert.equal(out.isError, false);
    const read = await workspace.readBinary(out.oversized.savedTo);
    assert.ok('data' in read, `the saved result is readable: ${out.oversized.savedTo}`);
    const saved = read.data.toString('utf8');
    assert.ok(!saved.includes('example.invalid'), 'no URI in the saved file');
    const object = JSON.parse(saved) as { content: Array<{ refId?: string }> };
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
    assert.equal(await script('mcpl--files--attach'), 'Error: the attach failed');
    assert.deepEqual(fetched, [], 'a script that reads an error as its text alone gets no more than the eager pass');
  });
});

test("the eager pass still runs for the model's call and for an error a script reads as text", async () => {
  await withPeers(async ({ answer, script, modelCall, fetched }) => {
    answer({ content: [blocks('eager-model')[0]], structuredContent: { attachments: 1 } });
    assert.equal((await modelCall('attach')).success, true);
    assert.deepEqual(fetched, [uris('eager-model').report]);

    answer({ content: [blocks('eager-error')[0], { type: 'text', text: 'the attach failed' }], isError: true });
    assert.equal(await script('mcpl--files--attach'), 'Error: the attach failed');
    assert.deepEqual(fetched, [uris('eager-model').report, uris('eager-error').report]);
  }, { eager: true });
});

test('an error with structured content is fetched for the script, and reaches it treated, with its error text and structured content', async () => {
  await withPeers(async ({ answer, script, fetched }) => {
    answer({ content: [blocks('structured-error')[0], { type: 'text', text: 'the attach failed' }], structuredContent: { partial: true }, isError: true });
    const out = await script('mcpl--files--attach');
    assert.ok(!out.includes('example.invalid'), out);
    const object = JSON.parse(out) as { content: Array<{ refId?: string }>; structuredContent: unknown; isError: boolean; error: string };
    assert.deepEqual(object, {
      content: [treated(object.content[0]!.refId!, '', '', '')[0], { type: 'text', text: 'the attach failed' }],
      structuredContent: { partial: true },
      isError: true,
      error: 'the attach failed',
    });
    assert.deepEqual(fetched, [uris('structured-error').report], 'the script reads the blocks, so its reference was fetched first');
  });
});
