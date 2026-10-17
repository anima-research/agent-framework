/**
 * A tool result's data never reaches the agent, or its history, with an
 * RFC-005 reference's uri, wherever in the data it sits: data that isn't a
 * content array of blocks the serializer recognizes is written as JSON with
 * each reference as its stub and inline data claiming a uri or a disposition
 * withheld. Everything else in it is written as JSON writes it, as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolResult, ToolDefinition } from '../src/types/index.js';
import { nonErrorResultText, toolResultDataToHistoryString } from '../src/tool-result-history.js';
import { parseImagePlaceholders } from '../src/tool-image-ledger.js';
import { keptWhenWithheld } from '../src/tool-result-guard.js';
import { classifyBlock } from '../src/mcpl/references.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const SIGNATURE = 'zz-secret-signature';
const URI = `https://zz-files.example/blob?sig=${SIGNATURE}`;
const RESOURCE = { type: 'resource', uri: URI, mimeType: 'application/pdf', name: 'zz.pdf' };
const UNKNOWN = { type: 'zz-unknown', note: 'zz-kept' };
const STUB = /\[ref_[^\]]+\] zz\.pdf — application\/pdf — from tool result/;
const BASE64 = 'aGVsbG8gd29ybGQgaGVsbG8gd29ybGQ=';
const WITHHELD = '[inline content withheld: inline data that also claims a uri or a bulk disposition]';

function parsed(text: string): unknown {
  return JSON.parse(text);
}

describe('data the serializer doesn\'t read as content blocks', () => {
  it('shows a reference beside a block of another type as its stub, and keeps the rest as JSON', () => {
    const text = toolResultDataToHistoryString([UNKNOWN, RESOURCE]);
    assert.ok(!text.includes(SIGNATURE), text);
    const [unknown, stub] = parsed(text) as [unknown, string];
    assert.deepEqual(unknown, UNKNOWN);
    assert.match(stub, STUB);
  });

  it('shows a reference at any depth as its stub', () => {
    const wrapped = toolResultDataToHistoryString({ content: [{ type: 'text', text: 'zz-text' }, RESOURCE], page: 2 });
    assert.ok(!wrapped.includes(SIGNATURE), wrapped);
    const { content, page } = parsed(wrapped) as { content: [unknown, string]; page: number };
    assert.equal(page, 2);
    assert.deepEqual(content[0], { type: 'text', text: 'zz-text' });
    assert.match(content[1], STUB);
    const inside = toolResultDataToHistoryString([{ type: 'zz-unknown', attachment: RESOURCE }]);
    assert.ok(!inside.includes(SIGNATURE), inside);
    assert.match((parsed(inside) as [{ attachment: string }])[0].attachment, STUB);
  });

  it('shows a reference that is the whole data as its stub, as text, read as a content array\'s reference is', () => {
    const text = toolResultDataToHistoryString(RESOURCE);
    assert.match(text, STUB);
    assert.ok(!text.startsWith('"'), text);
    assert.ok(!text.includes(SIGNATURE), text);
    // An image reference that is the whole data starts its line, so it takes
    // a save_recent_image slot, as one in a content array does.
    const image = { type: 'image', uri: URI, mimeType: 'image/png', name: 'zz.png' };
    const whole = toolResultDataToHistoryString(image);
    assert.match(whole, /^\[ref_[^\]]+\] zz\.png — image\/png/);
    assert.equal(parseImagePlaceholders(whole).length, 1);
    assert.equal(parseImagePlaceholders(toolResultDataToHistoryString([image])).length, 1);
    // Inline data withheld as the whole data is the notice, as text too.
    assert.equal(toolResultDataToHistoryString({ type: 'image', data: BASE64, mimeType: 'image/png', uri: URI }), WITHHELD);
  });

  it('shows media given by uri as a reference too, an image or audio beside a block of another type', () => {
    for (const type of ['image', 'audio']) {
      const text = toolResultDataToHistoryString([UNKNOWN, { type, uri: URI, mimeType: `${type}/x-zz`, name: `zz.${type}` }]);
      assert.ok(!text.includes(SIGNATURE), text);
      assert.match((parsed(text) as [unknown, string])[1], /^\[ref_[^\]]+\] zz\./);
    }
  });

  it('withholds what the reference lanes withhold, saying why', () => {
    const notAString = parsed(toolResultDataToHistoryString([UNKNOWN, { type: 'resource', uri: { sig: SIGNATURE } }])) as [unknown, string];
    assert.equal(notAString[1], '[unrecognized content block: reference without string uri]');
    const tooLong = parsed(toolResultDataToHistoryString([UNKNOWN, { type: 'resource', uri: `${URI}${'x'.repeat(5000)}` }])) as [unknown, string];
    assert.equal(tooLong[1], '[unrecognized content block: uri exceeds schema maximum]');
    const objectUri = parsed(toolResultDataToHistoryString([UNKNOWN, { type: 'image', uri: { href: URI } }])) as [unknown, string];
    assert.equal(objectUri[1], "[unrecognized content block: image block whose uri isn't a string]");
    const smuggled = toolResultDataToHistoryString([UNKNOWN, { type: 'image', data: BASE64, mimeType: 'image/png', uri: URI }]);
    assert.ok(!smuggled.includes(SIGNATURE) && !smuggled.includes(BASE64), smuggled);
    assert.deepEqual(parsed(smuggled), [UNKNOWN, WITHHELD]);
    const disposition = toolResultDataToHistoryString([UNKNOWN, { type: 'image', data: BASE64, mimeType: 'image/png', disposition: 'ref' }]);
    assert.ok(!disposition.includes(BASE64), disposition);
    assert.deepEqual(parsed(disposition), [UNKNOWN, WITHHELD]);
  });

  it('withholds inline data beside a uri that is not a string where JSON would write it, and leaves the lanes as they were', () => {
    const block = { type: 'image', data: BASE64, mimeType: 'image/png', uri: { href: URI } };
    const nested = toolResultDataToHistoryString({ shot: block, page: 2 });
    assert.ok(!nested.includes(SIGNATURE) && !nested.includes(BASE64), nested);
    assert.deepEqual(parsed(nested), { shot: WITHHELD, page: 2 });
    // A content array shows no uri, so the image there is a placeholder, as
    // it is with no uri at all.
    const array = toolResultDataToHistoryString([{ type: 'text', text: 'zz-text' }, block]);
    assert.equal(array, toolResultDataToHistoryString([{ type: 'text', text: 'zz-text' }, { type: 'image', data: BASE64, mimeType: 'image/png' }]));
    assert.ok(!array.includes(SIGNATURE), array);
    assert.deepEqual(classifyBlock(block), { kind: 'inline', contradiction: false });
    // A null or empty uri is none: inline data beside it isn't a claim.
    const nullUri = { type: 'audio', data: BASE64, mimeType: 'audio/wav', uri: null };
    assert.equal(toolResultDataToHistoryString({ clip: nullUri }), JSON.stringify({ clip: nullUri }));
    const emptyUri = { type: 'image', data: BASE64, mimeType: 'image/png', uri: '' };
    assert.equal(toolResultDataToHistoryString({ shot: emptyUri }), JSON.stringify({ shot: emptyUri }));
  });

  it('writes inline media that claims no uri or disposition as JSON writes it, as before', () => {
    // RFC-005 governs references; plain inline bytes are left as they were.
    const data = {
      shot: { type: 'image', data: BASE64, mimeType: 'image/png' },
      clip: [UNKNOWN, { type: 'audio', data: BASE64, mimeType: 'audio/wav' }],
      link: { type: 'image', data: 'https://zz-images.example/a.png', caption: 'zz-caption' },
    };
    assert.equal(toolResultDataToHistoryString(data), JSON.stringify(data));
    assert.equal(toolResultDataToHistoryString(data.shot), JSON.stringify(data.shot));
  });

  it('writes data with nothing RFC-005 governs exactly as JSON does', () => {
    const plain = [{ id: 1, url: URI, type: 'zz-record' }, { type: 'resource_link', uri: URI, name: 'zz' }, 'zz', 7, null];
    assert.equal(toolResultDataToHistoryString(plain), JSON.stringify(plain));
    assert.equal(toolResultDataToHistoryString({ a: 1 }), '{"a":1}');
  });

  it('writes a record that only shares a type name, with no uri and no string data, as JSON does', () => {
    // A uri that is null, absent or empty is none, and data that isn't a
    // string isn't inline data: nothing here is a reference or inline bytes.
    const records = [
      UNKNOWN,
      { type: 'image', uri: null, id: 1, name: 'zz-a' },
      { type: 'audio', data: null, uri: undefined, name: 'zz-b' },
      { type: 'resource', name: 'zz-cpu', value: 0.5 },
      { type: 'resource', uri: undefined, name: 'zz-c' },
      { type: 'resource', resource: { name: 'zz-d' } },
      { type: 'resource', uri: '', text: 'zz-e' },
      { type: 'image', data: [1, 2, 3], mimeType: 'image/png', url: 'https://zz-images.example/a.png' },
      { type: 'audio', data: { type: 'Buffer', data: [9, 8, 7] }, name: 'zz-f', samples: 3 },
    ];
    assert.equal(toolResultDataToHistoryString(records), JSON.stringify(records));
    assert.equal(toolResultDataToHistoryString({ record: records[1] }), JSON.stringify({ record: records[1] }));
  });

  it("governs MCP's embedded resource, whose uri sits under resource, at any depth", () => {
    const embedded = { type: 'resource', resource: { uri: URI, mimeType: 'application/pdf', blob: BASE64 } };
    const line = '[unrecognized content block: reference without string uri]';
    const nested = toolResultDataToHistoryString({ result: { content: [embedded] } });
    assert.ok(!nested.includes(SIGNATURE) && !nested.includes(BASE64), nested);
    assert.deepEqual(parsed(nested), { result: { content: [line] } });
    const beside = toolResultDataToHistoryString([UNKNOWN, embedded]);
    assert.deepEqual(parsed(beside), [UNKNOWN, line]);
    assert.equal(toolResultDataToHistoryString(embedded), line);
    // The content-array path shows it the same way.
    assert.equal(toolResultDataToHistoryString([{ type: 'text', text: 'zz-text' }, embedded]), `zz-text\n${line}`);
  });

  it('governs media given a uri that is not a string, failing closed and saying which', () => {
    const text = toolResultDataToHistoryString({
      numeric: { type: 'image', uri: 42, name: 'zz-n' },
      both: { type: 'audio', data: [4, 5], uri: 43 },
    });
    assert.ok(!text.includes('4,5'), text);
    assert.deepEqual(parsed(text), {
      numeric: "[unrecognized content block: image block whose uri isn't a string]",
      both: "[unrecognized content block: audio block whose data and uri aren't strings]",
    });
    // In the lanes, a media block with neither keeps the line it had.
    assert.deepEqual(classifyBlock({ type: 'image' }), { kind: 'invalid', reason: 'image block with neither data nor uri' });
  });

  it("leaves a nested reference's stub out of save_recent_image's inventory, as main left the reference", () => {
    // A nested image-typed reference is shown as its stub inside the JSON,
    // and nested inline bytes stay JSON: neither is a slot, so no index moves.
    const text = toolResultDataToHistoryString([
      UNKNOWN,
      { type: 'resource', uri: URI, mimeType: 'image/png', name: 'zz.png' },
      { type: 'image', data: BASE64, mimeType: 'image/png' },
    ]);
    assert.ok(!text.includes(SIGNATURE), text);
    assert.match((parsed(text) as [unknown, string])[1], /^\[ref_[^\]]+\] zz\.png — image\/png/);
    assert.deepEqual(parseImagePlaceholders(text), []);
  });

  it('leaves an array of blocks it recognizes as it was', () => {
    assert.match(toolResultDataToHistoryString([{ type: 'text', text: 'zz-text' }, RESOURCE]), /^zz-text\n\[ref_/);
  });

  it('keeps a withheld result\'s kept fields free of the uri', () => {
    const kept = keptWhenWithheld({ success: true, data: { files: ['zz.txt'], receipt: [UNKNOWN, RESOURCE] }, keepWhenWithheld: ['files', 'receipt'] }, undefined);
    assert.ok(kept !== undefined && !kept.includes(SIGNATURE), kept);
    assert.match((parsed(kept!) as { receipt: [unknown, string] }).receipt[1], STUB);
    // Data that is itself a reference keeps its stub, whichever fields are marked.
    const whole = keptWhenWithheld({ success: true, data: RESOURCE, keepWhenWithheld: ['uri', 'name'] }, undefined);
    assert.ok(whole !== undefined && !whole.includes(SIGNATURE), whole);
    assert.match(whole!, STUB);
  });
});

/** A module whose one tool answers with the content array it was given. */
class ContentModule implements Module {
  readonly name = 'content';
  constructor(private readonly data: unknown[]) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'get', description: 'Answer with content.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: true, data: this.data };
  }
  async onProcess(): Promise<Record<string, never>> {
    return {};
  }
}

