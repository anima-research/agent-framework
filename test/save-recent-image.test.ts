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
import { UNBOUND_REASON, classifyBlock, referenceRegistry, type ReferenceTestimony } from '../src/mcpl/references.js';
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
  workspace?: (workspace: WorkspaceModule) => void;
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
  opts.workspace?.(workspace);
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

  it("a reference whose claimed type carries bidi controls is the image its stub shows, and its refusal shows the type without them", async () => {
    // The stub shows `Image/PNG`, so after a restart the stub's text alone
    // makes this a slot (matched without regard to case); the record must
    // say the same, or the index slides.
    const c = classifyBlock({ type: 'image', uri: 'https://example.invalid/sri-label.png', mimeType: '\u202EImage/PNG\u061C' });
    assert.strictEqual(c.kind, 'reference');
    // Bound to its server, as a tool result's references are, so its stub is the one seeded below.
    const record = referenceRegistry.register((c as { testimony: ReferenceTestimony }).testimony, 'vst');
    const h = await startTurn({
      prefix: 'sri-reference-label-',
      responses: [[saveCall('call_save', { path: 'files/label.png', index: 0 })], done],
      seedHistory: (framework) => {
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_cam',
          toolName: 'mcpl--vst--camera',
          content: `[${record.refId}] label.png — Image/PNG, 1.2MB claimed — from tool result — fetch with fetch_reference`,
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      const result = await waitForToolResult(h.framework, 'call_save');
      assert.strictEqual(result.isError, true, `index 0 is the reference, not the older GIF: ${result.content}`);
      assert.match(result.content, new RegExp(`index 0 is a reference \\(${record.refId}, image/png, from`));
      assert.ok(!/[\u061C\u202E]/.test(result.content), result.content);
      assert.strictEqual(await fileBytes(h, 'files/label.png'), null);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('an expired reference refuses with its reason; one with a saved copy still points at fetch_reference', async () => {
    // Bound to their server, as a tool result's references are, so the expiry is what the fetcher would refuse.
    const register = (name: string) => {
      const c = classifyBlock({ type: 'image', uri: `https://example.invalid/${name}`, mimeType: 'image/png', expiresAt: '2001-01-01T00:00:00Z' });
      assert.strictEqual(c.kind, 'reference');
      return referenceRegistry.register((c as { testimony: ReferenceTestimony }).testimony, 'vst');
    };
    const kept = register('sri-expired-kept.png');
    kept.fetchedPath = 'files/refs/kept.png'; // saved before its expiry passed: fetch_reference serves it
    const expired = register('sri-expired.png');
    const h = await startTurn({
      prefix: 'sri-reference-expired-',
      responses: [
        [saveCall('call_save0', { path: 'files/expired.png', index: 0 })],
        [saveCall('call_save1', { path: 'files/kept.png', index: 1 })],
        done,
      ],
      seedHistory: (framework) => {
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_cam',
          toolName: 'mcpl--vst--camera',
          content: `[${kept.refId}] kept.png — image/png — from tool result — saved: files/refs/kept.png\n`
            + `[${expired.refId}] expired.png — image/png — from tool result — expired: its expiresAt has passed`,
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      const refused = await waitForToolResult(h.framework, 'call_save0');
      assert.strictEqual(refused.isError, true);
      assert.match(refused.content, new RegExp(`index 0 is a reference \\(${expired.refId}, image/png, from`));
      assert.match(refused.content, /It can't be fetched either — expired: its expiresAt has passed\./);
      assert.ok(!refused.content.includes('fetch_reference'), refused.content);
      const keptRefusal = await waitForToolResult(h.framework, 'call_save1');
      assert.strictEqual(keptRefusal.isError, true);
      assert.match(keptRefusal.content, new RegExp(`index 1 is a reference \\(${kept.refId}, image/png, from`));
      assert.match(keptRefusal.content, /Fetch it with fetch_reference and save the materialized file instead\./);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('an unbound reference refuses with the reason its stub gives, where a bound one still points at fetch_reference', async () => {
    // The first registered with no server, as an in-process module's reference or a
    // channel message's is; the second against its server, as a tool result's is.
    const register = (name: string, serverId?: string) => {
      const c = classifyBlock({ type: 'image', uri: `https://example.invalid/${name}`, mimeType: 'image/png' });
      assert.strictEqual(c.kind, 'reference');
      return referenceRegistry.register((c as { testimony: ReferenceTestimony }).testimony, serverId);
    };
    const unbound = register('sri-unbound.png');
    const bound = register('sri-bound.png', 'vst');
    const h = await startTurn({
      prefix: 'sri-reference-unbound-',
      responses: [
        [saveCall('call_save0', { path: 'files/unbound.png', index: 0 })],
        [saveCall('call_save1', { path: 'files/bound.png', index: 1 })],
        done,
      ],
      seedHistory: (framework) => {
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_render',
          toolName: 'mcpl--vst--render',
          // Index 0 is the newest slot, the last line.
          content: `[${bound.refId}] bound.png — image/png — from tool result — fetch with fetch_reference\n`
            + `[${unbound.refId}] unbound.png — image/png — from tool result — ${UNBOUND_REASON}`,
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      const refused = await waitForToolResult(h.framework, 'call_save0');
      assert.strictEqual(refused.isError, true);
      assert.match(refused.content, new RegExp(`index 0 is a reference \\(${unbound.refId}, image/png, from`));
      assert.ok(refused.content.includes(`It can't be fetched either — ${UNBOUND_REASON}.`), refused.content);
      assert.ok(!refused.content.includes('fetch_reference'), refused.content);
      const boundRefusal = await waitForToolResult(h.framework, 'call_save1');
      assert.strictEqual(boundRefusal.isError, true);
      assert.match(boundRefusal.content, new RegExp(`index 1 is a reference \\(${bound.refId}, image/png, from`));
      assert.match(boundRefusal.content, /Fetch it with fetch_reference and save the materialized file instead\./);
      assert.strictEqual(await fileBytes(h, 'files/unbound.png'), null);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("an attachment's media type is shown and stored as a label, and one with nothing left counts as absent", async () => {
    // The store keeps a declared type only for bytes it can't sniff as a
    // raster image, so these aren't images it knows. Oldest first: a type
    // with controls in it, one that sanitizes to nothing, and a url-source
    // image with no type at all (index 0: not inline, so not saveable).
    const bytes = (tag: string): string => Buffer.from(`not a raster image ${tag}`).toString('base64');
    const h = await startTurn({
      prefix: 'sri-attachment-type-',
      responses: [[saveCall('call_save', { path: 'files/sent.bmp', index: 1, count: 2 })], done],
      seedHistory: (framework) => {
        framework.getAgent('prime')!.getContextManager().addMessage('user', [
          { type: 'image', source: { type: 'base64', data: bytes('a'), mediaType: 'image/\u202Ebmp\u0085' } },
          { type: 'image', source: { type: 'base64', data: bytes('b'), mediaType: '\u202E\u061C' } },
          { type: 'image', source: { type: 'url', url: 'https://example.invalid/sri-url.png' } },
        ] as unknown as ContentBlock[]);
      },
    });
    try {
      const result = await waitForToolResult(h.framework, 'call_save');
      assert.ok(!/[\u0085\u061C\u202E]/.test(result.content), result.content);
      const receipts = saved(result);
      assert.deepStrictEqual(receipts.map((r) => [r.imageIndex, r.mediaType, r.mimeType]), [
        [1, 'image/png', 'image/png'],
        [2, 'image/bmp', 'image/bmp'],
      ]);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a reference with no record shows its type bounded as a stub would, and says to re-run the tool', async () => {
    // A stub line the registry has no record of (after a restart, or quoted
    // text), whose type is far longer than a stub would show.
    const longType = `image/${'x'.repeat(300)}`;
    const h = await startTurn({
      prefix: 'sri-reference-unknown-',
      responses: [[saveCall('call_save', { path: 'files/long.png', index: 0 })], done],
      seedHistory: (framework) => {
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_cam',
          toolName: 'mcpl--vst--camera',
          content: `[ref_3_cc02] long.png — ${longType} — from tool result — fetch with fetch_reference`,
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      const result = await waitForToolResult(h.framework, 'call_save');
      assert.strictEqual(result.isError, true);
      assert.ok(result.content.includes(`(ref_3_cc02, image/${'x'.repeat(113)}…, from`), result.content);
      assert.match(result.content, /holds no record of it .*If its tool can produce it again, re-run that tool for a fresh reference\./);
      assert.ok(!result.content.includes('Fetch it with fetch_reference'), result.content);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('an image-typed RFC-005 reference stub with no record still occupies a failing slot', async () => {
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
      assert.match(result.content, /holds no record of it/, 'no record here: fetch_reference could only call it unknown');
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

it('a write that throws before its tree entry names the images already saved', async () => {
  const h = await startTurn({
    prefix: 'sri-throw-',
    responses: [
      [snapCall('call_snap')],
      [saveCall('call_save', { path: 'files/images.png', index: 0, count: 2 })],
      done,
    ],
    workspace: (workspace) => {
      const write = workspace.writeBinary.bind(workspace);
      let writes = 0;
      workspace.writeBinary = async (...args) => {
        if (++writes === 2) throw new Error('injected tree exception');
        return write(...args);
      };
    },
  });
  try {
    const result = await waitForToolResult(h.framework, 'call_save');
    assert.equal(result.isError, true);
    assert.match(result.content, /injected tree exception/);
    assert.match(result.content, /already saved: files\/images-0.png/);
  } finally { await h.framework.stop(); rmSync(h.tempDir, { recursive: true, force: true }); }
});

it('a save whose write fails after its tree entry, through the workspace itself, is reported saved with its failure', async () => {
  const h = await startTurn({
    prefix: 'sri-tree-real-',
    responses: [
      [snapCall('call_snap')],
      [saveCall('call_save', { path: 'files/images.png', index: 0, count: 1 })],
      done,
    ],
    workspace: (workspace) => {
      const ws = workspace as unknown as { intents: Map<string, { update: (...args: unknown[]) => unknown }> };
      const intents = [...ws.intents.values()][0];
      intents.update = () => { throw new Error('injected intent exception'); };
    },
  });
  try {
    const result = await waitForToolResult(h.framework, 'call_save');
    const files = saved(result);
    assert.equal(files.length, 1);
    assert.equal(files[0].inChronicle, true);
    assert.match(String(files[0].diskCopyError), /the rest of the write failed: injected intent exception/);
    assert.ok((await fileBytes(h, String(files[0].path)))?.equals(PNG));
  } finally { await h.framework.stop(); rmSync(h.tempDir, { recursive: true, force: true }); }
});

for (const secondFails of [false, true]) {
  it(`a tree-only image save ${secondFails ? 'appears in a later failure receipt' : 'succeeds with a disk-copy warning'}`, async () => {
    const h = await startTurn({
      prefix: 'sri-tree-only-',
      responses: [
        [snapCall('call_snap')],
        [saveCall('call_save', { path: 'files/images.png', index: 0, count: 2 })],
        done,
      ],
      workspace: (workspace) => {
        const write = workspace.writeBinary.bind(workspace);
        let writes = 0;
        workspace.writeBinary = async (...args) => {
          if (++writes === 2 && secondFails) return { success: false, error: 'tree unavailable', isError: true };
          const result = await write(...args);
          assert.equal(result.success, true);
          return { success: false, data: { inChronicle: true }, error: 'injected disk-copy failure', isError: true };
        };
      },
    });
    try {
      const result = await waitForToolResult(h.framework, 'call_save');
      if (secondFails) {
        assert.equal(result.isError, true);
        assert.match(result.content, /tree unavailable/);
        assert.match(result.content, /already saved: files\/images-0.png/);
      } else {
        const files = saved(result);
        assert.equal(files.length, 2);
        assert.equal(files[0].path, 'files/images-0.png');
        assert.equal(files[0].inChronicle, true);
        assert.match(String(files[0].diskCopyError), /injected disk-copy failure/);
        assert.equal(files[0].size, PNG.byteLength);
        assert.equal(files[0].mimeType, 'image/png');
      }
      assert.ok((await fileBytes(h, 'files/images-0.png'))?.equals(PNG));
    } finally { await h.framework.stop(); rmSync(h.tempDir, { recursive: true, force: true }); }
  });
}
