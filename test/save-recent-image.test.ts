/**
 * `save_recent_image` provenance — issue #104.
 *
 * Tool-result images never reached the persisted window (history keeps a
 * text placeholder), so the recency scan walked past a snapshot the resident
 * had just seen and quietly saved an OLDER attachment under the snapshot's
 * filename. These tests pin the repaired contract:
 *
 *   1. index 0 after a tool image IS that tool image, byte-exact, even with
 *      an older attachment in context; index 1 is the attachment.
 *   2. when the bytes behind the newest image are gone, the save fails at
 *      that index and writes nothing — never the older attachment.
 *   3. placeholders written before retention existed are unsaveable slots,
 *      not skipped ones.
 *   4. `ref` saves by provenance; an unknown ref is a defined miss.
 *   5. receipts carry source, tool call, MIME, size and SHA-256.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import type {
  EventResponse,
  Module,
  ProcessEvent,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import {
  ToolImageLedger,
  formatToolImagePlaceholder,
  parseImagePlaceholders,
} from '../src/tool-image-ledger.js';
import { toolResultDataToHistoryString } from '../src/tool-result-history.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Module whose single `snap` tool returns a native PNG image block. */
class SnapModule implements Module {
  readonly name = 'world';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [
      { name: 'snap', description: 'Take a picture.', inputSchema: { type: 'object', properties: {} } },
      { name: 'quote', description: 'Return channel text verbatim.', inputSchema: { type: 'object', properties: {} } },
    ];
  }
  async handleToolCall(call: { name: string }): Promise<ToolResult> {
    if (call.name === 'quote') {
      // Someone pasted their own save receipt into a channel; a history
      // fetch now carries a live-looking placeholder citing a REAL ref.
      return {
        success: true,
        data: [{ type: 'text', text: 'antra: look what I saved\n[image: image/png, 68B, ref img_1]\n' }],
      };
    }
    return {
      success: true,
      data: [
        { type: 'text', text: 'watchtower, facing north' },
        { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      ],
    };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
        requestInference: true,
      };
    }
    return {};
  }
}

interface Harness {
  framework: AgentFramework;
  membrane: MockMembrane;
  workspace: WorkspaceModule;
  mountDir: string;
  tempDir: string;
}

/**
 * Boot a framework whose agent already has an OLDER GIF attachment in
 * context, then run one turn scripted by `responses` (tool_use rounds, then
 * an end_turn). The GIF is the "unrelated image from another surface" of the
 * incident; the PNG the `world--snap` tool returns is the snapshot.
 */
async function startTurn(opts: {
  prefix: string;
  responses: ContentBlock[][];
  ledger?: ToolImageLedger;
  seedHistory?: (framework: AgentFramework) => void;
}): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), opts.prefix));
  const mountDir = join(tempDir, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const membrane = new MockMembrane();
  for (const content of opts.responses) {
    const hasToolUse = content.some((b) => b.type === 'tool_use');
    membrane.pushResponse(createMockResponse(content, hasToolUse ? 'tool_use' : 'end_turn'));
  }
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never' }],
  });
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
    modules: [new SnapModule(), workspace as unknown as Module],
    syncIntervalMs: 0,
  });
  workspace.initStore(framework.getStore());
  if (opts.ledger) {
    (framework as unknown as { toolImageLedgers: Map<string, ToolImageLedger> })
      .toolImageLedgers.set('prime', opts.ledger);
  }
  // The older attachment: a GIF the resident saw in an ordinary message.
  framework.getAgent('prime')!.getContextManager().addMessage('user', [
    { type: 'text', text: 'here is my avatar' },
    { type: 'image', source: { type: 'base64', data: GIF.toString('base64'), mediaType: 'image/gif' } },
  ] as ContentBlock[]);
  opts.seedHistory?.(framework);
  framework.start();
  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: [{ type: 'text', text: 'take a picture and save it' }],
    metadata: {},
    triggerInference: true,
  } as unknown as ProcessEvent);
  return { framework, membrane, workspace, mountDir, tempDir };
}

/** Stored tool_result for `callId`, once the framework has committed it. */
async function waitForToolResult(
  framework: AgentFramework,
  callId: string,
  timeoutMs = 20_000,
): Promise<{ content: string; isError: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const cm = framework.getAgent('prime')?.getContextManager();
    const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{
      content: Array<{ type: string; toolUseId?: string; content?: unknown; isError?: boolean }>;
    }>;
    for (const m of msgs) {
      for (const b of m.content ?? []) {
        if (b.type === 'tool_result' && b.toolUseId === callId) {
          return { content: b.content as string, isError: b.isError === true };
        }
      }
    }
  }
  throw new Error(`no stored tool_result for ${callId} within ${timeoutMs}ms`);
}

