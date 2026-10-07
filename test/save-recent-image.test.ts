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
 *
 * Second review round (#140) added three more representations of the same
 * failure, each pinned below:
 *   6. truncation/spill never drops an image slot from the stored text.
 *   7. a save dispatched in the same batch as the snapshot waits for it.
 *   8. refs are namespaced per ledger — a stale ref resolves to nothing,
 *      and a direct `ref` is saved through its occurrence in context.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AnthropicXmlFormatter,
  NativeFormatter,
  OpenAIResponsesFormatter,
  parseToolCalls,
} from '@animalabs/membrane';
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
  FALLBACK_MEDIA_TYPE,
  TOOL_IMAGE_REF_RE,
  ToolImageLedger,
  formatPreservedImageSlots,
  formatToolImagePlaceholder,
  normalizeMediaType,
  parseImagePlaceholders,
  splitPreservingImageSlots,
} from '../src/tool-image-ledger.js';
import { toolResultDataToHistoryString, truncateForHistory } from '../src/tool-result-history.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const REF_1 = /^img_[0-9a-z]+_1$/;
/** ~30k chars — past the smallest allowed inline cap (1000) many times over. */
const LONG_TEXT = 'line of scan output\n'.repeat(1500);

/** World module: `snap` returns a native PNG image block; the other tools
 *  are the review's representations of the same result, one shape each. */
