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
 *   6. truncation/spill keeps the image slots the resident saw, and keeps
 *      none they didn't see: a result carrying images keeps past its cut
 *      the image slots its live copy showed, the newest 64 of them that fit
 *      the readers' bound, saying how many it left out; a text result,
 *      whose live copy is its stored text, keeps none past the cut; and no
 *      cut ends in part of a slot (#403).
 *   7. a save dispatched in the same batch as the snapshot waits for it.
 *   8. refs are namespaced per ledger — a stale ref resolves to nothing,
 *      and a direct `ref` is saved through its occurrence in context.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  ModuleContext,
  ProcessEvent,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import {
  FALLBACK_MEDIA_TYPE,
  MAX_KEPT_IMAGE_SLOTS,
  TOOL_IMAGE_REF_RE,
  ToolImageLedger,
  cutStoredToolResult,
  formatKeptImageSlots,
  formatToolImagePlaceholder,
  normalizeMediaType,
  parseImagePlaceholders,
  type ShownRanges,
} from '../src/tool-image-ledger.js';
import { toolResultDataToHistoryString, truncateForHistory, type HistoryBlockSpan } from '../src/tool-result-history.js';
import {
  INLINE_WITHHELD_TEXT,
  REFERENCE_STUB_MAX_CHARS,
  UNBOUND_REASON,
  buildReferenceStub,
  classifyBlock,
  noAddressReason,
  referenceRegistry,
  type ReferenceTestimony,
} from '../src/mcpl/references.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

/** Give the framework MCPL server configs for its fetcher to resolve, without
 *  connecting to them: a ws:// or wss:// url for one the host connects to over
 *  a network, a command alone for a stdio server. */
function configureServers(framework: AgentFramework, configs: Array<{ id: string; url?: string; command?: string; autofetch?: { maxTotalBytes?: number } }>): void {
  const configure = (framework as unknown as { setMcplServerConfig(config: unknown): void }).setMcplServerConfig.bind(framework);
  for (const config of configs) configure(config);
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const REF_1 = /^img_[0-9a-z]+_1$/;
/** ~30k chars — past the smallest allowed inline cap (1000) many times over. */
const LONG_TEXT = 'line of scan output\n'.repeat(1500);
/** A channel attachment as the framework renders a reference, one line each
 *  (#403's probe): image-typed for an even `i`, text/plain for an odd one. */
const attachmentLine = (i: number): string => (i % 2 === 0
  ? `[ref_${i.toString(36)}_ab3d] item${i}.png — image/png, ~10KB claimed — attachment on channel message — fetch with fetch_reference`
  : `[ref_${i.toString(36)}_ab3d] item${i}.txt — text/plain, ~10KB claimed — attachment on channel message — fetch with fetch_reference`);
/** 3,000 characters of channel text, then 200 attachment lines, 100 of them
 *  images: all past the smallest allowed inline cap. */
const LISTING = ['x'.repeat(3000), ...Array.from({ length: 200 }, (_, i) => attachmentLine(i))].join('\n');
/** 100 referenced frames, each image-typed and named for its number. */
const FRAMES = Array.from({ length: 100 }, (_, i) => ({
  type: 'image', uri: `https://cam.example/sri-frame-${i}.png`, name: `frame-${i}.png`, mimeType: 'image/png', sizeBytes: 1200,
}));
/** A caption after a picture, quoting two attachment lines: the first within
 *  the smallest allowed inline cap (1000) of its own block, the second past it. */
const CAPTION = `caption\n${attachmentLine(0)}\n${'y'.repeat(1200)}\n${attachmentLine(2)}`;
/** A caption whose own cap (1000) falls 49 characters into a quoted
 *  reference line, after the placeholder that line quotes. */
const QUOTING_CAPTION = `${'y'.repeat(950)}\n[ref_7_ab3d] quoting [image: image/png, 68B] — image/png, ~1KB claimed — from tool result — fetch with fetch_reference`;
/** A quoted line shaped like a stub, too long to be a slot whole, that shows
 *  an image type early. */
const QUOTED_LINE = `[ref_9_ab3d] quoted — image/png ${'z'.repeat(1500)}`;
/** Text results whose inline cap (1000) falls inside a stub-shaped line: an
 *  attachment line, after its type; the quoted line, 499 characters in; and
 *  the quoted line from the text's start, 1000 characters in. */
const SPLIT_TEXTS = {
  split_stub: `${'x'.repeat(900)}\n${attachmentLine(0)}`,
  split_quoted: `${'x'.repeat(500)}\n${QUOTED_LINE}`,
  giant_line: QUOTED_LINE,
} as const;
/** A text result with an attachment line inside its cap (1000) but past the
 *  head a bound of 1000 leaves it, with room for the notice. */
const MID_SLOT_TEXT = `${'x'.repeat(500)}\n${attachmentLine(0)}\n${'x'.repeat(1000)}`;
/** A text result within a cap of 1000, with an attachment line past what a
 *  bound of 1200 leaves the head beside the notice's room. */
const NEAR_SLOT_TEXT = `${'x'.repeat(700)}\n${attachmentLine(0)}\n${'x'.repeat(100)}`;
/** 24 attachment lines, 12 of them images: under a cap of 4000 its block is
 *  shown whole, and its slots take more than the notice's room leaves. */
const LISTING_24 = Array.from({ length: 24 }, (_, i) => attachmentLine(i)).join('\n');

/** World module: `snap` returns a native PNG image block; the other tools
 *  are the review's representations of the same result, one shape each. */
class SnapModule implements Module {
  readonly name = 'world';
  /** The `quote` tool cites this ref — set by the test once it knows it. */
  quotedRef = 'img_zzzzzz_1';
  snapAfterCall: string | null = null;
  private readonly started = new Set<string>();
  private readonly onStarted = new Set<() => void>();
  async start(ctx: ModuleContext): Promise<void> {
    ctx.onTrace((event) => {
      if (event.type !== 'tool:started') return;
      this.started.add(event.callId);
      for (const check of [...this.onStarted]) check();
    });
  }
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
      { name: 'listing', description: 'A channel listing, as text.', inputSchema: schema },
      { name: 'listing_parts', description: 'Channel text, then an attachment line, as two text blocks.', inputSchema: schema },
      { name: 'snap_listing', description: 'A channel listing, then a picture.', inputSchema: schema },
      { name: 'snap_frames', description: 'A scan, 100 referenced frames, then a picture.', inputSchema: schema },
      { name: 'snap_captioned', description: 'A scan, a picture, then a caption.', inputSchema: schema },
      { name: 'snap_mystery', description: 'A picture beside a block of no known shape.', inputSchema: schema },
      { name: 'snap_quoting', description: 'A picture, then a caption quoting a reference line.', inputSchema: schema },
      { name: 'snap_named_ref', description: 'A picture, then a referenced one with a long name.', inputSchema: schema },
      ...Object.keys(SPLIT_TEXTS).map((name) => ({ name, description: 'Text cut inside a stub-shaped line.', inputSchema: schema })),
      { name: 'mid_slot', description: 'Text with an attachment line inside the cap.', inputSchema: schema },
      { name: 'near_slot', description: 'Text within the cap, with an attachment line near its end.', inputSchema: schema },
      { name: 'snap_listed', description: 'Text, a snapshot, then 24 attachment lines.', inputSchema: schema },
      { name: 'snap_noted', description: 'A short note, then a picture.', inputSchema: schema },
      { name: 'quiet_failure', description: 'A failure not flagged as an error.', inputSchema: schema },
      { name: 'loud_failure', description: 'An error result.', inputSchema: schema },
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
      case 'listing':
        return { success: true, data: [{ type: 'text', text: LISTING }] };
      case 'listing_parts':
        return { success: true, data: [{ type: 'text', text: 'x'.repeat(1500) }, { type: 'text', text: attachmentLine(0) }] };
      case 'snap_listing':
        return { success: true, data: [{ type: 'text', text: LISTING }, png] };
      case 'snap_frames':
        return { success: true, data: [{ type: 'text', text: 'x'.repeat(1500) }, ...FRAMES, png] };
      case 'snap_captioned':
        return { success: true, data: [{ type: 'text', text: 'x'.repeat(1500) }, png, { type: 'text', text: CAPTION }] };
      case 'snap_mystery':
        // A block of no known shape: both converters give the array up, so
        // its live copy is its JSON, as stored.
        return {
          success: true,
          data: [png, { type: 'text', text: `${'x'.repeat(1500)}\n[image: image/png, 68B]` }, { type: 'mystery' }],
        };
      case 'snap_quoting':
        return { success: true, data: [png, { type: 'text', text: QUOTING_CAPTION }] };
      case 'split_stub':
      case 'split_quoted':
      case 'giant_line':
        return { success: true, data: [{ type: 'text', text: SPLIT_TEXTS[call.name as keyof typeof SPLIT_TEXTS] }] };
      case 'mid_slot':
        return { success: true, data: [{ type: 'text', text: MID_SLOT_TEXT }] };
      case 'near_slot':
        return { success: true, data: [{ type: 'text', text: NEAR_SLOT_TEXT }] };
      case 'snap_noted':
        return { success: true, data: [{ type: 'text', text: 'n'.repeat(290) }, png] };
      case 'snap_listed':
        return { success: true, data: [{ type: 'text', text: 'x'.repeat(3000) }, png, { type: 'text', text: LISTING_24 }] };
      case 'quiet_failure':
        // No data, so its error text is what history stores, and it quotes
        // a placeholder from before retention existed.
        return { success: false, error: 'camera busy; last frame: [image: image/png, 68B]' };
      case 'loud_failure':
        // An error result is stored as its error text, whatever data it
        // carries beside it.
        return { success: false, isError: true, error: 'camera down; last frame: [image: image/png, 68B]', data: [png] };
      case 'snap_named_ref':
        // A picture, then a referenced one whose stub, with its long name,
        // is longer than a small inline cap.
        return {
          success: true,
          data: [png, { type: 'image', uri: 'https://cam.example/sri-named.png', name: `${'n'.repeat(200)}.png`, mimeType: 'image/png', sizeBytes: 1200 }],
        };
      default:
        if (this.snapAfterCall !== null) {
          const id = this.snapAfterCall;
          await new Promise<void>((resolve, reject) => {
            const bound = setTimeout(() => { this.onStarted.delete(check); reject(new Error(`the call ${id} never started`)); }, 10_000);
            const check = () => { if (this.started.has(id)) { clearTimeout(bound); this.onStarted.delete(check); resolve(); } };
            this.onStarted.add(check);
            check();
          });
        }
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
  /** The agent's resolved inline cap, below the configurable minimum, as a
   *  small strategy bound gives one. */
  inlineCap?: number;
  /** With inlineCap, the smallest per-message bound among the readers of
   *  the agent's store, which a stored copy must fit. */
  inlineBound?: number;
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
  if (opts.inlineCap !== undefined) {
    const cap = opts.inlineCap;
    const bound = opts.inlineBound;
    (framework as unknown as { resolveToolResultInlineCap: () => { cap: number; bound: number | undefined } })
      .resolveToolResultInlineCap = () => ({ cap, bound });
  }
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

  it('each file a save to a mount without autoMaterialize writes says it waits for a materialize, and disk has them only after one', async () => {
    const h = await startTurn({
      prefix: 'sri-disk-',
      responses: [
        [snapCall('call_snap')],
        [saveCall('call_save', { path: 'files/pic.png', index: 0, count: 2 })],
        done,
      ],
    });
    try {
      const files = saved(await waitForToolResult(h.framework, 'call_save'));
      assert.deepEqual(files.map((f) => [f.path, f.disk]), [['files/pic-0.png', 'waits for materialize'], ['files/pic-1.png', 'waits for materialize']]);
      assert.deepEqual(['pic-0.png', 'pic-1.png'].map((name) => existsSync(join(h.mountDir, name))), [false, false], 'not on disk before a materialize');
      await h.workspace.handleToolCall({ id: 'call_materialize', name: 'materialize', input: { path: 'files' }, callerAgentName: 'prime' });
      assert.ok(readFileSync(join(h.mountDir, 'pic-0.png')).equals(PNG), 'the snapshot is on disk after it');
      assert.ok(readFileSync(join(h.mountDir, 'pic-1.png')).equals(GIF), 'the attachment is on disk after it');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("another agent's stored context injection isn't in the caller's view, so its image takes no slot: index 0 is the attachment", async () => {
    const h = await startTurn({
      prefix: 'sri-other-injection-',
      responses: [
        [saveCall('call_save0', { path: 'files/avatar.gif', index: 0 })],
        done,
      ],
      // After the attachment, a resident sharing the slot stored an injection
      // carrying an image (stored-injections.ts): prime's view leaves it out.
      seedHistory: (framework) => framework.getAgent('prime')!.getContextManager().addMessage('system_context:lessons', [
        { type: 'text', text: "helper's lesson" },
        { type: 'image', source: { type: 'base64', data: PNG.toString('base64'), mediaType: 'image/png' } },
      ] as ContentBlock[], { system: true, kind: 'context-injection', contextInjection: { agent: 'helper', namespace: 'lessons', contentHash: 'h', part: 0, parts: 1 } }),
    });
    try {
      const first = saved(await waitForToolResult(h.framework, 'call_save0'));
      assert.strictEqual(first[0]!.source, 'attachment');
      assert.strictEqual(first[0]!.sha256, sha(GIF));
      assert.ok((await fileBytes(h, 'files/avatar.gif'))?.equals(GIF), "index 0 is the attachment, not the other agent's image");
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("a row a tune-out holds from the residents isn't in the caller's view, so its image takes no slot: index 0 is the attachment", async () => {
    const h = await startTurn({
      prefix: 'sri-tuned-out-',
      responses: [
        [saveCall('call_save0', { path: 'files/avatar.gif', index: 0 })],
        done,
      ],
      seedHistory: (framework) => framework.getAgent('prime')!.getContextManager().addMessage('user', [
        { type: 'text', text: 'diverted' },
        { type: 'image', source: { type: 'base64', data: PNG.toString('base64'), mediaType: 'image/png' } },
      ] as ContentBlock[], { tuneOut: { epochId: 'epoch-1' } }),
    });
    try {
      const first = saved(await waitForToolResult(h.framework, 'call_save0'));
      assert.strictEqual(first[0]!.source, 'attachment');
      assert.strictEqual(first[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("the caller's own stored context injection is in its view, so its image takes index 0", async () => {
    const h = await startTurn({
      prefix: 'sri-own-injection-',
      responses: [
        [saveCall('call_save0', { path: 'files/lesson.png', index: 0 })],
        done,
      ],
      seedHistory: (framework) => framework.getAgent('prime')!.getContextManager().addMessage('system_context:lessons', [
        { type: 'text', text: 'my lesson' },
        { type: 'image', source: { type: 'base64', data: PNG.toString('base64'), mediaType: 'image/png' } },
      ] as ContentBlock[], { system: true, kind: 'context-injection', contextInjection: { agent: 'prime', namespace: 'lessons', contentHash: 'h', part: 0, parts: 1 } }),
    });
    try {
      const first = saved(await waitForToolResult(h.framework, 'call_save0'));
      assert.strictEqual(first[0]!.sha256, sha(PNG));
      assert.ok((await fileBytes(h, 'files/lesson.png'))?.equals(PNG), "index 0 is the caller's own injection image");
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
      // An embedded image nested in a tool's data is kept only as its
      // placeholder too, and a re-run records it the same way.
      assert.match(result.content, /nested in the tool's data rather than its content/);
      assert.match(result.content, /unless the image came nested in its data, which a re-run records the same way/);
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
        configureServers(framework, [{ id: 'vst', url: 'wss://example.invalid' }]);
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_cam',
          toolName: 'mcpl--vst--camera',
          content: `[${kept.refId}] kept.png — image/png — from tool result — saved: files/refs/kept.png\n`
            + `[${expired.refId}] expired.png — image/png — from tool result — expired`,
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      const refused = await waitForToolResult(h.framework, 'call_save0');
      assert.strictEqual(refused.isError, true);
      assert.match(refused.content, new RegExp(`index 0 is a reference \\(${expired.refId}, image/png, from`));
      assert.match(refused.content, /It can't be fetched either — the reference is expired\. Once a fresh reference to it arrives, fetching may work; until then, fetching it again won't\./);
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
        configureServers(framework, [{ id: 'vst', url: 'wss://example.invalid' }]);
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
      assert.ok(refused.content.includes(
        `It can't be fetched either — it's ${UNBOUND_REASON}. Once a fresh reference to it arrives, fetching may work; until then, fetching it again won't.`,
      ), refused.content);
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

  it("a bound reference the fetcher would refuse before dialing refuses with the fetcher's own reason", async () => {
    // Each bound to a server: one with no address (a stdio server), one whose
    // address is on another origin, one the host doesn't know, one claimed
    // over a fetch's ceiling, and one from a server whose budget is spent.
    const register = (uri: string, serverId: string, sizeBytes?: number) => {
      const c = classifyBlock({ type: 'image', uri, mimeType: 'image/png', ...(sizeBytes === undefined ? {} : { sizeBytes }) });
      assert.strictEqual(c.kind, 'reference');
      return referenceRegistry.register((c as { testimony: ReferenceTestimony }).testimony, serverId);
    };
    const spent = register('https://example.invalid/sri-spent.png', 'spent');
    const big = register('https://example.invalid/sri-big.png', 'vst', 512 * 1024 * 1024);
    const gone = register('https://example.invalid/sri-gone.png', 'gone');
    const offOrigin = register('https://cdn.example.invalid/sri-off-origin.png', 'vst');
    const noAddress = register('https://example.invalid/sri-no-address.png', 'stdio');
    const h = await startTurn({
      prefix: 'sri-reference-refused-',
      responses: [
        [saveCall('call_save0', { path: 'files/no-address.png', index: 0 })],
        [saveCall('call_save1', { path: 'files/off-origin.png', index: 1 })],
        [saveCall('call_save2', { path: 'files/gone.png', index: 2 })],
        [saveCall('call_save3', { path: 'files/big.png', index: 3 })],
        [saveCall('call_save4', { path: 'files/spent.png', index: 4 })],
        done,
      ],
      seedHistory: (framework) => {
        configureServers(framework, [
          { id: 'vst', url: 'wss://example.invalid' },
          { id: 'stdio', command: 'stdio-server' },
          { id: 'spent', url: 'wss://example.invalid', autofetch: { maxTotalBytes: 0 } },
        ]);
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_refs',
          toolName: 'mcpl--vst--render',
          // Index 0 is the newest slot, the last line.
          content: [spent, big, gone, offOrigin, noAddress].map((r) => `[${r.refId}] image/png — from tool result — fetch with fetch_reference`).join('\n'),
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      // The fetcher's clause, then what calling again can do, as fetch_reference would say them.
      const nothing = "Calling again won't change that.";
      const expected = [
        ['call_save0', noAddress.refId, `It can't be fetched either — ${noAddressReason('stdio')}. ${nothing}`],
        ['call_save1', offOrigin.refId, "It can't be fetched either — it points to https://cdn.example.invalid, not to the \"vst\" server's own address "
          + `(wss://example.invalid), and this host fetches only from the server itself. ${nothing}`],
        ['call_save2', gone.refId, "It can't be fetched either — this host no longer has the \"gone\" server it came from. "
          + "Calling again won't change that unless whoever runs this host adds that server back."],
        ['call_save3', big.refId, "It can't be fetched either — it claims 536870912 bytes, over the 268435456 bytes this host fetches at most. "
          + "No max_bytes or setting lifts that limit, so calling again won't change it."],
        ['call_save4', spent.refId, "It can't be fetched either — this host's fetch budget for the \"spent\" server is used up (0 of 0 bytes). "
          + "The budget doesn't renew on its own, so calling again won't change that unless whoever runs this host raises or renews it."],
      ] as const;
      for (const [call, refId, reason] of expected) {
        const refused = await waitForToolResult(h.framework, call);
        assert.strictEqual(refused.isError, true);
        assert.ok(refused.content.includes(`a reference (${refId}, image/png, from`), refused.content);
        assert.ok(refused.content.includes(reason), refused.content);
        assert.ok(!refused.content.includes('fetch_reference'), refused.content);
      }
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

  it("a reference stub is a slot by the type its text shows, whatever the registry's record says now", async () => {
    // The stored stub showed image/png. The reference was then issued again
    // with testimony saying text/plain, which replaces an unfetched record's.
    // The resident saw an image reference, so index 0 is its slot, as it is
    // after a restart, with no record at all.
    const uri = 'https://example.invalid/sri-reissued.png';
    const first = classifyBlock({ type: 'image', uri, mimeType: 'image/png' });
    const record = referenceRegistry.register((first as { testimony: ReferenceTestimony }).testimony);
    const again = classifyBlock({ type: 'resource', uri, mimeType: 'text/plain' });
    referenceRegistry.register((again as { testimony: ReferenceTestimony }).testimony);
    assert.strictEqual(referenceRegistry.get(record.refId)?.testimony.mimeType, 'text/plain');
    const h = await startTurn({
      prefix: 'sri-reference-reissued-',
      responses: [[saveCall('call_save', { path: 'files/reissued.png', index: 0 })], done],
      seedHistory: (framework) => {
        framework.getAgent('prime')!.getContextManager().addMessage('user', [{
          type: 'tool_result',
          toolUseId: 'call_cam',
          toolName: 'mcpl--vst--camera',
          content: `[${record.refId}] reissued.png — image/png — from tool result — fetch with fetch_reference`,
          isError: false,
        }] as ContentBlock[]);
      },
    });
    try {
      const result = await waitForToolResult(h.framework, 'call_save');
      assert.strictEqual(result.isError, true, `index 0 is the reference, not the older GIF: ${result.content}`);
      assert.match(result.content, new RegExp(`index 0 is a reference \\(${record.refId}, image/png, from mcpl--vst--camera`));
      assert.strictEqual(await fileBytes(h, 'files/reissued.png'), null);
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

  it('a text result is cut at the cap with no image slot kept past it: its live copy is that text (#403)', async () => {
    const h = await startTurn({
      prefix: 'sri-text-cut-',
      toolResultInlineMaxChars: 1000,
      responses: [
        [
          { type: 'tool_use', id: 'call_listing', name: 'world--listing', input: {} } as ContentBlock,
          { type: 'tool_use', id: 'call_parts', name: 'world--listing_parts', input: {} } as ContentBlock,
        ],
        [saveCall('call_save', { path: 'files/avatar.gif', index: 0 })],
        done,
      ],
    });
    try {
      const stored = await waitForToolResult(h.framework, 'call_listing');
      assert.strictEqual(stored.content.slice(0, 1000), LISTING.slice(0, 1000), 'the head is the first 1000 characters');
      assert.match(stored.content.slice(1000), /^\n\n\[truncated — showing 1000 of \d+ chars; full content: workspace file [^\]]+\]$/);
      // A content array of text blocks alone is a text result too: its live
      // copy is its stored text, not its blocks each cut at the cap.
      const parts = await waitForToolResult(h.framework, 'call_parts');
      assert.match(parts.content.slice(1000), /^\n\n\[truncated — showing 1000 of 1611 chars; full content: workspace file [^\]]+\]$/);
      // The image-typed lines past each cut were never shown, so none
      // counts: index 0 is the older GIF.
      const gif = saved(await waitForToolResult(h.framework, 'call_save'));
      assert.strictEqual(gif[0]!.source, 'attachment');
      assert.strictEqual(gif[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a result carrying an image keeps past its cut only the image slots its live copy showed (#403)', async () => {
    const h = await startTurn({
      prefix: 'sri-image-cut-',
      toolResultInlineMaxChars: 1000,
      responses: [
        [{ type: 'tool_use', id: 'call_snap_listing', name: 'world--snap_listing', input: {} } as ContentBlock],
        [saveCall('call_save_newest', { path: 'files/snap.png', index: 0 })],
        [saveCall('call_save_older', { path: 'files/avatar.gif', index: 1 })],
        done,
      ],
    });
    try {
      const stored = await waitForToolResult(h.framework, 'call_snap_listing');
      // The live copy showed the listing up to the cap, all filler, and the
      // snapshot: of the slots past the cut, it showed only the snapshot's.
      assert.match(stored.content, /\n\[1 image slot\(s\) fell past the cut; kept here in order so save_recent_image still counts them:\]\n\[image: image\/png, /);
      assert.deepStrictEqual(parseImagePlaceholders(stored.content).map((s) => (s.kind === 'inline' ? s.ref : s.text)), [refOf(h, 1)]);
      assert.doesNotMatch(stored.content, /\[ref_/);
      // Index 0 is the snapshot and index 1 the older GIF, as a resident
      // counting what they saw would count.
      const newest = saved(await waitForToolResult(h.framework, 'call_save_newest'));
      assert.strictEqual(newest[0]!.toolCallId, 'call_snap_listing');
      assert.strictEqual(newest[0]!.sha256, sha(PNG));
      const older = saved(await waitForToolResult(h.framework, 'call_save_older'));
      assert.strictEqual(older[0]!.source, 'attachment');
      assert.strictEqual(older[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it(`a result carrying an image keeps the newest ${MAX_KEPT_IMAGE_SLOTS} of the image slots its live copy showed past its cut`, async () => {
    const h = await startTurn({
      prefix: 'sri-frames-cut-',
      toolResultInlineMaxChars: 1000,
      responses: [
        [{ type: 'tool_use', id: 'call_frames', name: 'world--snap_frames', input: {} } as ContentBlock],
        [saveCall('call_save_newest', { path: 'files/snap.png', index: 0 })],
        [saveCall('call_save_past', { path: 'files/avatar.gif', index: MAX_KEPT_IMAGE_SLOTS })],
        done,
      ],
    });
    try {
      const stored = await waitForToolResult(h.framework, 'call_frames');
      // The live copy showed every frame's stub whole, and the snapshot,
      // whatever the scan's length: 101 slots past the cut.
      assert.match(stored.content, /\n\[101 image slot\(s\) fell past the cut\. The last 64 are kept here in order so save_recent_image still counts them; the 37 before them are left out, and it doesn't count them:\]\n/);
      assert.deepStrictEqual(
        parseImagePlaceholders(stored.content).map((s) => (s.kind === 'inline' ? s.ref : /frame-(\d+)\.png/.exec(s.text)?.[1])),
        [...Array.from({ length: 63 }, (_, n) => String(37 + n)), refOf(h, 1)],
        'the newest 63 frames, then the snapshot',
      );
      // Index 0 is the snapshot. Index 64 is past every kept slot, so it is
      // the older GIF.
      const newest = saved(await waitForToolResult(h.framework, 'call_save_newest'));
      assert.strictEqual(newest[0]!.toolCallId, 'call_frames');
      assert.strictEqual(newest[0]!.sha256, sha(PNG));
      const past = saved(await waitForToolResult(h.framework, 'call_save_past'));
      assert.strictEqual(past[0]!.source, 'attachment');
      assert.strictEqual(past[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('the live copy cuts a text block beside an image as the stored copy cuts, and the index counts what it showed', async () => {
    const h = await startTurn({
      prefix: 'sri-live-cut-',
      toolResultInlineMaxChars: 1000,
      responses: [
        [{ type: 'tool_use', id: 'call_quoting', name: 'world--snap_quoting', input: {} } as ContentBlock],
        [saveCall('call_save_snap', { path: 'files/snap.png', index: 0 })],
        [saveCall('call_save_gif', { path: 'files/avatar.gif', index: 1 })],
        done,
      ],
    });
    try {
      const snap = saved(await waitForToolResult(h.framework, 'call_save_snap'));
      // The caption's cap falls inside its quoted reference line, after the
      // placeholder the line quotes. The live copy's cut moves back to the
      // line's start, so the resident saw the picture and the caption up to
      // that line, and no part of it.
      const [round] = h.membrane.lastStream!.receivedToolResults as Array<Array<{ toolUseId: string; content: unknown }>>;
      const live = round!.find((r) => r.toolUseId === 'call_quoting')!.content as Array<{ type: string; text?: string }>;
      assert.deepStrictEqual(live.map((b) => b.type), ['image', 'text']);
      const caption = live[1]!.text!;
      assert.ok(
        caption.startsWith(`${'y'.repeat(950)}\n\n\n[truncated — original was ${QUOTING_CAPTION.length} chars`),
        caption.slice(940, 1010),
      );
      assert.doesNotMatch(caption, /\[ref_|\[image:/);
      // The stored copy counts what the live copy showed: index 0 is the
      // picture, and index 1 the older GIF.
      const stored = await waitForToolResult(h.framework, 'call_quoting');
      assert.deepStrictEqual(parseImagePlaceholders(stored.content).map((s) => (s.kind === 'inline' ? s.ref : s.text)), [refOf(h, 1)]);
      assert.strictEqual(snap[0]!.toolCallId, 'call_quoting');
      assert.strictEqual(snap[0]!.sha256, sha(PNG));
      const gif = saved(await waitForToolResult(h.framework, 'call_save_gif'));
      assert.strictEqual(gif[0]!.source, 'attachment');
      assert.strictEqual(gif[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('at an inline cap shorter than a reference stub, the stub the live copy showed whole is kept past the cut', async () => {
    const h = await startTurn({
      prefix: 'sri-small-cap-',
      inlineCap: 100,
      responses: [
        [{ type: 'tool_use', id: 'call_named', name: 'world--snap_named_ref', input: {} } as ContentBlock],
        [saveCall('call_save_png', { path: 'files/one.png', index: 1 })],
        [saveCall('call_save_gif', { path: 'files/two.gif', index: 2 })],
        done,
      ],
    });
    try {
      // The live copy cuts only text blocks at the cap, and showed the
      // reference's stub whole beside the picture; the stored text is cut
      // inside that stub, so the stub is kept after the notice.
      const stored = await waitForToolResult(h.framework, 'call_named');
      const slots = parseImagePlaceholders(stored.content);
      assert.deepStrictEqual(slots.map((s) => s.kind), ['inline', 'reference'], stored.content);
      assert.ok(slots[1]!.text.length > 100, 'the stub is longer than the cap');
      assert.match(stored.content, /\n\[1 image slot\(s\) fell past the cut; kept here in order so save_recent_image still counts them:\]\n\[ref_/);
      // Index 0 is the reference, index 1 the picture, index 2 the older GIF.
      // (Receipts are cut at this cap too, so the files say what was saved.)
      await waitForToolResult(h.framework, 'call_save_png');
      assert.ok((await fileBytes(h, 'files/one.png'))?.equals(PNG), 'index 1 is the picture');
      await waitForToolResult(h.framework, 'call_save_gif');
      assert.ok((await fileBytes(h, 'files/two.gif'))?.equals(GIF), 'index 2 is the older GIF');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("past its cut, a result carrying an image keeps a later block's slot its live copy showed, and none it cut away", async () => {
    const h = await startTurn({
      prefix: 'sri-captioned-cut-',
      toolResultInlineMaxChars: 1000,
      responses: [
        [{ type: 'tool_use', id: 'call_captioned', name: 'world--snap_captioned', input: {} } as ContentBlock],
        [saveCall('call_save_snap', { path: 'files/snap.png', index: 1 })],
        [saveCall('call_save_gif', { path: 'files/avatar.gif', index: 2 })],
        done,
      ],
    });
    try {
      const stored = await waitForToolResult(h.framework, 'call_captioned');
      // The stored text is cut in the scan. The live copy cut each text block
      // at the cap on its own: it showed the snapshot and the caption's first
      // attachment line, and cut the caption before its second.
      assert.deepStrictEqual(
        parseImagePlaceholders(stored.content).map((s) => (s.kind === 'inline' ? s.ref : s.text)),
        [refOf(h, 1), attachmentLine(0)],
      );
      assert.doesNotMatch(stored.content, /item2\.png/);
      // Index 0 is the quoted attachment line, index 1 the snapshot and
      // index 2 the older GIF.
      const snap = saved(await waitForToolResult(h.framework, 'call_save_snap'));
      assert.strictEqual(snap[0]!.toolCallId, 'call_captioned');
      assert.strictEqual(snap[0]!.sha256, sha(PNG));
      const gif = saved(await waitForToolResult(h.framework, 'call_save_gif'));
      assert.strictEqual(gif[0]!.source, 'attachment');
      assert.strictEqual(gif[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("under a reader's bound, a result carrying an image keeps its notice and the slots its live copy showed, all within the bound", async () => {
    const h = await startTurn({
      prefix: 'sri-captioned-bound-',
      inlineCap: 1000,
      inlineBound: 1000,
      responses: [
        [{ type: 'tool_use', id: 'call_captioned', name: 'world--snap_captioned', input: {} } as ContentBlock],
        [saveCall('call_save_snap', { path: 'files/snap.png', index: 1 })],
        [saveCall('call_save_gif', { path: 'files/avatar.gif', index: 2 })],
        done,
      ],
    });
    try {
      const stored = await waitForToolResult(h.framework, 'call_captioned');
      // The cap is the bound, so the head moves back until the notice and the
      // kept slots fit after it: a reader's cut at the bound loses none.
      assert.ok(stored.content.length <= 1000, `the stored copy is ${stored.content.length} characters`);
      assert.match(stored.content, /\n\n\[truncated — showing \d+ of \d+ chars; full content: workspace file [^\]]+\]\n\[2 image slot\(s\) fell past the cut; /);
      assert.deepStrictEqual(
        parseImagePlaceholders(stored.content).map((s) => (s.kind === 'inline' ? s.ref : s.text)),
        [refOf(h, 1), attachmentLine(0)],
      );
      // The inventory counted the slots as the bound cut them: index 1 is the
      // snapshot and index 2 the older GIF.
      const snap = saved(await waitForToolResult(h.framework, 'call_save_snap'));
      assert.strictEqual(snap[0]!.toolCallId, 'call_captioned');
      assert.strictEqual(snap[0]!.sha256, sha(PNG));
      const gif = saved(await waitForToolResult(h.framework, 'call_save_gif'));
      assert.strictEqual(gif[0]!.source, 'attachment');
      assert.strictEqual(gif[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a result whose array the converters give up on keeps nothing past its cut: its live copy is its stored text', async () => {
    const h = await startTurn({
      prefix: 'sri-mystery-cut-',
      toolResultInlineMaxChars: 1000,
      responses: [
        [
          { type: 'tool_use', id: 'call_mystery', name: 'world--snap_mystery', input: {} } as ContentBlock,
          saveCall('call_save_batch', { path: 'files/batch.gif', index: 0 }),
        ],
        [saveCall('call_save_after', { path: 'files/after.gif', index: 0 })],
        done,
      ],
    });
    try {
      const stored = await waitForToolResult(h.framework, 'call_mystery');
      // Stored, and shown, as its JSON cut at the cap: the placeholder its
      // text quotes past the cap was never shown, before the commit or after.
      assert.match(stored.content, /^\[\{"type":"image","data":"/);
      assert.doesNotMatch(stored.content, /fell past the cut/);
      assert.deepStrictEqual(parseImagePlaceholders(stored.content), []);
      for (const id of ['call_save_batch', 'call_save_after']) {
        const receipt = saved(await waitForToolResult(h.framework, id));
        assert.strictEqual(receipt[0]!.source, 'attachment', id);
        assert.strictEqual(receipt[0]!.sha256, sha(GIF), id);
      }
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("a text result's cut never ends in part of a slot, before its commit or after (#403)", async () => {
    const call = (id: string, name: string): ContentBlock =>
      ({ type: 'tool_use', id, name: `world--${name}`, input: {} }) as ContentBlock;
    const names = Object.keys(SPLIT_TEXTS) as Array<keyof typeof SPLIT_TEXTS>;
    const h = await startTurn({
      prefix: 'sri-split-cut-',
      toolResultInlineMaxChars: 1000,
      responses: [
        ...names.map((name) => [call(`call_${name}`, name), saveCall(`call_save_${name}`, { path: `files/${name}.gif`, index: 0 })]),
        [saveCall('call_save_after', { path: 'files/after.gif', index: 0 })],
        done,
      ],
    });
    try {
      // A cut inside the attachment line, or 499 characters into the quoted
      // line, moves back to the line's start. 1000 characters into the quoted
      // line, the part before the cut can't be a slot, and the cut stays.
      const heads: Record<keyof typeof SPLIT_TEXTS, number> = { split_stub: 901, split_quoted: 501, giant_line: 1000 };
      for (const name of names) {
        const stored = await waitForToolResult(h.framework, `call_${name}`);
        const text = SPLIT_TEXTS[name];
        assert.strictEqual(stored.content.slice(0, heads[name]), text.slice(0, heads[name]), name);
        assert.ok(
          stored.content.slice(heads[name]).startsWith(`\n\n[truncated — showing ${heads[name]} of ${text.length} chars; `),
          `${name}: ${stored.content.slice(heads[name], heads[name] + 80)}`,
        );
        assert.deepStrictEqual(parseImagePlaceholders(stored.content), [], name);
      }
      // So every save, in the batch with its result and after every commit,
      // reaches past them to the GIF.
      for (const id of [...names.map((name) => `call_save_${name}`), 'call_save_after']) {
        const receipt = saved(await waitForToolResult(h.framework, id));
        assert.strictEqual(receipt[0]!.source, 'attachment', id);
        assert.strictEqual(receipt[0]!.sha256, sha(GIF), id);
      }
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("under a reader's bound, kept slots longer than the notice's spare room move the head back far enough for all of them to fit", async () => {
    const h = await startTurn({
      prefix: 'sri-listed-bound-',
      inlineCap: 4000,
      inlineBound: 4000,
      responses: [[{ type: 'tool_use', id: 'call_listed', name: 'world--snap_listed', input: {} } as ContentBlock], done],
    });
    try {
      // Each block is within the cap, so the live copy showed the snapshot and
      // every line. Cut at the cap, the stored copy would pass the bound; the
      // head moves back past the snapshot and the listing, and each of their
      // slots is kept after the notice, the copy still within the bound.
      const stored = await waitForToolResult(h.framework, 'call_listed');
      assert.ok(stored.content.length <= 4000, `the stored copy is ${stored.content.length} characters`);
      assert.match(stored.content, /^x+\n\n\[truncated — showing \d+ of \d+ chars; full content: workspace file [^\]]+\]\n\[13 image slot\(s\) fell past the cut; /);
      assert.deepStrictEqual(
        parseImagePlaceholders(stored.content).map((s) => (s.kind === 'inline' ? s.ref : s.text)),
        [refOf(h, 1), ...Array.from({ length: 12 }, (_, i) => attachmentLine(2 * i))],
      );
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("under a reader's bound, where kept slots hold the head below the cap, the notice doesn't offer raising the cap, which would keep no more", async () => {
    const h = await startTurn({
      prefix: 'sri-listed-noraise-',
      inlineCap: 3000,
      inlineBound: 4000,
      responses: [[{ type: 'tool_use', id: 'call_listed', name: 'world--snap_listed', input: {} } as ContentBlock], done],
    });
    try {
      // The cap of 3000 is under the bound less the notice's room (3360), but
      // the 13 kept slots take more than the 360 between them, so the head
      // moves back below the cap, as it would under any higher cap.
      const stored = await waitForToolResult(h.framework, 'call_listed');
      const head = /^x*/.exec(stored.content)![0];
      assert.ok(head.length < 3000, `the head is ${head.length} characters`);
      assert.match(stored.content, /\[13 image slot\(s\) fell past the cut; /);
      assert.doesNotMatch(stored.content, /raise the inline cap/);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("under a reader's bound that holds only some of the kept slots, the newest that fit are kept and the rest are said to be left out", async () => {
    const h = await startTurn({
      prefix: 'sri-listed-some-',
      inlineCap: 4000,
      inlineBound: 1500,
      responses: [[{ type: 'tool_use', id: 'call_listed', name: 'world--snap_listed', input: {} } as ContentBlock], done],
    });
    try {
      // The 13 slots the live copy showed take more than the 860 characters
      // the bound leaves beside the notice, so the head is empty and the
      // oldest slots are left out until the rest fit.
      const stored = await waitForToolResult(h.framework, 'call_listed');
      assert.ok(stored.content.length <= 1500, `the stored copy is ${stored.content.length} characters`);
      const all = [refOf(h, 1), ...Array.from({ length: 12 }, (_, i) => attachmentLine(2 * i))];
      const kept = parseImagePlaceholders(stored.content).map((s) => (s.kind === 'inline' ? s.ref : s.text));
      assert.ok(kept.length > 0 && kept.length < all.length, `${kept.length} slots kept`);
      assert.deepStrictEqual(kept, all.slice(-kept.length), 'the newest slots, in order');
      assert.ok(stored.content.includes(`[13 image slot(s) fell past the cut. The last ${kept.length} are kept here in order so save_recent_image still counts them; the ${13 - kept.length} before them are left out, and it doesn't count them:]`), stored.content.slice(-400));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("under a reader's bound, a text result's cut counts no slot it moved back past, before its commit or after", async () => {
    const h = await startTurn({
      prefix: 'sri-mid-slot-',
      inlineCap: 1000,
      inlineBound: 1000,
      responses: [
        [
          { type: 'tool_use', id: 'call_mid', name: 'world--mid_slot', input: {} } as ContentBlock,
          saveCall('call_save_batch', { path: 'files/batch.gif', index: 0 }),
        ],
        [saveCall('call_save_after', { path: 'files/after.gif', index: 0 })],
        done,
      ],
    });
    try {
      // The cap would keep the attachment line, at 501; the bound moves the
      // head back before it, alone or beside the save, and a text result
      // keeps nothing past its cut.
      const stored = await waitForToolResult(h.framework, 'call_mid');
      assert.ok(stored.content.length <= 1000, `the stored copy is ${stored.content.length} characters`);
      assert.deepStrictEqual(parseImagePlaceholders(stored.content), []);
      // So the save in its batch, counted before the commit, and the save
      // after it both reach past it to the GIF.
      for (const id of ['call_save_batch', 'call_save_after']) {
        const receipt = saved(await waitForToolResult(h.framework, id));
        assert.strictEqual(receipt[0]!.source, 'attachment', id);
        assert.strictEqual(receipt[0]!.sha256, sha(GIF), id);
      }
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("a save in its batch that counts a result by its share marks the round, which is stored by its share though it fits", async () => {
    const h = await startTurn({
      prefix: 'sri-mid-slot-marked-',
      inlineCap: 1000,
      inlineBound: 2000,
      responses: [
        [
          { type: 'tool_use', id: 'call_mid', name: 'world--mid_slot', input: {} } as ContentBlock,
          saveCall('call_save_batch', { path: 'files/batch.gif', index: 0 }),
        ],
        done,
      ],
    });
    try {
      // Alone, the result keeps the attachment line, at 501, in a head cut at
      // the cap, and the round would fit. Beside the save its share is 1000,
      // whose fit leaves a head of 360, before the line. The two ways differ,
      // so the save counts by the share and marks the round, which is then
      // stored by it: the stored copy holds no slot, and index 0 is the GIF.
      const stored = await waitForToolResult(h.framework, 'call_mid');
      assert.ok(stored.content.length <= 1000, `the stored copy is ${stored.content.length} characters`);
      assert.deepStrictEqual(parseImagePlaceholders(stored.content), []);
      const receipt = saved(await waitForToolResult(h.framework, 'call_save_batch'));
      assert.strictEqual(receipt[0]!.source, 'attachment');
      assert.strictEqual(receipt[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("a save in its batch counts a result within the cap as stored whole alone, so the round it marks is stored by its share", async () => {
    const h = await startTurn({
      prefix: 'sri-near-slot-',
      inlineCap: 1000,
      inlineBound: 1200,
      responses: [
        [
          { type: 'tool_use', id: 'call_near', name: 'world--near_slot', input: {} } as ContentBlock,
          saveCall('call_save_batch', { path: 'files/batch.gif', index: 0 }),
        ],
        done,
      ],
    });
    try {
      // Alone, the result is within the cap and would be stored whole, its
      // attachment line at 701 included. By its share beside the save, 600,
      // the line is cut away. The two ways differ, so the round is marked and
      // stored by its share: the stored copy holds no slot, as the save counted.
      const stored = await waitForToolResult(h.framework, 'call_near');
      assert.ok(stored.content.length <= 600, `the stored copy is ${stored.content.length} characters`);
      assert.deepStrictEqual(parseImagePlaceholders(stored.content), []);
      const receipt = saved(await waitForToolResult(h.framework, 'call_save_batch'));
      assert.strictEqual(receipt[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("a save in its batch counts a result carrying an image as its share of the bound will store it", async () => {
    const h = await startTurn({
      prefix: 'sri-captioned-share-',
      inlineCap: 1000,
      inlineBound: 1000,
      responses: [
        [
          { type: 'tool_use', id: 'call_captioned', name: 'world--snap_captioned', input: {} } as ContentBlock,
          saveCall('call_save_batch', { path: 'files/batch.gif', index: 0 }),
        ],
        done,
      ],
    });
    try {
      // Alone, the snapshot would keep its two slots under the bound; by its
      // share beside the save, 500, under the notice's room, it keeps none.
      // The two ways differ, so the save counts by the share and marks the
      // round, which is then stored by it.
      const stored = await waitForToolResult(h.framework, 'call_captioned');
      assert.deepStrictEqual(parseImagePlaceholders(stored.content), []);
      assert.match(stored.content, /\n\[2 image slot\(s\) fell past the cut and are left out, and save_recent_image doesn't count them\.\]$/);
      // So the save, counted before the commit, takes index 0 as the older
      // GIF, not a slot the stored copy doesn't hold.
      const receipt = saved(await waitForToolResult(h.framework, 'call_save_batch'));
      assert.strictEqual(receipt[0]!.source, 'attachment');
      assert.strictEqual(receipt[0]!.sha256, sha(GIF));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("a save in its batch counts a result no longer than its notice as stored whole, as its share stores it", async () => {
    const h = await startTurn({
      prefix: 'sri-short-share-',
      inlineCap: 1000,
      inlineBound: 100,
      responses: [
        [
          { type: 'tool_use', id: 'call_snap', name: 'world--snap', input: {} } as ContentBlock,
          saveCall('call_save_batch', { path: 'files/batch.png', index: 0 }),
        ],
        done,
      ],
    });
    try {
      // Beside the save its share is 50, under the snapshot's text, and the
      // notice a cut would store in its place is longer than the text, so
      // it is stored whole, its image slot with it. The save, counted
      // before the commit, counts it the same way: index 0 is the snapshot.
      const stored = await waitForToolResult(h.framework, 'call_snap');
      assert.match(stored.content, /^watchtower, facing north/);
      assert.doesNotMatch(stored.content, /truncated/);
      assert.equal(parseImagePlaceholders(stored.content).length, 1);
      // The save's own receipt is past its share too, so its bytes are read
      // from the file it wrote.
      await waitForToolResult(h.framework, 'call_save_batch');
      const bytes = await fileBytes(h, 'files/batch.png');
      assert.ok(bytes, 'the save wrote its file');
      assert.strictEqual(sha(bytes), sha(PNG));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("under a share, an image result no longer than its notice and the note on its left-out slot is stored whole", async () => {
    const h = await startTurn({
      prefix: 'sri-noted-share-',
      inlineCap: 1000,
      inlineBound: 600,
      responses: [
        [
          { type: 'tool_use', id: 'call_noted', name: 'world--snap_noted', input: {} } as ContentBlock,
          saveCall('call_save_batch', { path: 'files/batch.png', index: 0 }),
        ],
        done,
      ],
    });
    try {
      // Beside the save its share is 300, under the result's text and its
      // notice's room. Its cut would keep no head and no slot, and store the
      // notice and the note that its slot was left out, which together are
      // longer than the text: so it is stored whole, its slot with it, and
      // the save counts it so.
      const stored = await waitForToolResult(h.framework, 'call_noted');
      assert.match(stored.content, /^n{290}/);
      assert.doesNotMatch(stored.content, /truncated|left out/);
      assert.equal(parseImagePlaceholders(stored.content).length, 1);
      await waitForToolResult(h.framework, 'call_save_batch');
      const bytes = await fileBytes(h, 'files/batch.png');
      assert.ok(bytes, 'the save wrote its file');
      assert.strictEqual(sha(bytes), sha(PNG));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("a turn that fits, with a save beside an image result past its share but no longer than its notice and note, is stored as each result would be alone", async () => {
    const h = await startTurn({
      prefix: 'sri-noted-fits-',
      inlineCap: 2000,
      inlineBound: 960,
      responses: [
        [
          { type: 'tool_use', id: 'call_quiet', name: 'world--quiet_failure', input: {} } as ContentBlock,
          { type: 'tool_use', id: 'call_noted', name: 'world--snap_noted', input: {} } as ContentBlock,
          saveCall('call_save_batch', { path: 'files/batch.png', index: 0 }),
        ],
        done,
      ],
    });
    try {
      // Three calls under a bound of 960: a share of 320, under the result's
      // text. By its share the result would keep its slot whole, as it would
      // alone, so the save marks nothing, and the turn, which fits, is stored
      // as each result would be alone: the save's receipt whole beside it.
      const stored = await waitForToolResult(h.framework, 'call_noted');
      assert.ok(stored.content.length > 320, `the result is past its share (${stored.content.length})`);
      assert.match(stored.content, /^n{290}/);
      assert.equal(parseImagePlaceholders(stored.content).length, 1);
      const receipt = await waitForToolResult(h.framework, 'call_save_batch');
      const quiet = await waitForToolResult(h.framework, 'call_quiet');
      assert.ok(stored.content.length + receipt.content.length + quiet.content.length <= 960, 'the turn fits its bound');
      assert.strictEqual(saved(receipt)[0]!.sha256, sha(PNG), 'the receipt is stored whole, and the save took the snapshot');
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
      world: (world) => { world.snapAfterCall = 'call_save'; },
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
      world: (world) => { world.snapAfterCall = 'call_save'; },
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

  it('a save in the same batch counts a cut result as its stored copy will, image or text', async () => {
    const listingCall = (id: string, name: string): ContentBlock =>
      ({ type: 'tool_use', id, name: `world--${name}`, input: {} }) as ContentBlock;
    const h = await startTurn({
      prefix: 'sri-same-batch-cut-',
      toolResultInlineMaxChars: 1000,
      responses: [
        // A text result: none of its image-typed lines past the cut counts.
        [listingCall('call_listing', 'listing'), saveCall('call_save_text', { path: 'files/text.gif', index: 0 })],
        // A result carrying an image: of the slots past its cut, only the
        // snapshot's counts, the one its live copy showed.
        [listingCall('call_snap_listing', 'snap_listing'), saveCall('call_save_image', { path: 'files/image.gif', index: 1 })],
        // One whose live copy showed 101 slots past its cut: the newest 64
        // count, then the snapshot above.
        [
          listingCall('call_frames', 'snap_frames'),
          saveCall('call_save_frames', { path: 'files/frames.gif', index: MAX_KEPT_IMAGE_SLOTS + 1 }),
        ],
        [saveCall('call_save_after', { path: 'files/after.gif', index: MAX_KEPT_IMAGE_SLOTS + 1 })],
        done,
      ],
    });
    try {
      for (const id of ['call_save_text', 'call_save_image', 'call_save_frames', 'call_save_after']) {
        const receipt = saved(await waitForToolResult(h.framework, id));
        assert.strictEqual(receipt[0]!.source, 'attachment', `${id} reaches past the counted slots to the GIF`);
        assert.strictEqual(receipt[0]!.sha256, sha(GIF));
      }
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it("a same-batch error result, or one with no data, counts its error text's slots, as its stored copy will", async () => {
    const failing = (id: string, name: string): ContentBlock =>
      ({ type: 'tool_use', id, name: `world--${name}`, input: {} }) as ContentBlock;
    const h = await startTurn({
      prefix: 'sri-same-batch-error-text-',
      responses: [
        [failing('call_quiet', 'quiet_failure'), saveCall('call_save_quiet', { path: 'files/quiet.png', index: 0 })],
        [failing('call_loud', 'loud_failure'), saveCall('call_save_loud', { path: 'files/loud.png', index: 0 })],
        [
          saveCall('call_save_loud_after', { path: 'files/loud-after.png', index: 0 }),
          saveCall('call_save_quiet_after', { path: 'files/quiet-after.png', index: 1 }),
        ],
        done,
      ],
    });
    try {
      // Each stored text is its error text, which quotes a placeholder
      // written before retention existed: before the commit and after it,
      // each is an unsaveable slot, never the older GIF.
      for (const [id, index, call, tool] of [
        ['call_save_quiet', 0, 'call_quiet', 'quiet_failure'],
        ['call_save_loud', 0, 'call_loud', 'loud_failure'],
        ['call_save_loud_after', 0, 'call_loud', 'loud_failure'],
        ['call_save_quiet_after', 1, 'call_quiet', 'quiet_failure'],
      ] as const) {
        const result = await waitForToolResult(h.framework, id);
        assert.strictEqual(result.isError, true, `${id}: ${result.content}`);
        assert.ok(
          result.content.includes(`index ${index} is a tool-result image from world--${tool} (call ${call}) recorded without a retention ref`),
          `${id}: ${result.content}`,
        );
      }
      assert.strictEqual(await fileBytes(h, 'files/quiet.png'), null);
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
// Nullable selectors. A caller whose provider presents every property as
// required sends all three selectors; null or an empty string (like
// omission) must mean "not this selector", while any other SUPPLIED value is
// checked and never read as absent: " ", false or [] read as 0 would save
// the newest image instead of the one the caller named.
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

/** The input membrane's XML parser hands the framework for that call, parsed
 *  as membrane parses a round's calls: against the tools it declared. */
function parsedXmlInput(params: Record<string, string>, definition: ToolDefinition): Record<string, unknown> {
  const parsed = parseToolCalls(xmlCall('save_recent_image', params), { tools: [definition] });
  assert.ok(parsed && parsed.calls.length === 1, 'membrane parses the XML call');
  return parsed.calls[0]!.input;
}

const failed = (result: { content: string; isError: boolean }): string => {
  assert.strictEqual(result.isError, true, `expected a refusal, got: ${result.content}`);
  return result.content;
};

describe('save_recent_image selectors: omission, null and the empty string all mean unused', () => {
  it('sparse and every-property calls each save the image they name', async () => {
    const ledger = new ToolImageLedger();
    const ref1 = `img_${ledger.nonce}_1`;
    const xmlEveryProperty = parsedXmlInput({ path: 'files/xml.gif', ref: 'null', index: '1', count: 'null' }, await offeredDefinition());
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
          // ...index 0 beside the nulls, and every selector null: both the newest image.
          saveCall('call_every_newest', { path: 'files/every-newest.png', ref: null, index: 0, count: null }),
          saveCall('call_every_unused', { path: 'files/every-unused.png', ref: null, index: null, count: null }),
          // Every-property callers that fill the unused selector with an empty string.
          saveCall('call_empty_pos', { path: 'files/empty-pos.gif', ref: '', index: 1, count: '' }),
          saveCall('call_empty_ref', { path: 'files/empty-ref.png', ref: ref1, index: '', count: '' }),
          saveCall('call_empty_all', { path: 'files/empty-all.png', ref: '', index: '', count: '' }),
          // The narrow compatibility form: decimal-digit strings.
          saveCall('call_digits', { path: 'files/digits.gif', ref: null, index: '1', count: '1' }),
          // ...with surrounding whitespace trimmed: the digits still name the same image.
          saveCall('call_padded', { path: 'files/padded.gif', ref: null, index: ' 1', count: '1 ' }),
          saveCall('call_padded_range', { path: 'files/prange.png', ref: null, index: null, count: ' 2 ' }),
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
      await expectPng('call_every_newest', 'files/every-newest.png', 0);
      await expectPng('call_every_unused', 'files/every-unused.png', 0);
      await expectGif('call_digits', 'files/digits.gif');
      await expectGif('call_padded', 'files/padded.gif');
      await expectGif('call_empty_pos', 'files/empty-pos.gif');
      await expectPng('call_empty_ref', 'files/empty-ref.png', 0);
      await expectPng('call_empty_all', 'files/empty-all.png', 0);
      await expectGif('call_xml', 'files/xml.gif');

      const range = saved(await waitForToolResult(h.framework, 'call_every_range'));
      assert.deepStrictEqual(range.map((f) => f.sha256), [sha(PNG), sha(GIF)], 'count 2 with null index is the newest two');
      assert.ok((await fileBytes(h, 'files/range-0.png'))?.equals(PNG));
      assert.ok((await fileBytes(h, 'files/range-1.png'))?.equals(GIF));
      const padded = saved(await waitForToolResult(h.framework, 'call_padded_range'));
      assert.deepStrictEqual(padded.map((f) => f.sha256), [sha(PNG), sha(GIF)], 'a padded count of 2 saves the newest two');
      assert.ok((await fileBytes(h, 'files/prange-0.png'))?.equals(PNG));
      assert.ok((await fileBytes(h, 'files/prange-1.png'))?.equals(GIF));
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
    const HINT = 'pass null, or leave it out, for a selector you are not using';
    const cases: Array<{ id: string; input: Record<string, unknown>; refusal: RegExp; hint?: boolean }> = [
      { id: 'ref_blank', input: { ref: '   ' }, refusal: REF_FORMAT },
      // A malformed ref beside an index or count in use carries the unused-selector
      // hint; a ref that is the caller's only selector doesn't.
      { id: 'ref_malformed_with_index', input: { ref: 'img_1', index: 1, count: null }, refusal: REF_FORMAT, hint: true },
      { id: 'ref_malformed_with_count', input: { ref: 'img_1', index: null, count: 2 }, refusal: REF_FORMAT, hint: true },
      { id: 'ref_malformed_with_index_zero', input: { ref: 'img_1', index: 0 }, refusal: REF_FORMAT, hint: true },
      { id: 'ref_malformed', input: { ref: 'img_1' }, refusal: REF_FORMAT },
      { id: 'ref_number', input: { ref: 5 }, refusal: REF_FORMAT },
      { id: 'ref_false', input: { ref: false, index: null, count: null }, refusal: REF_FORMAT },
      { id: 'ref_array', input: { ref: [] }, refusal: REF_FORMAT },
      // An array holding a valid ref reads as that ref to a regex test.
      { id: 'ref_in_array', input: { ref: [ref1] }, refusal: REF_FORMAT },
      { id: 'index_blank', input: { ref: null, index: ' ', count: null }, refusal: INDEX },
      { id: 'index_false', input: { index: false }, refusal: INDEX },
      { id: 'index_true', input: { index: true }, refusal: INDEX },
      { id: 'index_array', input: { index: [] }, refusal: INDEX },
      { id: 'index_decimal_text', input: { index: '1.0' }, refusal: INDEX },
      { id: 'index_negative', input: { index: -1 }, refusal: INDEX },
      { id: 'index_fraction', input: { index: 1.5 }, refusal: INDEX },
      // Past the integers a number holds exactly, digits would read as another number.
      { id: 'index_unsafe_digits', input: { index: '9007199254740993' }, refusal: INDEX },
      { id: 'index_unsafe_number', input: { index: 9007199254740992 }, refusal: INDEX },
      // An index and a count are one selector: neither refusal invites dropping the other.
      { id: 'index_bad_with_count', input: { index: '1.5', count: 2 }, refusal: INDEX },
      { id: 'index_bad_beside_empty_count', input: { index: '1.5', count: '' }, refusal: INDEX },
      { id: 'count_true', input: { ref: null, index: null, count: true }, refusal: COUNT },
      { id: 'count_array', input: { count: [2] }, refusal: COUNT },
      { id: 'count_zero', input: { count: 0 }, refusal: COUNT },
      { id: 'count_decimal_text', input: { count: '2.0' }, refusal: COUNT },
      { id: 'count_blank', input: { count: ' ' }, refusal: COUNT },
      { id: 'count_bad_with_index', input: { index: 0, count: 21 }, refusal: COUNT },
      { id: 'count_over', input: { count: 21 }, refusal: COUNT },
      { id: 'conflict_count', input: { ref: ref1, count: 2 }, refusal: CONFLICT },
      { id: 'conflict_index', input: { ref: ref1, index: 0, count: null }, refusal: CONFLICT },
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
        // A refusal advises dropping a selector only beside another in use, so it
        // never reads as advice to drop the caller's one selector.
        if (c.refusal !== CONFLICT) assert.strictEqual(message.includes(HINT), c.hint === true, `${c.id}: hint`);
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
      case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
      case 'string': return typeof v === 'string';
      case 'integer': return typeof v === 'number' && Number.isInteger(v);
      case 'number': return typeof v === 'number';
      case 'null': return v === null;
      default: throw new Error(`schemaErrors does not understand type "${type}"`);
    }
  };
  known(schema);
  const errors: string[] = [];
  // Providers require a tool's input schema to describe an object.
  if (schema.type === undefined) {
    errors.push('root: no type');
  } else {
    const rootTypes = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!rootTypes.some((t) => matches(value, t))) errors.push(`root: an object is not ${rootTypes.join(' | ')}`);
  }
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

describe('save_recent_image schema as each provider path is sent it (installed membrane)', () => {
  it('the checker itself rejects a schema whose root does not describe an object', () => {
    const properties = { path: { type: 'string' } };
    assert.deepStrictEqual(schemaErrors({ type: 'object', properties }, { path: 'files/a.png' }), []);
    assert.deepStrictEqual(schemaErrors({ type: 'string', properties }, { path: 'files/a.png' }), ['root: an object is not string']);
    assert.deepStrictEqual(schemaErrors({ properties }, { path: 'files/a.png' }), ['root: no type']);
  });

  const REF = 'img_k7x3q2_7';
  const SHAPES: Array<Record<string, unknown>> = [
    { path: 'files/a.png' },
    { path: 'files/a.png', ref: REF },
    { path: 'files/a.png', index: 1, count: 2 },
    { path: 'files/a.png', ref: null, index: 1, count: 2 },
    { path: 'files/a.png', ref: REF, index: null, count: null },
    { path: 'files/a.png', ref: null, index: null, count: null },
  ];

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
    for (const [name, base] of [['ref', 'string'], ['index', 'integer'], ['count', 'integer']] as const) {
      // Each selector's own base type, with null marked one of the two ways
      // membrane renders it: as written (type="string,null", membrane 0.5.86)
      // or as nullable="true" (0.5.87 on). Nothing else is accepted here.
      const nullable = new RegExp(`type=\\\\"${base}(?:,null\\\\"|\\\\"[^>]*nullable=\\\\"true\\\\")`);
      assert.match(parameter(name), nullable, `${name} is ${base}, marked nullable`);
      assert.doesNotMatch(parameter(name), /required=/, `${name} is not required`);
    }
    assert.match(parameter('path'), /required=\\"true\\"/, 'path is required');
    const refText = (definition.inputSchema as unknown as { properties: Record<string, { description?: string }> }).properties.ref?.description ?? '';
    assert.match(refText, /pass null for the selector you are not using/, "ref's description says how to leave a selector unused");

    // And what the model writes back for an every-property call parses to the
    // shape the native schema accepts.
    const input = parsedXmlInput({ path: 'files/a.png', ref: 'null', index: '1', count: '2' }, definition);
    assert.deepStrictEqual(input, { path: 'files/a.png', ref: null, index: 1, count: 2 });
    // Parsed against the declared tool, a ref of one space stays one space, which
    // the handler refuses; guessed without it, it would come back "", unused.
    const spaced = parsedXmlInput({ path: 'files/a.png', ref: ' ', index: 'null', count: 'null' }, definition);
    assert.strictEqual(spaced.ref, ' ', 'a declared string keeps its whitespace');
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

  it('the serializer says where each block of an array sits in its text, and nothing when it gives the array up', () => {
    const data = [
      { type: 'text', text: 'two frames' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      { type: 'image', uri: 'https://cam.example/sri-spans.png', mimeType: 'image/png' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png', disposition: 'ref' },
    ];
    const reported: HistoryBlockSpan[][] = [];
    const text = toolResultDataToHistoryString(data, undefined, { onBlocks: (spans) => { reported.push(spans); } });
    assert.strictEqual(reported.length, 1);
    const spans = reported[0]!;
    assert.deepStrictEqual(spans.map((s) => s.kind), ['text', 'image', 'reference', 'withheld']);
    const parts = spans.map((s) => text.slice(s.start, s.end));
    assert.strictEqual(parts.join('\n'), text, 'the blocks, joined as the text joins them');
    assert.strictEqual(parts[0], 'two frames');
    assert.match(parts[1]!, /^\[image: image\/png, \d+B\]$/);
    assert.match(parts[2]!, /^\[ref_[0-9a-z]+_[0-9a-z]+\] image\/png — from tool result — /);
    assert.strictEqual(parts[3], INLINE_WITHHELD_TEXT);
    // A block of no known shape: the array is given up for its JSON.
    toolResultDataToHistoryString([...data, { type: 'mystery' }], undefined, { onBlocks: (s) => { reported.push(s); } });
    assert.strictEqual(reported.length, 1);
  });

  it('a cut never splits a slot, and keeps past it only the image slots its live copy showed', () => {
    const png = '[image: image/png, ~12KB, ref img_abc123_1]';
    const stub = '[ref_1_ab3d] cam.png — image/jpeg, 1.2MB claimed — from tool result — fetch with fetch_reference';
    const gif = '[image: image/gif, 4B, ref img_abc123_2]';
    const text = `head text\n${png}\nmiddle text that is long enough\n${stub}\ntail\n${gif}`;
    const all: ShownRanges = [[0, text.length]];
    const notice = '\n\n[truncated — original was N chars]';
    const slotsOf = (s: string): string[] => parseImagePlaceholders(s).map((p) => p.text);
    // Cut exactly at the start of the middle text: png stays, stub + gif move.
    const cut1 = text.indexOf('middle');
    assert.deepStrictEqual(cutStoredToolResult(text, cut1, all), { head: text.slice(0, cut1), kept: [stub, gif], fell: 2 });
    // Cut inside the stub line, in its id or past its type: the cut moves back
    // to the line's start.
    for (const inside of ['_ab3d', '1.2MB']) {
      assert.deepStrictEqual(
        cutStoredToolResult(text, text.indexOf(inside), all),
        { head: text.slice(0, text.indexOf(stub)), kept: [stub, gif], fell: 2 },
        inside,
      );
    }
    // Cut inside the png placeholder: the cut moves back to its start.
    assert.deepStrictEqual(cutStoredToolResult(text, text.indexOf('~12KB'), all), { head: 'head text\n', kept: [png, stub, gif], fell: 3 });
    // Wherever the cut falls, the head holds whole slots only, and with the
    // kept ones they are exactly the text's, in order. A live copy that was
    // this text has the same head, and nothing past it.
    for (let cut = 1; cut < text.length; cut++) {
      const cutShown = cutStoredToolResult(text, cut, all);
      const whole = parseImagePlaceholders(text).filter((p) => p.offset + p.text.length <= cutShown.head.length);
      assert.deepStrictEqual(slotsOf(cutShown.head + notice), whole.map((p) => p.text), `head at ${cut}`);
      assert.deepStrictEqual(slotsOf(cutShown.head + notice + formatKeptImageSlots(cutShown)), slotsOf(text), `cut at ${cut}`);
      assert.deepStrictEqual(cutStoredToolResult(text, cut, null), { head: cutShown.head, kept: [], fell: 0 }, `as text at ${cut}`);
    }
    // Only a slot lying wholly within what the live copy showed is kept: a
    // range ending before the gif, and one ending inside the stub.
    assert.deepStrictEqual(cutStoredToolResult(text, cut1, [[0, text.indexOf('\ntail')]]), { head: text.slice(0, cut1), kept: [stub], fell: 1 });
    assert.deepStrictEqual(
      cutStoredToolResult(text, cut1, [[0, text.indexOf('1.2MB')], [text.indexOf(gif), text.length]]),
      { head: text.slice(0, cut1), kept: [gif], fell: 1 },
    );
    // A slot wholly between two ranges, before one inside the second: the
    // walk passes the gap without passing the range after it.
    assert.deepStrictEqual(
      cutStoredToolResult(text, cut1, [[0, text.indexOf(stub)], [text.indexOf('tail'), text.length]]),
      { head: text.slice(0, cut1), kept: [gif], fell: 1 },
    );
    // Ranges that touch, with a slot starting where the first ends: the
    // second holds it.
    assert.deepStrictEqual(
      cutStoredToolResult(text, cut1, [[0, text.indexOf(gif)], [text.indexOf(gif), text.length]]),
      { head: text.slice(0, cut1), kept: [stub, gif], fell: 2 },
    );
    // Every reader of the generic history truncation reads it as text: it
    // cuts as the stored copy cuts, and keeps nothing past the cut.
    assert.strictEqual(truncateForHistory(text, cut1), `${text.slice(0, cut1)}\n\n[truncated — original was ${text.length} chars]`);
    assert.strictEqual(
      truncateForHistory(text, text.indexOf('1.2MB')),
      `${text.slice(0, text.indexOf(stub))}\n\n[truncated — original was ${text.length} chars]`,
    );
  });

  it('a cut moves back off a stub-shaped line only while the part before it could read as a slot', () => {
    const text = `intro\n${QUOTED_LINE}\nafter`;
    const start = text.indexOf(QUOTED_LINE);
    assert.deepStrictEqual(parseImagePlaceholders(text), [], 'the quoted line is no slot whole');
    for (const before of [1, 20, REFERENCE_STUB_MAX_CHARS]) {
      assert.strictEqual(cutStoredToolResult(text, start + before, null).head, 'intro\n', `${before} before the cut`);
    }
    // A character more, and that part is too long to parse as a slot: the cut
    // stays where it fell.
    const giant = cutStoredToolResult(text, start + REFERENCE_STUB_MAX_CHARS + 1, null);
    assert.strictEqual(giant.head, text.slice(0, start + REFERENCE_STUB_MAX_CHARS + 1));
    assert.deepStrictEqual(parseImagePlaceholders(`${giant.head}\n\n[truncated]`), []);
    // A line begins where the parser begins one, after a carriage return too.
    const cr = `intro\nnote\r[ref_9_ab3d] cam.png — image/png, 1KB claimed — from tool result — fetch with fetch_reference\nafter`;
    assert.strictEqual(parseImagePlaceholders(cr).length, 1);
    assert.strictEqual(cutStoredToolResult(cr, cr.indexOf('1KB'), null).head, cr.slice(0, cr.indexOf('[ref_9')));
  });

  it('a cut never splits a surrogate pair, and moves back from where it can fall', () => {
    const astral = '\u{1F600}'; // two UTF-16 code units
    // In plain text, a cap between the pair's two units cuts before the pair.
    const plain = `${'a'.repeat(9)}${astral}after`;
    assert.strictEqual(cutStoredToolResult(plain, 10, null).head, 'a'.repeat(9));
    assert.strictEqual(truncateForHistory(plain, 10), `${'a'.repeat(9)}\n\n[truncated — original was ${plain.length} chars]`);
    // A quoted stub-shaped line, too long to be a slot, whose pair sits at
    // its REFERENCE_STUB_MAX_CHARS-th unit: a cap between the pair's units
    // cuts before it, with REFERENCE_STUB_MAX_CHARS of the line before the
    // cut, a part that could read as a slot, so the cut moves back to the
    // line's start.
    const prefix = '[ref_9_ab3d] quoted — image/png ';
    const line = `${prefix}${'z'.repeat(REFERENCE_STUB_MAX_CHARS - prefix.length)}${astral}${'z'.repeat(100)}`;
    const text = `intro\n${line}\nafter`;
    const start = text.indexOf(line);
    assert.deepStrictEqual(parseImagePlaceholders(text), [], 'the quoted line is no slot whole');
    const cut = cutStoredToolResult(text, start + REFERENCE_STUB_MAX_CHARS + 1, null);
    assert.strictEqual(cut.head, 'intro\n');
    assert.deepStrictEqual(parseImagePlaceholders(`${cut.head}\n\n[truncated]`), []);
  });

  it('parses image-typed reference stubs as slots, in text order with inline placeholders, and no other stub', () => {
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
      ],
    );
  });

  it('a slot is no longer than its writer writes one: a character more and it is no slot', () => {
    const longestId = (stub: string): string =>
      stub.replace(/^\[ref_[0-9a-z]+_[0-9a-z]+\]/, `[ref_${Number.MAX_SAFE_INTEGER.toString(36)}_zzzz]`);
    const testimony = (name: string, extra: Partial<ReferenceTestimony> = {}): ReferenceTestimony => ({
      uri: `https://example.invalid/sri-longest-${name}.png`,
      name: 'n'.repeat(400),
      mimeType: `image/${'p'.repeat(240)}`,
      sizeBytes: Number.MAX_SAFE_INTEGER,
      rejectedFields: [],
      ...extra,
    });
    // The longest stub buildReferenceStub writes: every label at its bound,
    // the largest size, a saved copy's path, and the longest id.
    const saved = testimony('saved');
    referenceRegistry.register(saved, 'srv').fetchedPath = `files/${'q'.repeat(600)}`;
    const longest = longestId(buildReferenceStub(saved, 'o'.repeat(400), 'srv'));
    assert.strictEqual(longest.length, REFERENCE_STUB_MAX_CHARS);
    assert.strictEqual(parseImagePlaceholders(longest).length, 1);
    assert.strictEqual(parseImagePlaceholders(`${longest}q`).length, 0);
    // Its other endings are shorter: an expired reference's reasons, and an
    // unsaved one, whether its record holds a server or not.
    const endings: Array<[string, Partial<ReferenceTestimony>, string | undefined]> = [
      ['passed', { expiresAt: '2001-01-01T00:00:00Z' }, 'srv'],
      ['unparseable', { expiresAt: 'whenever' }, 'srv'],
      ['rejected', { rejectedFields: ['expiresAt'] }, 'srv'],
      ['bound', {}, 'srv'],
      ['unbound', {}, undefined],
    ];
    // And the reasons a fetch would be refused before it dials, each at its
    // longest: a server's id is bounded as a label is, and a refused scheme
    // isn't named.
    const longServer = (kind: string) => `${kind}-${'s'.repeat(400)}`;
    const host = {};
    // srv is dialed on the references' own origin, so its rows reach the
    // expiry's reasons and the fetch the stub offers.
    referenceRegistry.setServerAddress('srv', { url: 'wss://example.invalid' }, host);
    referenceRegistry.setServerAddress(longServer('stdio'), 'no-address', host);
    referenceRegistry.setServerAddress(longServer('elsewhere'), { url: 'wss://elsewhere.invalid' }, host);
    referenceRegistry.setServerAddress(longServer('dialed'), { url: 'wss://example.invalid' }, host);
    referenceRegistry.setServerAddress(longServer('garbled'), { url: 'not a url' }, host);
    endings.push(
      ['no address', {}, longServer('stdio')],
      ['unknown server', {}, longServer('unknown')],
      ['server address', {}, longServer('garbled')],
      ['third-party origin', {}, longServer('elsewhere')],
      ['scheme', { uri: `${'x'.repeat(400)}://example.invalid/sri-longest-scheme.png` }, longServer('dialed')],
      ['user name or password', { uri: 'https://user:pass@example.invalid/sri-longest-userinfo.png' }, longServer('dialed')],
    );
    const reasons: Record<string, string> = {
      passed: '— the reference is expired',
      unparseable: '— the reference is treated as expired, since its expiry time can\'t be read',
      rejected: '— the reference is treated as expired, since its expiry time isn\'t in a form this host accepts',
      bound: '— fetch with fetch_reference',
      unbound: '— it\'s not tied to any server',
      'no address': '— this host doesn\'t connect to the "stdio-s',
      'unknown server': '— this host no longer has the "unknown-s',
      'server address': '— the "garbled-s',
      'third-party origin': '— third-party origin:',
      scheme: '— scheme not allowed: this host fetches only',
      'user name or password': '— its address carries a user name or password',
    };
    for (const [name, extra, serverId] of endings) {
      const stub = longestId(buildReferenceStub(testimony(name, extra), 'o'.repeat(400), serverId));
      assert.ok(stub.length < REFERENCE_STUB_MAX_CHARS, `${name}: ${stub.length}`);
      assert.strictEqual(parseImagePlaceholders(stub).length, 1, name);
      assert.ok(stub.includes(reasons[name]!), `${name}: ${stub}`);
    }
    referenceRegistry.forgetServerAddress('srv', host);
    // A placeholder: RFC 6838 bounds a type or subtype name at 127
    // characters, so normalizeMediaType keeps the longest essence and refuses
    // one character more, and the size and ref take a safe integer's digits.
    const type = `${'a'.repeat(127)}/${'b'.repeat(127)}`;
    assert.strictEqual(normalizeMediaType(type), type);
    assert.strictEqual(normalizeMediaType(`a${type}`), FALLBACK_MEDIA_TYPE);
    assert.strictEqual(normalizeMediaType(`${type}b`), FALLBACK_MEDIA_TYPE);
    const digits = '9'.repeat(16);
    const placeholder = (t: string, size: string, ref: string): string => `[image: ${t}, ${size}, ref ${ref}]`;
    assert.strictEqual(placeholder(type, `~${digits}MB`, `img_${'z'.repeat(16)}_${digits}`), formatToolImagePlaceholder(type, `~${digits}MB`, `img_${'z'.repeat(16)}_${digits}`));
    assert.strictEqual(parseImagePlaceholders(placeholder(type, `~${digits}MB`, `img_${'z'.repeat(16)}_${digits}`)).length, 1);
    for (const longer of [
      placeholder(`a${type}`, `~${digits}MB`, 'img_abc123_1'),
      placeholder(`${type}b`, `~${digits}MB`, 'img_abc123_1'),
      placeholder('image/png', `~${digits}9MB`, 'img_abc123_1'),
      placeholder('image/png', '~1KB', `img_${'z'.repeat(17)}_1`),
      placeholder('image/png', '~1KB', `img_abc123_${digits}9`),
    ]) {
      assert.strictEqual(parseImagePlaceholders(longer).length, 0, longer.slice(0, 60));
    }
  });
});

it("a write that throws before its tree entry names the images already saved, and the error it sends the host's operator to is in the host's log", async () => {
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
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
    console.error = realError;
    assert.equal(result.isError, true);
    assert.match(result.content, /injected tree exception/);
    assert.match(result.content, /already saved: files\/images-0.png/);
    assert.match(result.content, /whoever runs this host can find the whole error in this host's log/);
    assert.ok(logged.some((args) => args.some((a) => a instanceof Error && a.message === 'injected tree exception')), `logged: ${JSON.stringify(logged.map((args) => args.map(String)))}`);
  } finally { console.error = realError; await h.framework.stop(); rmSync(h.tempDir, { recursive: true, force: true }); }
});

const ROOT_WRITES = typeof process.getuid === 'function' && process.getuid() === 0;

it("a write the store refuses says why in plain words and who can fix it, and names the images already saved", {
  skip: (process.platform === 'win32' && 'POSIX permissions') || (ROOT_WRITES && 'root writes past permissions'),
}, async () => {
  const h = await startTurn({
    prefix: 'sri-store-refuses-',
    responses: [
      [snapCall('call_snap')],
      [saveCall('call_save', { path: 'files/images.png', index: 0, count: 2 })],
      done,
    ],
    workspace: (workspace) => {
      const write = workspace.writeBinary.bind(workspace);
      let writes = 0;
      workspace.writeBinary = async (...args) => {
        if (++writes !== 2) return write(...args);
        // The second image meets the store as a locked disk leaves it: given
        // a byte more, it's a blob the store doesn't hold yet, and the
        // store's directories can't be written, so the store's own write
        // throws.
        const [path, bytes, ...rest] = args;
        const mounts = (workspace as unknown as { mounts: Map<string, { config: { path: string } }> }).mounts;
        const dirs = [join(dirname(mounts.get('files')!.config.path), 'store')];
        for (let i = 0; i < dirs.length; i++) {
          for (const entry of readdirSync(dirs[i]!, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(join(dirs[i]!, entry.name));
        }
        for (const dir of dirs) chmodSync(dir, 0o555);
        try {
          return await write(path, Buffer.concat([bytes, Buffer.from([0])]), ...rest);
        } finally {
          for (const dir of dirs) chmodSync(dir, 0o755);
        }
      };
    },
  });
  try {
    const result = await waitForToolResult(h.framework, 'call_save');
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('save_recent_image: failed writing "files/images-1.png": permission denied. '
      + "Calling again won't change that; whoever runs this host can change the permissions. (already saved: files/images-0.png)"), result.content);
    assert.doesNotMatch(result.content, /IO error|os error/);
  } finally { await h.framework.stop(); rmSync(h.tempDir, { recursive: true, force: true }); }
});

it("a write the workspace refuses, as while its store awaits reopening, reaches the agent in the workspace's own words, and is in the host's log", async () => {
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  const h = await startTurn({
    prefix: 'sri-refused-',
    responses: [
      [snapCall('call_snap')],
      [saveCall('call_save', { path: 'files/images.png', index: 0, count: 2 })],
      done,
    ],
    workspace: (workspace) => {
      const write = workspace.writeBinary.bind(workspace);
      let writes = 0;
      workspace.writeBinary = async (...args) => {
        if (++writes === 2) {
          // An append to the record of what disk last agreed with fails, so
          // the workspace awaits its store's reopening and refuses changes.
          const inner = workspace as unknown as { store: { appendJson: (...a: unknown[]) => unknown }; agreement: { set: (...a: unknown[]) => unknown } };
          const append = inner.store.appendJson;
          inner.store.appendJson = () => { throw Object.assign(new Error('IO error: No space left on device (os error 28)'), { code: 'GenericFailure' }); };
          assert.throws(() => inner.agreement.set('files', 'other.txt', { kind: 'absent' }));
          inner.store.appendJson = append;
        }
        return write(...args);
      };
    },
  });
  try {
    const result = await waitForToolResult(h.framework, 'call_save');
    console.error = realError;
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('save_recent_image: failed writing "files/images-1.png": the workspace can\'t check its files against disk until its store is reopened: '
      + 'an append to its record of what disk last agreed with failed inside the store, so that record may lack what the append held. '
      + "Calling again won't change that; whoever runs this host can reopen it with a restart. (already saved: files/images-0.png)"), result.content);
    assert.ok(logged.some((args) => args.some((a) => a instanceof Error && a.message.startsWith("the workspace can't check its files against disk until its store is reopened"))),
      `logged: ${JSON.stringify(logged.map((args) => args.map(String)))}`);
  } finally { console.error = realError; await h.framework.stop(); rmSync(h.tempDir, { recursive: true, force: true }); }
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