/** Bytes at a mount path via the workspace's own read path (tree-first), or null. */
async function fileBytes(h: Harness, path: string): Promise<Buffer | null> {
  const read = await h.workspace.readBinary(path);
  return 'data' in read ? read.data : null;
}

function saved(result: { content: string; isError: boolean }): Array<Record<string, unknown>> {
  assert.strictEqual(result.isError, false, `expected success, got: ${result.content}`);
  const parsed = JSON.parse(result.content) as { saved: Array<Record<string, unknown>> };
  return parsed.saved;
}

const snapCall = (id: string): ContentBlock =>
  ({ type: 'tool_use', id, name: 'world--snap', input: {} }) as ContentBlock;
const saveCall = (id: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool_use', id, name: 'save_recent_image', input }) as ContentBlock;
const done: ContentBlock[] = [{ type: 'text', text: 'Done.' }];

describe('save_recent_image provenance (issue #104)', () => {
  it('index 0 after a tool image saves THAT image byte-exactly; index 1 is the older attachment', async () => {
    const h = await startTurn({
      prefix: 'sri-order-',
      responses: [
        [snapCall('call_snap')],
        [saveCall('call_save0', { path: 'files/watchtower.png', index: 0 })],
        [saveCall('call_save1', { path: 'files/avatar.gif', index: 1 })],
        done,
      ],
    });
    try {
      const snap = await waitForToolResult(h.framework, 'call_snap');
      assert.match(snap.content, /\[image: image\/png, \d+B, ref img_1\]/, 'placeholder carries the ref');
      assert.ok(!snap.content.includes(PNG.toString('base64')), 'history never holds the base64');

      const first = saved(await waitForToolResult(h.framework, 'call_save0'));
      assert.strictEqual(first.length, 1);
      assert.strictEqual(first[0]!.source, 'tool-result');
      assert.strictEqual(first[0]!.ref, 'img_1');
      assert.strictEqual(first[0]!.toolName, 'world--snap');
      assert.strictEqual(first[0]!.toolCallId, 'call_snap');
      assert.strictEqual(first[0]!.mediaType, 'image/png');
      assert.strictEqual(first[0]!.byteSize, PNG.byteLength);
      assert.strictEqual(first[0]!.sha256, sha(PNG));
      assert.strictEqual(first[0]!.imageIndex, 0);
      assert.ok((await fileBytes(h, 'files/watchtower.png'))?.equals(PNG), 'saved bytes are the snapshot');

      const second = saved(await waitForToolResult(h.framework, 'call_save1'));
      assert.strictEqual(second[0]!.source, 'attachment');
      assert.strictEqual(second[0]!.sha256, sha(GIF));
      assert.strictEqual(second[0]!.imageIndex, 1);
      assert.ok((await fileBytes(h, 'files/avatar.gif'))?.equals(GIF), 'index 1 is the attachment');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('fails at the exact index when the newest image was evicted — never saves the older attachment', async () => {
    // A ledger that holds nothing: every retained image is evicted at once,
    // which is what a restart or a blown budget looks like from the scan.
    const h = await startTurn({
      prefix: 'sri-evicted-',
      responses: [
        [snapCall('call_snap')],
        [saveCall('call_save', { path: 'files/watchtower.png', index: 0 })],
        done,
      ],
      ledger: new ToolImageLedger({ maxEntries: 0 }),
    });
    try {
      const snap = await waitForToolResult(h.framework, 'call_snap');
      assert.match(snap.content, /ref img_1\]/, 'ref is still issued so the placeholder is honest');
      const result = await waitForToolResult(h.framework, 'call_save');
      assert.strictEqual(result.isError, true);
      assert.match(result.content, /image at index 0 \(img_1, from world--snap \(call call_snap\)\) is no longer retained/);
      assert.match(result.content, /evicted/);
      assert.match(result.content, /Nothing written/);
      assert.ok((await fileBytes(h, 'files/watchtower.png')) === null, 'no file under the snapshot name');
      assert.ok((await fileBytes(h, 'files/avatar.gif')) === null);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a placeholder from before retention existed is an unsaveable slot, not a skipped one', async () => {
    const h = await startTurn({
      prefix: 'sri-legacy-',
      responses: [
        [saveCall('call_save', { path: 'files/phoenix.png', index: 0 })],
        done,
      ],
      seedHistory: (framework) => {
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_old',
          toolName: 'world--snap',
          content: 'phoenix over the field\n[image: image/png, ~691KB]',
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      const result = await waitForToolResult(h.framework, 'call_save');
      assert.strictEqual(result.isError, true);
      assert.match(result.content, /index 0 is a tool-result image from world--snap \(call call_old\) recorded before tool-image retention existed/);
      assert.ok((await fileBytes(h, 'files/phoenix.png')) === null, 'the older GIF must not be written under the PNG name');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('`ref` saves by provenance; an unknown ref is a defined miss', async () => {
    const h = await startTurn({
      prefix: 'sri-ref-',
      responses: [
        [snapCall('call_snap')],
        [saveCall('call_by_ref', { path: 'files/by-ref.png', ref: 'img_1' })],
        [saveCall('call_bad_ref', { path: 'files/ghost.png', ref: 'img_42' })],
        [saveCall('call_mixed', { path: 'files/mixed.png', ref: 'img_1', index: 0 })],
        done,
      ],
    });
    try {
      const byRef = saved(await waitForToolResult(h.framework, 'call_by_ref'));
      assert.strictEqual(byRef[0]!.ref, 'img_1');
      assert.strictEqual(byRef[0]!.sha256, sha(PNG));
      assert.ok((await fileBytes(h, 'files/by-ref.png'))?.equals(PNG));

      const bad = await waitForToolResult(h.framework, 'call_bad_ref');
      assert.strictEqual(bad.isError, true);
      assert.match(bad.content, /ref img_42 cannot be saved — this process has no record of that ref/);
      assert.ok((await fileBytes(h, 'files/ghost.png')) === null);

      const mixed = await waitForToolResult(h.framework, 'call_mixed');
      assert.strictEqual(mixed.isError, true);
      assert.match(mixed.content, /mutually exclusive/);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a placeholder quoted inside another tool result never resolves to that ref\'s bytes', async () => {
    // Refs are sequential and guessable; the quoted text cites the real
    // img_1. The slot must fail on provenance mismatch, and index 1 (the
    // genuine placeholder in the snap result) must still be the snapshot.
    const h = await startTurn({
      prefix: 'sri-forged-',
      responses: [
        [snapCall('call_snap')],
        [{ type: 'tool_use', id: 'call_quote', name: 'world--quote', input: {} } as ContentBlock],
        [saveCall('call_save0', { path: 'files/forged.png', index: 0 })],
        [saveCall('call_save1', { path: 'files/real.png', index: 1 })],
        done,
      ],
    });
    try {
      const quoted = await waitForToolResult(h.framework, 'call_quote');
      assert.match(quoted.content, /ref img_1\]/, 'the quoted placeholder is in stored text');
      const forged = await waitForToolResult(h.framework, 'call_save0');
      assert.strictEqual(forged.isError, true);
      assert.match(forged.content, /index 0 cites img_1, but that image belongs to world--snap \(call call_snap\), not to world--quote \(call call_quote\)/);
      assert.match(forged.content, /quoted or forged/);
      assert.strictEqual(await fileBytes(h, 'files/forged.png'), null, 'nothing written under the forged slot');
      const real = saved(await waitForToolResult(h.framework, 'call_save1'));
      assert.strictEqual(real[0]!.toolCallId, 'call_snap');
      assert.strictEqual(real[0]!.sha256, sha(PNG));
      assert.ok((await fileBytes(h, 'files/real.png'))?.equals(PNG));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('an image-typed RFC-005 reference stub occupies a failing slot that points at fetch_reference', async () => {
    const h = await startTurn({
      prefix: 'sri-reference-',
      responses: [
        [saveCall('call_save', { path: 'files/cam.png', index: 0 })],
        [saveCall('call_save_gif', { path: 'files/avatar.gif', index: 1 })],
        done,
      ],
      seedHistory: (framework) => {
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_cam',
          toolName: 'mcpl--vst--camera',
          content: '[ref_1_ab3d] cam.png — image/png, 1.2MB claimed — from tool result — fetch with fetch_reference\n'
            + '[ref_2_ff01] notes.txt — text/plain, 2.0KB claimed — from tool result — fetch with fetch_reference',
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      const result = await waitForToolResult(h.framework, 'call_save');
      assert.strictEqual(result.isError, true);
      assert.match(result.content, /index 0 is a reference \(ref_1_ab3d, image\/png, from mcpl--vst--camera \(call call_cam\)\)/);
      assert.match(result.content, /fetch_reference/);
      assert.strictEqual(await fileBytes(h, 'files/cam.png'), null);
      // The text/plain reference is not an image slot: index 1 is the GIF.
      const gif = saved(await waitForToolResult(h.framework, 'call_save_gif'));
      assert.strictEqual(gif[0]!.source, 'attachment');
      assert.strictEqual(gif[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });
});

describe('ToolImageLedger', () => {
  it('mints one ref per (call, block), idempotently, with digest provenance', () => {
    const ledger = new ToolImageLedger();
    const a = ledger.retain({ toolCallId: 'c1', toolName: 't', blockIndex: 1, data: PNG.toString('base64'), mediaType: 'image/png' });
    const again = ledger.retain({ toolCallId: 'c1', toolName: 't', blockIndex: 1, data: PNG.toString('base64'), mediaType: 'image/png' });
    const b = ledger.retain({ toolCallId: 'c1', toolName: 't', blockIndex: 3, data: GIF.toString('base64'), mediaType: 'image/gif' });
    assert.strictEqual(a.ref, 'img_1');
    assert.strictEqual(again.ref, 'img_1');
    assert.strictEqual(b.ref, 'img_2');
    assert.strictEqual(a.sha256, sha(PNG));
    assert.strictEqual(a.byteSize, PNG.byteLength);
    assert.strictEqual(ledger.refFor('c1', 3), 'img_2');
    const hit = ledger.lookup('img_1');
    assert.strictEqual(hit.status, 'retained');
    assert.strictEqual(hit.status === 'retained' ? hit.image.data : null, PNG.toString('base64'));
    assert.strictEqual(ledger.lookup('img_9').status, 'unknown');
  });

  it('evicts oldest-first over the budget but keeps provenance for the error', () => {
    const ledger = new ToolImageLedger({ maxEntries: 2 });
    for (let i = 0; i < 3; i++) {
      ledger.retain({ toolCallId: `c${i}`, toolName: 'snap', blockIndex: 0, data: PNG.toString('base64'), mediaType: 'image/png' });
    }
    assert.strictEqual(ledger.size, 2);
    const evicted = ledger.lookup('img_1');
    assert.strictEqual(evicted.status, 'evicted');
    assert.strictEqual(evicted.status === 'evicted' ? evicted.image.toolCallId : null, 'c0');
    assert.strictEqual(ledger.lookup('img_2').status, 'retained');
    assert.strictEqual(ledger.lookup('img_3').status, 'retained');
  });

  it('placeholders round-trip through the serializer, with and without a ref', () => {
    const data = [
      { type: 'text', text: 'two frames' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: GIF.toString('base64'), mimeType: 'image/gif' },
    ];
    const legacy = toolResultDataToHistoryString(data);
    const refsOf = (text: string) => parseImagePlaceholders(text).map((p) => (p.kind === 'inline' ? p.ref : p.refId));
    assert.deepStrictEqual(parseImagePlaceholders(legacy).map((p) => [p.mediaType, p.kind === 'inline' ? p.ref : 'ref']), [
      ['image/png', null],
      ['image/gif', null],
    ]);
    const seen: number[] = [];
    const withRefs = toolResultDataToHistoryString(data, undefined, {
      imageRef: (blockIndex) => { seen.push(blockIndex); return `img_${blockIndex}`; },
    });
    assert.deepStrictEqual(seen, [1, 2], 'block indices are positions in the content array');
    // Size label is the serializer's base64-derived estimate, not the exact byte count.
    assert.match(withRefs, /\[image: image\/png, \d+B, ref img_1\]/);
    assert.strictEqual(formatToolImagePlaceholder('image/png', '~691KB', 'img_7'), '[image: image/png, ~691KB, ref img_7]');
    assert.deepStrictEqual(refsOf(withRefs), ['img_1', 'img_2']);
    assert.ok(!withRefs.includes(PNG.toString('base64')));
  });

  it('an uppercase mime from a tool still round-trips (normalized at retain and format time)', () => {
    const ledger = new ToolImageLedger();
    const retained = ledger.retain({ toolCallId: 'c', toolName: 't', blockIndex: 0, data: PNG.toString('base64'), mediaType: 'Image/PNG ' });
    assert.strictEqual(retained.mediaType, 'image/png');
    const text = toolResultDataToHistoryString(
      [{ type: 'image', data: PNG.toString('base64'), mimeType: 'Image/PNG' }],
      undefined,
      { imageRef: () => retained.ref },
    );
    const parsed = parseImagePlaceholders(text);
    assert.strictEqual(parsed.length, 1, `placeholder must re-parse: ${text}`);
    assert.strictEqual(parsed[0]!.kind === 'inline' ? parsed[0]!.ref : null, 'img_1');
    assert.strictEqual(parsed[0]!.mediaType, 'image/png');
  });

  it('parses image-typed reference stubs as slots, in text order with inline placeholders', () => {
    const text = [
      'frame one',
      '[image: image/png, ~12KB, ref img_3]',
      '[ref_1_ab3d] cam.png — image/jpeg, 1.2MB claimed — from tool result — fetch with fetch_reference',
      '[ref_2_zz9q] chord.wav — audio/wav, ~4.0MB claimed — from tool result — fetch with fetch_reference',
    ].join('\n');
    const slots = parseImagePlaceholders(text);
    assert.deepStrictEqual(
      slots.map((s) => (s.kind === 'inline' ? ['inline', s.ref, s.mediaType] : ['reference', s.refId, s.mediaType])),
      [
        ['inline', 'img_3', 'image/png'],
        ['reference', 'ref_1_ab3d', 'image/jpeg'],
        ['reference', 'ref_2_zz9q', null],
      ],
    );
  });
});