class SnapModule implements Module {
  readonly name = 'world';
  /** The `quote` tool cites this ref — set by the test once it knows it. */
  quotedRef = 'img_zzzzzz_1';
  /** Delay before `snap` resolves — proves the same-batch barrier waits. */
  snapDelayMs = 0;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    const schema = { type: 'object', properties: {} } as const;
    return [
      { name: 'snap', description: 'Take a picture.', inputSchema: schema },
      { name: 'quote', description: 'Return channel text verbatim.', inputSchema: schema },
      { name: 'snap_long', description: 'Long scan then a picture.', inputSchema: schema },
      { name: 'snap_sandwich', description: 'Picture, long scan, picture.', inputSchema: schema },
      { name: 'snap_contradiction', description: 'RFC-005 vector-2 image.', inputSchema: schema },
      { name: 'snap_uri', description: 'RFC-005 reference image.', inputSchema: schema },
    ];
  }
  async handleToolCall(call: { name: string }): Promise<ToolResult> {
    const png = { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' };
    switch (call.name) {
      case 'quote':
        // Someone pasted their own save receipt into a channel; a history
        // fetch now carries a live-looking placeholder citing a REAL ref.
        return {
          success: true,
          data: [{ type: 'text', text: `antra: look what I saved\n[image: image/png, 68B, ref ${this.quotedRef}]\n` }],
        };
      case 'snap_long':
        return { success: true, data: [{ type: 'text', text: LONG_TEXT }, png] };
      case 'snap_sandwich':
        return {
          success: true,
          data: [png, { type: 'text', text: LONG_TEXT }, { type: 'image', data: GIF.toString('base64'), mimeType: 'image/gif' }],
        };
      case 'snap_contradiction':
        // Inline data claiming a disposition: withheld by every lane.
        return { success: true, data: [{ type: 'text', text: 'cam' }, { ...png, disposition: 'ref' }] };
      case 'snap_uri':
        return {
          success: true,
          data: [{ type: 'text', text: 'cam' }, { type: 'image', uri: 'https://cam.example/latest.png', mimeType: 'image/png', sizeBytes: 1200 }],
        };
      default:
        if (this.snapDelayMs > 0) await new Promise((r) => setTimeout(r, this.snapDelayMs));
        return { success: true, data: [{ type: 'text', text: 'watchtower, facing north' }, png] };
    }
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
  world: SnapModule;
  ledger: ToolImageLedger;
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
  toolResultInlineMaxChars?: number;
  world?: (module: SnapModule) => void;
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
  const world = new SnapModule();
  opts.world?.(world);
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
    modules: [world, workspace as unknown as Module],
    syncIntervalMs: 0,
    ...(opts.toolResultInlineMaxChars !== undefined ? { toolResultInlineMaxChars: opts.toolResultInlineMaxChars } : {}),
  });
  workspace.initStore(framework.getStore());
  // Install the ledger up front so tests know the nonce its refs will carry.
  const ledger = opts.ledger ?? new ToolImageLedger();
  (framework as unknown as { toolImageLedgers: Map<string, ToolImageLedger> })
    .toolImageLedgers.set('prime', ledger);
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
  return { framework, membrane, workspace, world, ledger, mountDir, tempDir };
}
const refOf = (h: Harness, seq: number): string => `img_${h.ledger.nonce}_${seq}`;

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
      assert.match(snap.content, /\[image: image\/png, \d+B, ref img_[0-9a-z]+_1\]/, 'placeholder carries the ref');
      assert.ok(!snap.content.includes(PNG.toString('base64')), 'history never holds the base64');

      const first = saved(await waitForToolResult(h.framework, 'call_save0'));
      assert.strictEqual(first.length, 1);
      assert.strictEqual(first[0]!.source, 'tool-result');
      assert.strictEqual(first[0]!.ref, refOf(h, 1));
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
      assert.match(snap.content, /ref img_[0-9a-z]+_1\]/, 'ref is still issued so the placeholder is honest');
      const result = await waitForToolResult(h.framework, 'call_save');
      assert.strictEqual(result.isError, true);
      assert.match(result.content, new RegExp(`image at index 0 \\(${refOf(h, 1)}, from world--snap \\(call call_snap\\)\\) is no longer retained`));
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
      assert.match(result.content, /index 0 is a tool-result image from world--snap \(call call_old\) recorded without a retention ref/);
      assert.ok((await fileBytes(h, 'files/phoenix.png')) === null, 'the older GIF must not be written under the PNG name');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('`ref` saves by provenance; an unknown ref is a defined miss', async () => {
    const ledger = new ToolImageLedger();
    const ref1 = `img_${ledger.nonce}_1`;
    const h = await startTurn({
      prefix: 'sri-ref-',
      ledger,
      responses: [
        [snapCall('call_snap')],
        [saveCall('call_by_ref', { path: 'files/by-ref.png', ref: ref1 })],
        [saveCall('call_bad_ref', { path: 'files/ghost.png', ref: `img_${ledger.nonce}_42` })],
        [saveCall('call_bad_grammar', { path: 'files/ghost2.png', ref: 'img_1' })],
        [saveCall('call_mixed', { path: 'files/mixed.png', ref: ref1, index: 0 })],
        done,
      ],
    });
    try {
      const byRef = saved(await waitForToolResult(h.framework, 'call_by_ref'));
      assert.strictEqual(byRef[0]!.ref, ref1);
      assert.strictEqual(byRef[0]!.sha256, sha(PNG));
      assert.strictEqual(byRef[0]!.toolCallId, 'call_snap');
      assert.ok((await fileBytes(h, 'files/by-ref.png'))?.equals(PNG));

      const bad = await waitForToolResult(h.framework, 'call_bad_ref');
      assert.strictEqual(bad.isError, true);
      assert.match(bad.content, new RegExp(`ref img_${ledger.nonce}_42 cannot be saved — this process has no record of that ref`));
      assert.ok((await fileBytes(h, 'files/ghost.png')) === null);

      // The pre-nonce spelling is not a ref at all.
      const grammar = await waitForToolResult(h.framework, 'call_bad_grammar');
      assert.strictEqual(grammar.isError, true);
      assert.match(grammar.content, /`ref` must look like/);

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
    const ledger = new ToolImageLedger();
    const h = await startTurn({
      prefix: 'sri-forged-',
      ledger,
      world: (world) => { world.quotedRef = `img_${ledger.nonce}_1`; },
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
      assert.match(quoted.content, new RegExp(`ref img_${ledger.nonce}_1\\]`), 'the quoted placeholder is in stored text');
      const forged = await waitForToolResult(h.framework, 'call_save0');
      assert.strictEqual(forged.isError, true);
      assert.match(forged.content, new RegExp(`index 0 cites img_${ledger.nonce}_1, but that image belongs to world--snap \\(call call_snap\\), not to world--quote \\(call call_quote\\)`));
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

  it('truncation past the inline cap keeps the image slot: index 0 is still the snapshot', async () => {
    // [30k text, image] at the smallest allowed cap. The wire delivered the
    // image; the stored text must still carry its slot after the cut.
    const h = await startTurn({
      prefix: 'sri-truncated-',
      toolResultInlineMaxChars: 1000,
      responses: [
        [{ type: 'tool_use', id: 'call_long', name: 'world--snap_long', input: {} } as ContentBlock],
        [saveCall('call_save', { path: 'files/after-cut.png', index: 0 })],
        done,
      ],
    });
    try {
      const stored = await waitForToolResult(h.framework, 'call_long');
      assert.match(stored.content, /\[truncated — showing \d+ of \d+ chars/);
      assert.match(stored.content, /1 image slot\(s\) fell past the cut/);
      const slots = parseImagePlaceholders(stored.content);
      assert.strictEqual(slots.length, 1, `exactly one slot survives the cut: ${stored.content.slice(-300)}`);
      assert.strictEqual(slots[0]!.kind === 'inline' ? slots[0]!.ref : null, refOf(h, 1));

      const receipt = saved(await waitForToolResult(h.framework, 'call_save'));
      assert.strictEqual(receipt[0]!.toolCallId, 'call_long');
      assert.strictEqual(receipt[0]!.sha256, sha(PNG));
      assert.ok((await fileBytes(h, 'files/after-cut.png'))?.equals(PNG), 'the snapshot, not the older GIF');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('[image A, huge text, image B] truncated: index 0 is B, index 1 is A — order survives the cut', async () => {
    const h = await startTurn({
      prefix: 'sri-sandwich-',
      toolResultInlineMaxChars: 1000,
      responses: [
        [{ type: 'tool_use', id: 'call_sandwich', name: 'world--snap_sandwich', input: {} } as ContentBlock],
        [saveCall('call_save_b', { path: 'files/b.gif', index: 0 })],
        [saveCall('call_save_a', { path: 'files/a.png', index: 1 })],
        done,
      ],
    });
    try {
      const stored = await waitForToolResult(h.framework, 'call_sandwich');
      assert.deepStrictEqual(
        parseImagePlaceholders(stored.content).map((p) => (p.kind === 'inline' ? p.ref : p.refId)),
        [refOf(h, 1), refOf(h, 2)],
        'both slots, in the original order',
      );
      const b = saved(await waitForToolResult(h.framework, 'call_save_b'));
      assert.strictEqual(b[0]!.sha256, sha(GIF));
      assert.strictEqual(b[0]!.ref, refOf(h, 2));
      const a = saved(await waitForToolResult(h.framework, 'call_save_a'));
      assert.strictEqual(a[0]!.sha256, sha(PNG));
      assert.strictEqual(a[0]!.ref, refOf(h, 1));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a save dispatched in the SAME batch as the snapshot waits for it and saves it', async () => {
    // One tool_use round: [snap, save]. Module calls are only enqueued while
    // the save runs at once — without the barrier the inventory is empty at
    // scan time and the older GIF gets saved under the snapshot's name.
    const h = await startTurn({
      prefix: 'sri-same-batch-',
      world: (world) => { world.snapDelayMs = 150; },
      responses: [
        [snapCall('call_snap'), saveCall('call_save', { path: 'files/batched.png', index: 0 })],
        done,
      ],
    });
    try {
      const receipt = saved(await waitForToolResult(h.framework, 'call_save'));
      assert.strictEqual(receipt[0]!.source, 'tool-result');
      assert.strictEqual(receipt[0]!.toolCallId, 'call_snap');
      assert.strictEqual(receipt[0]!.sha256, sha(PNG));
      assert.ok((await fileBytes(h, 'files/batched.png'))?.equals(PNG));
      // Early retention and commit-time serialization agree on the ref.
      const snap = await waitForToolResult(h.framework, 'call_snap');
      assert.match(snap.content, new RegExp(`ref ${receipt[0]!.ref}\\]`));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('[save, snap] — a save dispatched BEFORE its sibling snapshot still waits for it (#140 follow-up)', async () => {
    // The mirror of the test above, in the order a model is at least as
    // likely to emit. The round loop dispatches synchronously, so the save
    // starts first and finds no snapshot in the inventory; the sibling
    // barrier's first poll must still yield to the snap that follows it in
    // the same batch. Pinned separately because it was verified by reading
    // at review time and never by a test.
    const h = await startTurn({
      prefix: 'sri-same-batch-rev-',
      world: (world) => { world.snapDelayMs = 150; },
      responses: [
        [saveCall('call_save', { path: 'files/batched-rev.png', index: 0 }), snapCall('call_snap')],
        done,
      ],
    });
    try {
      const receipt = saved(await waitForToolResult(h.framework, 'call_save'));
      assert.strictEqual(receipt[0]!.source, 'tool-result');
      assert.strictEqual(receipt[0]!.toolCallId, 'call_snap', 'the sibling snapshot, not the older attachment');
      assert.strictEqual(receipt[0]!.sha256, sha(PNG));
      assert.ok((await fileBytes(h, 'files/batched-rev.png'))?.equals(PNG));
      const snap = await waitForToolResult(h.framework, 'call_snap');
      assert.match(snap.content, new RegExp(`ref ${receipt[0]!.ref}\\]`));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('same-batch siblings are classified like the commit path: withheld data is no slot, a uri image is a reference slot', async () => {
    const h = await startTurn({
      prefix: 'sri-same-batch-class-',
      responses: [
        [
          { type: 'tool_use', id: 'call_contra', name: 'world--snap_contradiction', input: {} } as ContentBlock,
          saveCall('call_save_contra', { path: 'files/contra.png', index: 0 }),
        ],
        [
          { type: 'tool_use', id: 'call_uri', name: 'world--snap_uri', input: {} } as ContentBlock,
          saveCall('call_save_uri', { path: 'files/uri.png', index: 0 }),
        ],
        done,
      ],
    });
    try {
      // The withheld image is not a slot in either representation: index 0
      // is the GIF attachment, and its bytes never entered the ledger.
      const contra = saved(await waitForToolResult(h.framework, 'call_save_contra'));
      assert.strictEqual(contra[0]!.source, 'attachment');
      assert.strictEqual(contra[0]!.sha256, sha(GIF));
      assert.strictEqual(h.ledger.size, 0, 'withheld bytes must not be retained');
      const stored = await waitForToolResult(h.framework, 'call_contra');
      assert.strictEqual(parseImagePlaceholders(stored.content).length, 0);

      const uri = await waitForToolResult(h.framework, 'call_save_uri');
      assert.strictEqual(uri.isError, true);
      assert.match(uri.content, /index 0 is a reference \(ref_[0-9a-z]+_[0-9a-z]+, image\/png, from world--snap_uri \(call call_uri\)\)/);
      assert.strictEqual(await fileBytes(h, 'files/uri.png'), null);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a placeholder from a previous process (other nonce) is a defined miss by index AND by ref', async () => {
    const h = await startTurn({
      prefix: 'sri-stale-',
      responses: [
        [saveCall('call_save_idx', { path: 'files/stale.png', index: 0 })],
        [saveCall('call_save_ref', { path: 'files/stale-ref.png', ref: 'img_zzzzzz_7' })],
        done,
      ],
      seedHistory: (framework) => {
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_yesterday',
          toolName: 'world--snap',
          content: 'yesterday\n[image: image/png, ~691KB, ref img_zzzzzz_7]',
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      // Seven fresh images in this process: a bare `img_7` would collide.
      for (let i = 1; i <= 7; i++) {
        h.ledger.retain({ toolCallId: `call_today_${i}`, toolName: 'world--snap', blockIndex: 0, data: PNG.toString('base64'), mediaType: 'image/png' });
      }
      const byIndex = await waitForToolResult(h.framework, 'call_save_idx');
      assert.strictEqual(byIndex.isError, true);
      assert.match(byIndex.content, /index 0 \(img_zzzzzz_7, from world--snap \(call call_yesterday\)\) is no longer retained — this process has no record/);
      const byRef = await waitForToolResult(h.framework, 'call_save_ref');
      assert.strictEqual(byRef.isError, true);
      // The stale placeholder IS visible, so the ref resolves through it and fails the same way.
      assert.match(byRef.content, /img_zzzzzz_7, from world--snap \(call call_yesterday\)\) is no longer retained — this process has no record/);
      assert.strictEqual(await fileBytes(h, 'files/stale.png'), null);
      assert.strictEqual(await fileBytes(h, 'files/stale-ref.png'), null);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a direct `ref` is saved through its placeholder in context — a retained ref that is not visible is refused', async () => {
    const ledger = new ToolImageLedger();
    const ghost = ledger.retain({ toolCallId: 'call_ghost', toolName: 'world--snap', blockIndex: 1, data: PNG.toString('base64'), mediaType: 'image/png' });
    const h = await startTurn({
      prefix: 'sri-ref-context-',
      ledger,
      responses: [
        [saveCall('call_save', { path: 'files/ghost.png', ref: ghost.ref })],
        done,
      ],
    });
    try {
      const result = await waitForToolResult(h.framework, 'call_save');
      assert.strictEqual(result.isError, true);
      assert.match(result.content, new RegExp(`ref ${ghost.ref} \\(from world--snap \\(call call_ghost\\)\\) does not appear in your recent context`));
      assert.strictEqual(await fileBytes(h, 'files/ghost.png'), null);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Nullable selectors (shelf-375). A caller whose provider presents every
// property as required sends all three selectors; null (like omission) must
// mean "not this selector", while any SUPPLIED value is checked and never
// read as absent — "" or false read as 0 would save the newest image instead
// of the one the caller named.
// ---------------------------------------------------------------------------

/** One XML tool call as a model on the XML path writes it. Tags are assembled
 *  from pieces so this file holds no literal tool-call markup. */
function xmlCall(name: string, params: Record<string, string>): string {
  const tag = (t: string): string => `<${t}>`;
  const close = (t: string): string => `</${t}>`;
  const FC = 'function' + '_calls';
  return [
    tag(FC),
    `<invoke name="${name}">`,
    ...Object.entries(params).map(([k, v]) => `<parameter name="${k}">${v}${close('parameter')}`),
    close('invoke'),
    close(FC),
  ].join('\n');
}

/** The input membrane's XML parser hands the framework for that call. */
function parsedXmlInput(params: Record<string, string>): Record<string, unknown> {
  const parsed = parseToolCalls(xmlCall('save_recent_image', params));
  assert.ok(parsed && parsed.calls.length === 1, 'membrane parses the XML call');
  return parsed.calls[0]!.input;
}

const failed = (result: { content: string; isError: boolean }): string => {
  assert.strictEqual(result.isError, true, `expected a refusal, got: ${result.content}`);
  return result.content;
};

describe('save_recent_image selectors: null and omission both mean unused (shelf-375)', () => {
  it('sparse and every-property calls each save the image they name', async () => {
    const ledger = new ToolImageLedger();
    const ref1 = `img_${ledger.nonce}_1`;
    const xmlEveryProperty = parsedXmlInput({ path: 'files/xml.gif', ref: 'null', index: '1', count: 'null' });
    assert.deepStrictEqual(xmlEveryProperty, { path: 'files/xml.gif', ref: null, index: 1, count: null },
      'the XML path delivers null selectors as null');
    const h = await startTurn({
      prefix: 'sri-nullable-',
      ledger,
      responses: [
        [snapCall('call_snap')],
        [
          // Sparse callers: only the selector in use.
          saveCall('call_sparse', { path: 'files/sparse.png' }),
          saveCall('call_sparse_ref', { path: 'files/sparse-ref.png', ref: ref1 }),
          saveCall('call_sparse_pos', { path: 'files/sparse-pos.gif', index: 1, count: 1 }),
          // Every-property callers: null for the selector not in use, both modes.
          saveCall('call_every_pos', { path: 'files/every-pos.gif', ref: null, index: 1, count: null }),
          saveCall('call_every_ref', { path: 'files/every-ref.png', ref: ref1, index: null, count: null }),
          saveCall('call_every_range', { path: 'files/range.png', ref: null, index: null, count: 2 }),
          // The narrow compatibility form: decimal-digit strings.
          saveCall('call_digits', { path: 'files/digits.gif', ref: null, index: '1', count: '1' }),
          // What the XML path delivers for an every-property call.
          saveCall('call_xml', xmlEveryProperty),
        ],
        done,
      ],
    });
    try {
      await waitForToolResult(h.framework, 'call_snap');
      const expectPng = async (callId: string, path: string, imageIndex: number): Promise<void> => {
        const s = saved(await waitForToolResult(h.framework, callId));
        assert.strictEqual(s.length, 1, callId);
        assert.strictEqual(s[0]!.sha256, sha(PNG), `${callId} saved the snapshot`);
        assert.strictEqual(s[0]!.imageIndex, imageIndex, callId);
        assert.ok((await fileBytes(h, path))?.equals(PNG), `${callId} wrote the snapshot`);
      };
      const expectGif = async (callId: string, path: string): Promise<void> => {
        const s = saved(await waitForToolResult(h.framework, callId));
        assert.strictEqual(s.length, 1, callId);
        assert.strictEqual(s[0]!.sha256, sha(GIF), `${callId} saved the older attachment`);
        assert.strictEqual(s[0]!.imageIndex, 1, callId);
        assert.ok((await fileBytes(h, path))?.equals(GIF), `${callId} wrote the attachment`);
      };
      await expectPng('call_sparse', 'files/sparse.png', 0);
      await expectPng('call_sparse_ref', 'files/sparse-ref.png', 0);
      await expectGif('call_sparse_pos', 'files/sparse-pos.gif');
      await expectGif('call_every_pos', 'files/every-pos.gif');
      await expectPng('call_every_ref', 'files/every-ref.png', 0);
      await expectGif('call_digits', 'files/digits.gif');
      await expectGif('call_xml', 'files/xml.gif');

      const range = saved(await waitForToolResult(h.framework, 'call_every_range'));
      assert.deepStrictEqual(range.map((f) => f.sha256), [sha(PNG), sha(GIF)], 'count 2 with null index is the newest two');
      assert.ok((await fileBytes(h, 'files/range-0.png'))?.equals(PNG));
      assert.ok((await fileBytes(h, 'files/range-1.png'))?.equals(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a supplied selector is checked, never read as absent; only a real conflict is refused as one', async () => {
    const ledger = new ToolImageLedger();
    const ref1 = `img_${ledger.nonce}_1`;
    const REF_FORMAT = /`ref` must look like "img_k7x3q2_7"/;
    const INDEX = /`index` must be a non-negative integer/;
    const COUNT = /`count` must be an integer in 1\.\.20/;
    const CONFLICT = /`ref` is mutually exclusive with `index`\/`count` — pass null \(or omit\) for the selector you are not using/;
    const cases: Array<{ id: string; input: Record<string, unknown>; refusal: RegExp }> = [
      { id: 'ref_empty', input: { ref: '' }, refusal: REF_FORMAT },
      { id: 'ref_blank', input: { ref: '   ' }, refusal: REF_FORMAT },
      { id: 'ref_empty_every', input: { ref: '', index: null, count: null }, refusal: REF_FORMAT },
      { id: 'ref_malformed', input: { ref: 'img_1' }, refusal: REF_FORMAT },
      { id: 'index_empty', input: { index: '' }, refusal: INDEX },
      { id: 'index_blank', input: { ref: null, index: ' ', count: null }, refusal: INDEX },
      { id: 'index_false', input: { index: false }, refusal: INDEX },
      { id: 'index_array', input: { index: [] }, refusal: INDEX },
      { id: 'index_decimal_text', input: { index: '1.0' }, refusal: INDEX },
      { id: 'index_negative', input: { index: -1 }, refusal: INDEX },
      { id: 'index_fraction', input: { index: 1.5 }, refusal: INDEX },
      { id: 'count_empty', input: { count: '' }, refusal: COUNT },
      { id: 'count_true', input: { ref: null, index: null, count: true }, refusal: COUNT },
      { id: 'count_array', input: { count: [2] }, refusal: COUNT },
      { id: 'count_zero', input: { count: 0 }, refusal: COUNT },
      { id: 'count_over', input: { count: 21 }, refusal: COUNT },
      { id: 'conflict_count', input: { ref: ref1, count: 2 }, refusal: CONFLICT },
      { id: 'conflict_index', input: { ref: ref1, index: 0, count: null }, refusal: CONFLICT },
      { id: 'conflict_supplied_empty', input: { ref: ref1, index: '' }, refusal: CONFLICT },
    ];
    const h = await startTurn({
      prefix: 'sri-supplied-',
      ledger,
      responses: [
        [snapCall('call_snap')],
        cases.map((c) => saveCall(`call_${c.id}`, { path: `files/${c.id}.png`, ...c.input })),
        done,
      ],
    });
    try {
      await waitForToolResult(h.framework, 'call_snap');
      for (const c of cases) {
        const message = failed(await waitForToolResult(h.framework, `call_${c.id}`));
        assert.match(message, c.refusal, c.id);
        assert.strictEqual(await fileBytes(h, `files/${c.id}.png`), null, `${c.id} wrote nothing`);
      }
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * Validates a call against the schema keywords save_recent_image uses. Any
 * other keyword throws rather than being ignored, so this can't pass a schema
 * it doesn't understand.
 */
const SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'description', 'additionalProperties']);
function schemaErrors(schema: Record<string, unknown>, value: Record<string, unknown>): string[] {
  const known = (node: Record<string, unknown>): void => {
    for (const key of Object.keys(node)) {
      if (!SCHEMA_KEYWORDS.has(key)) throw new Error(`schemaErrors does not understand keyword "${key}"`);
    }
  };
  const matches = (v: unknown, type: string): boolean => {
    switch (type) {
      case 'string': return typeof v === 'string';
      case 'integer': return typeof v === 'number' && Number.isInteger(v);
      case 'number': return typeof v === 'number';
      case 'null': return v === null;
      default: throw new Error(`schemaErrors does not understand type "${type}"`);
    }
  };
  known(schema);
  const errors: string[] = [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const name of (schema.required ?? []) as string[]) {
    if (!(name in value)) errors.push(`missing required ${name}`);
  }
  for (const [name, v] of Object.entries(value)) {
    const property = properties[name];
    if (!property) {
      if (schema.additionalProperties === false) errors.push(`unexpected ${name}`);
      continue;
    }
    known(property);
    const types = (Array.isArray(property.type) ? property.type : [property.type]) as string[];
    if (!types.some((t) => matches(v, t))) errors.push(`${name}: ${JSON.stringify(v)} is not ${types.join(' | ')}`);
  }
  return errors;
}

describe('save_recent_image schema as each provider path is sent it (shelf-375; installed membrane)', () => {
  const REF = 'img_k7x3q2_7';
  const SHAPES: Array<Record<string, unknown>> = [
    { path: 'files/a.png' },
    { path: 'files/a.png', ref: REF },
    { path: 'files/a.png', index: 1, count: 2 },
    { path: 'files/a.png', ref: null, index: 1, count: 2 },
    { path: 'files/a.png', ref: REF, index: null, count: null },
    { path: 'files/a.png', ref: null, index: null, count: null },
  ];

  /** The definition the framework actually offers when a workspace is registered. */
  async function offeredDefinition(): Promise<ToolDefinition> {
    const tempDir = mkdtempSync(join(tmpdir(), 'sri-schema-'));
    const mountDir = join(tempDir, 'mount');
    mkdirSync(mountDir, { recursive: true });
    const workspace = new WorkspaceModule({ mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never' }] });
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [workspace as unknown as Module],
      syncIntervalMs: 0,
    });
    try {
      workspace.initStore(framework.getStore());
      const definition = framework.getAllTools().find((t) => t.name === 'save_recent_image');
      assert.ok(definition, 'save_recent_image is offered with a workspace');
      return structuredClone(definition);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const options = (tools: ToolDefinition[], toolMode?: 'xml' | 'native') => ({
    participantMode: 'simple' as const,
    assistantParticipant: 'Claude',
    humanParticipant: 'User',
    systemPrompt: 'You are prime.',
    tools,
    ...(toolMode ? { toolMode } : {}),
  });

  it('Anthropic native input_schema accepts sparse and every-property calls', async () => {
    const definition = await offeredDefinition();
    const built = new NativeFormatter().buildMessages([], options([definition], 'native'));
    const tool = (built.nativeTools as Array<{ name: string; input_schema: Record<string, unknown> }>)
      .find((t) => t.name === 'save_recent_image');
    assert.ok(tool, 'native tools carry save_recent_image');
    for (const shape of SHAPES) assert.deepStrictEqual(schemaErrors(tool.input_schema, shape), [], JSON.stringify(shape));
    assert.notDeepStrictEqual(schemaErrors(tool.input_schema, { path: 'files/a.png', ref: 5 }), [],
      'the validator can refuse a wrong type');
  });

  it('Responses function parameters accept sparse and every-property calls', async () => {
    const definition = await offeredDefinition();
    const built = new OpenAIResponsesFormatter().buildMessages([], options([definition]));
    const tool = (built.nativeTools as Array<{ type: string; name: string; parameters: Record<string, unknown> }>)
      .find((t) => t.name === 'save_recent_image');
    assert.ok(tool, 'Responses tools carry save_recent_image');
    assert.strictEqual(tool.type, 'function');
    for (const shape of SHAPES) assert.deepStrictEqual(schemaErrors(tool.parameters, shape), [], JSON.stringify(shape));
  });

  it('XML tool definitions mark every selector nullable and require only path', async () => {
    const definition = await offeredDefinition();
    const built = new AnthropicXmlFormatter({ toolInjectionMode: 'system' }).buildMessages([], options([definition], 'xml'));
    const system = JSON.stringify(built.systemContent);
    const start = system.indexOf('<tool name=\\"save_recent_image\\">');
    assert.ok(start >= 0, 'the XML system prompt defines save_recent_image');
    const section = system.slice(start, system.indexOf('</tool>', start));
    const parameter = (name: string): string => {
      const match = new RegExp(`<parameter name=\\\\"${name}\\\\"[^>]*>`).exec(section);
      assert.ok(match, `parameter ${name} is rendered`);
      return match[0];
    };
    for (const name of ['ref', 'index', 'count']) {
      // Published membrane renders a type list ("string,null"); newer source
      // renders nullable="true". Either marks the selector nullable.
      assert.match(parameter(name), /type=\\"[^"\\]*\bnull\b|nullable=\\"true\\"/, `${name} is marked nullable`);
      assert.doesNotMatch(parameter(name), /required=/, `${name} is not required`);
    }
    assert.match(parameter('path'), /required=\\"true\\"/, 'path is required');

    // And what the model writes back for an every-property call parses to the
    // shape the native schema accepts.
    const input = parsedXmlInput({ path: 'files/a.png', ref: 'null', index: '1', count: '2' });
    assert.deepStrictEqual(input, { path: 'files/a.png', ref: null, index: 1, count: 2 });
    assert.deepStrictEqual(schemaErrors(definition.inputSchema as unknown as Record<string, unknown>, input), []);
  });
});

describe('ToolImageLedger', () => {
  it('mints one ref per (call, block), idempotently, with digest provenance', () => {
    const ledger = new ToolImageLedger();
    const a = ledger.retain({ toolCallId: 'c1', toolName: 't', blockIndex: 1, data: PNG.toString('base64'), mediaType: 'image/png' });
    const again = ledger.retain({ toolCallId: 'c1', toolName: 't', blockIndex: 1, data: PNG.toString('base64'), mediaType: 'image/png' });
    const b = ledger.retain({ toolCallId: 'c1', toolName: 't', blockIndex: 3, data: GIF.toString('base64'), mediaType: 'image/gif' });
    assert.match(a.ref, REF_1);
    assert.strictEqual(a.ref, `img_${ledger.nonce}_1`);
    assert.ok(TOOL_IMAGE_REF_RE.test(a.ref));
    assert.strictEqual(again.ref, a.ref);
    assert.strictEqual(b.ref, `img_${ledger.nonce}_2`);
    assert.strictEqual(a.sha256, sha(PNG));
    assert.strictEqual(a.byteSize, PNG.byteLength);
    assert.strictEqual(ledger.refFor('c1', 3), b.ref);
    const hit = ledger.lookup(a.ref);
    assert.strictEqual(hit.status, 'retained');
    assert.strictEqual(hit.status === 'retained' ? hit.image.data : null, PNG.toString('base64'));
    assert.strictEqual(ledger.lookup(`img_${ledger.nonce}_9`).status, 'unknown');
    // Another ledger is another namespace: the same sequence is a stranger.
    const other = new ToolImageLedger();
    assert.notStrictEqual(other.nonce, ledger.nonce);
    assert.strictEqual(other.lookup(a.ref).status, 'unknown');
    assert.strictEqual(ledger.lookup('img_1').status, 'unknown');
  });

  it('digests large payloads chunked with the same result as a whole decode', () => {
    const big = Buffer.alloc(1_500_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
    const ledger = new ToolImageLedger();
    const kept = ledger.retain({ toolCallId: 'c', toolName: 't', blockIndex: 0, data: big.toString('base64'), mediaType: 'image/png' });
    assert.strictEqual(kept.byteSize, big.byteLength);
    assert.strictEqual(kept.sha256, sha(big));
    // Whitespace-bearing base64 (legal for decoders) falls back to a whole decode — same answer.
    const wrapped = big.toString('base64').replace(/(.{76})/g, '$1\n');
    const same = ledger.retain({ toolCallId: 'c2', toolName: 't', blockIndex: 0, data: wrapped, mediaType: 'image/png' });
    assert.strictEqual(same.byteSize, Buffer.from(wrapped, 'base64').byteLength);
    assert.strictEqual(same.sha256, sha(Buffer.from(wrapped, 'base64')));
  });

  it('evicts oldest-first over the budget but keeps provenance for the error', () => {
    const ledger = new ToolImageLedger({ maxEntries: 2 });
    for (let i = 0; i < 3; i++) {
      ledger.retain({ toolCallId: `c${i}`, toolName: 'snap', blockIndex: 0, data: PNG.toString('base64'), mediaType: 'image/png' });
    }
    assert.strictEqual(ledger.size, 2);
    const evicted = ledger.lookup(`img_${ledger.nonce}_1`);
    assert.strictEqual(evicted.status, 'evicted');
    assert.strictEqual(evicted.status === 'evicted' ? evicted.image.toolCallId : null, 'c0');
    assert.strictEqual(ledger.lookup(`img_${ledger.nonce}_2`).status, 'retained');
    assert.strictEqual(ledger.lookup(`img_${ledger.nonce}_3`).status, 'retained');
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
      imageRef: (blockIndex) => { seen.push(blockIndex); return `img_abc123_${blockIndex}`; },
    });
    assert.deepStrictEqual(seen, [1, 2], 'block indices are positions in the content array');
    // Size label is the serializer's base64-derived estimate, not the exact byte count.
    assert.match(withRefs, /\[image: image\/png, \d+B, ref img_abc123_1\]/);
    assert.strictEqual(formatToolImagePlaceholder('image/png', '~691KB', 'img_k7x3q2_7'), '[image: image/png, ~691KB, ref img_k7x3q2_7]');
    assert.deepStrictEqual(refsOf(withRefs), ['img_abc123_1', 'img_abc123_2']);
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
    assert.strictEqual(parsed[0]!.kind === 'inline' ? parsed[0]!.ref : null, retained.ref);
    assert.strictEqual(parsed[0]!.mediaType, 'image/png');
  });

  it('any mime a tool sends normalizes to a type/subtype essence that round-trips', () => {
    assert.strictEqual(normalizeMediaType('image/png; charset=binary'), 'image/png');
    assert.strictEqual(normalizeMediaType(' IMAGE/JPEG '), 'image/jpeg');
    assert.strictEqual(normalizeMediaType('image/x_custom'), 'image/x_custom');
    assert.strictEqual(normalizeMediaType('image/svg+xml'), 'image/svg+xml');
    assert.strictEqual(normalizeMediaType('garbage'), FALLBACK_MEDIA_TYPE);
    assert.strictEqual(normalizeMediaType('image/has space'), FALLBACK_MEDIA_TYPE);
    assert.strictEqual(normalizeMediaType(''), FALLBACK_MEDIA_TYPE);
    // The invariant the formatter relies on: whatever comes in, the
    // placeholder written for it re-parses to the normalized mime.
    for (const raw of ['image/png; charset=binary', 'Image/PNG', 'image/x_custom', 'garbage', 'image/a,b', 'image/]', 'text/plain;x=1;y=2']) {
      const mime = normalizeMediaType(raw);
      const parsed = parseImagePlaceholders(formatToolImagePlaceholder(raw, '~1KB', 'img_abc123_1'));
      assert.strictEqual(parsed.length, 1, `must re-parse: ${raw}`);
      assert.strictEqual(parsed[0]!.mediaType, mime, raw);
    }
  });

  it('splitting for truncation keeps every slot at or past the cut, and never leaves a partial one in the head', () => {
    const png = '[image: image/png, ~12KB, ref img_abc123_1]';
    const stub = '[ref_1_ab3d] cam.png — image/jpeg, 1.2MB claimed — from tool result — fetch with fetch_reference';
    const text = `head text\n${png}\nmiddle text that is long enough\n${stub}\ntail\n[image: image/gif, 4B, ref img_abc123_2]`;
    // Cut exactly at the start of the middle text: png stays, stub + gif move.
    const cut1 = text.indexOf('middle');
    const a = splitPreservingImageSlots(text, cut1);
    assert.strictEqual(a.head, text.slice(0, cut1));
    assert.deepStrictEqual(a.tail, [stub, '[image: image/gif, 4B, ref img_abc123_2]']);
    // Cut in the middle of the stub line: the cut moves back to the stub's start.
    const cut2 = text.indexOf('1.2MB');
    const b = splitPreservingImageSlots(text, cut2);
    assert.strictEqual(b.head, text.slice(0, text.indexOf(stub)));
    assert.deepStrictEqual(b.tail, [stub, '[image: image/gif, 4B, ref img_abc123_2]']);
    // Cut in the middle of the png placeholder.
    const cut3 = text.indexOf('~12KB');
    const c = splitPreservingImageSlots(text, cut3);
    assert.strictEqual(c.head, 'head text\n');
    assert.strictEqual(c.tail.length, 3);
    // Head + preserved tail parse to exactly the original slots, in order.
    for (const cut of [cut1, cut2, cut3, 1, text.length - 3]) {
      const { head, tail } = splitPreservingImageSlots(text, cut);
      const rejoined = head + '\n\n[truncated — original was N chars]' + formatPreservedImageSlots(tail);
      assert.deepStrictEqual(
        parseImagePlaceholders(rejoined).map((p) => p.text),
        parseImagePlaceholders(text).map((p) => p.text),
        `cut at ${cut}`,
      );
    }
    // The generic history truncation uses the same rule.
    const truncated = truncateForHistory(text, cut3);
    assert.strictEqual(parseImagePlaceholders(truncated).length, 3);
    assert.match(truncated, /\[truncated — original was \d+ chars\]/);
  });

  it('parses image-typed reference stubs as slots, in text order with inline placeholders', () => {
    const text = [
      'frame one',
      '[image: image/png, ~12KB, ref img_abc123_3]',
      '[ref_1_ab3d] cam.png — image/jpeg, 1.2MB claimed — from tool result — fetch with fetch_reference',
      '[ref_2_zz9q] chord.wav — audio/wav, ~4.0MB claimed — from tool result — fetch with fetch_reference',
    ].join('\n');
    const slots = parseImagePlaceholders(text);
    assert.deepStrictEqual(
      slots.map((s) => (s.kind === 'inline' ? ['inline', s.ref, s.mediaType] : ['reference', s.refId, s.mediaType])),
      [
        ['inline', 'img_abc123_3', 'image/png'],
        ['reference', 'ref_1_ab3d', 'image/jpeg'],
        ['reference', 'ref_2_zz9q', null],
      ],
    );
  });
});