/** The content of the tool result the model received for one call, and of what the agent's history stored. */
async function answerModelCall(data: unknown[]): Promise<{ wire: string; stored: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'tool-result-reference-uri-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', allowedTools: 'all' }],
    modules: [new ContentModule(data)],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  try {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'zz-call', name: 'content--get', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-done' }]));
    framework.start();
    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'agent', reason: 'external-message', source: 'test', timestamp: Date.now(),
    });
    const stream = () => membrane.lastStream as unknown as { receivedToolResults: unknown[][] } | undefined;
    const deadline = Date.now() + 5_000;
    while ((stream()?.receivedToolResults.length ?? 0) < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const received = stream()?.receivedToolResults[0];
    assert.ok(received, 'the model was answered');
    const stored = framework.getAgent('agent')!.getContextManager().getAllMessages()
      .flatMap((message) => message.content)
      .filter((block) => (block as { type?: string }).type === 'tool_result');
    assert.equal(stored.length, 1, 'the history holds the tool result');
    // Each copy's content alone: the wire's result and the stored block wrap it differently.
    const contentOf = (results: unknown[]) => JSON.stringify(results.map((r) => (r as { content?: unknown }).content));
    return { wire: contentOf(received), stored: contentOf(stored) };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the wire without the stored copy', () => {
  it('makes its text as the stored copy is made', () => {
    const fw = Object.create(AgentFramework.prototype) as {
      toMembraneToolResult(callId: string, result: ToolResult, maxChars?: number): { content: unknown; isError: boolean };
    };
    for (const result of [
      { success: true, data: [UNKNOWN, RESOURCE] },
      { success: true, data: { content: [RESOURCE] } },
      { success: false, error: 'zz-failed', isError: false },
      { success: true, data: [{ type: 'text', text: 'zz-text' }] },
    ] as ToolResult[]) {
      const { content, isError } = fw.toMembraneToolResult('zz-call', result);
      assert.equal(isError, false);
      if (result.error === 'zz-failed') assert.equal(content, 'zz-failed');
      const expected = nonErrorResultText(result);
      // Each reference gets a fresh id, so compare with the ids taken out.
      const ids = (s: string) => s.replace(/ref_[A-Za-z0-9_-]+/g, 'ref_ID');
      assert.equal(ids(content as string), ids(expected));
      assert.ok(!(content as string).includes(SIGNATURE), String(content));
    }
  });

  it('cuts its text at the cap as the stored copy is cut', () => {
    const fw = Object.create(AgentFramework.prototype) as {
      toMembraneToolResult(callId: string, result: ToolResult, maxChars?: number): { content: unknown; isError: boolean };
    };
    const result: ToolResult = { success: true, data: { note: 'zz-'.repeat(200), shot: RESOURCE, more: 'zz-tail' } };
    const { content } = fw.toMembraneToolResult('zz-call', result, 300);
    const ids = (s: string) => s.replace(/ref_[A-Za-z0-9_-]+/g, 'ref_ID');
    assert.equal(ids(content as string), ids(nonErrorResultText(result, 300)));
    assert.match(content as string, /\n\n\[truncated — original was \d+ chars\]$/);
    assert.ok(!(content as string).includes(SIGNATURE), String(content));
  });
});

describe('a model\'s call answered with such data', () => {
  it('sends the stored copy, which holds the stub and never the uri', async () => {
    const { wire, stored } = await answerModelCall([UNKNOWN, RESOURCE]);
    assert.ok(!stored.includes(SIGNATURE), stored);
    assert.ok(stored.includes('zz-kept'), stored);
    assert.match(stored, /ref_/);
    assert.equal(wire, stored);
  });

  it('with an image too, sends the stored copy, which holds the stub and the image as JSON writes it', async () => {
    const { wire, stored } = await answerModelCall([{ type: 'image', data: BASE64, mimeType: 'image/png' }, UNKNOWN, RESOURCE]);
    assert.ok(!stored.includes(SIGNATURE), stored);
    assert.ok(stored.includes(BASE64), stored);
    assert.match(stored, /ref_/);
    assert.equal(wire, stored);
  });
});

describe('a script given such data', () => {
  type ScriptFramework = {
    dispatchScriptToolCall: (...args: unknown[]) => Promise<ToolResult>;
    handleScriptToolCall(agentName: string, toolName: string, args: Record<string, unknown>): Promise<string>;
  };

  it('gets the text history stores, with each reference as its stub and the rest as JSON writes it', async () => {
    const fw = Object.create(AgentFramework.prototype) as ScriptFramework;
    const shot = { type: 'image', data: BASE64, mimeType: 'image/png' };
    fw.dispatchScriptToolCall = async () => ({ success: true, data: { file: RESOURCE, shot, page: 2 } });
    const text = await fw.handleScriptToolCall('zz-agent', 'zz_tool', {});
    assert.ok(!text.includes(SIGNATURE), text);
    const result = parsed(text) as { file: string; shot: unknown; page: number };
    assert.match(result.file, STUB);
    assert.deepEqual(result.shot, shot);
    assert.equal(result.page, 2);
  });

  it("gets an in-process module's reference in a content array as its stub, once its fetch is refused", async () => {
    const fw = Object.create(AgentFramework.prototype) as ScriptFramework;
    fw.dispatchScriptToolCall = async () => ({ success: true, data: [{ type: 'text', text: 'zz-text' }, RESOURCE] });
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let text: string;
    try {
      text = await fw.handleScriptToolCall('zz-agent', 'zz_tool', {});
    } finally {
      console.error = error;
    }
    assert.ok(!text.includes(SIGNATURE), text);
    assert.match(text, /^zz-text\n\[ref_[^\]]+\] zz\.pdf — application\/pdf — from tool result/);
    assert.ok(logged.some((line) => /\[rfc005\] script-demand fetch of ref_\S+ failed: reference has no server binding/.test(line)), logged.join('\n'));
  });
});
