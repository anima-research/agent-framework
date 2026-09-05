import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/framework.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { toolResultDataToHistoryString } from '../src/tool-result-history.js';
import { MockMembrane, createMockResponse as createStreamResponse } from './helpers/mock-membrane.js';
import type { Module, ModuleContext, ProcessState, EventResponse } from '../src/types/module.js';
import type { ProcessEvent, ToolCall, ToolResult } from '../src/types/events.js';

const TINY_IMAGES = {
  png: {
    mimeType: 'image/png',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
      'base64',
    ),
  },
  jpeg: {
    mimeType: 'image/jpeg',
    bytes: Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
      'base64',
    ),
  },
  gif: {
    mimeType: 'image/gif',
    bytes: Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64'),
  },
  webp: {
    mimeType: 'image/webp',
    bytes: Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=', 'base64'),
  },
} as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF89A_SIGNATURE = Buffer.from('GIF89a', 'ascii');
const WEBP_SIGNATURE = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]);

function u32be(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function u32le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

const INVALID_IMAGES = {
  signatureOnlyPng: { file: 'signature-only.png', bytes: PNG_SIGNATURE, error: 'Invalid PNG image: work/signature-only.png' },
  signatureOnlyJpeg: { file: 'signature-only.jpg', bytes: JPEG_SIGNATURE, error: 'Invalid JPEG image: work/signature-only.jpg' },
  signatureOnlyGif: { file: 'signature-only.gif', bytes: GIF89A_SIGNATURE, error: 'Invalid GIF image: work/signature-only.gif' },
  signatureOnlyWebp: { file: 'signature-only.webp', bytes: WEBP_SIGNATURE, error: 'Invalid WebP image: work/signature-only.webp' },
  pngWithoutIdat: {
    file: 'no-idat.png',
    bytes: Buffer.concat([
      PNG_SIGNATURE,
      u32be(13),
      Buffer.from('IHDR', 'ascii'),
      Buffer.from([
        0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x01,
        0x08,
        0x06,
        0x00,
        0x00,
        0x00,
      ]),
      Buffer.alloc(4),
      u32be(0),
      Buffer.from('IEND', 'ascii'),
      Buffer.alloc(4),
    ]),
    error: 'Invalid PNG image: work/no-idat.png',
  },
  malformedPng: {
    file: 'malformed-chunk.png',
    bytes: Buffer.concat([PNG_SIGNATURE, Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR', 'ascii')]),
    error: 'Invalid PNG image: work/malformed-chunk.png',
  },
  zeroDescriptorGif: {
    file: 'zero-descriptor.gif',
    bytes: Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x2c,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x00,
      0x00,
      0x02,
      0x01, 0x00,
      0x00,
      0x3b,
    ]),
    error: 'Invalid GIF image: work/zero-descriptor.gif',
  },
  invalidLzwGif: {
    file: 'invalid-lzw.gif',
    bytes: Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x2c,
      0x00, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00,
      0x00,
      0x01,
      0x01, 0x00,
      0x00,
      0x3b,
    ]),
    error: 'Invalid GIF image: work/invalid-lzw.gif',
  },
  malformedGif: {
    file: 'malformed-block.gif',
    bytes: Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x2c,
      0x00, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00,
      0x00,
      0x02,
      0x02, 0x4c,
    ]),
    error: 'Invalid GIF image: work/malformed-block.gif',
  },
  malformedJpeg: {
    file: 'malformed-segment.jpg',
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x41, 0x42, 0xff, 0xd9]),
    error: 'Invalid JPEG image: work/malformed-segment.jpg',
  },
  malformedWebp: {
    file: 'malformed-chunk.webp',
    bytes: Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x0c, 0x00, 0x00, 0x00]),
      Buffer.from('WEBPVP8X', 'ascii'),
      Buffer.from([0x0a, 0x00, 0x00, 0x00]),
    ]),
    error: 'Invalid WebP image: work/malformed-chunk.webp',
  },
  vp8xOnlyWebp: {
    file: 'vp8x-only.webp',
    bytes: Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      u32le(22),
      Buffer.from('WEBPVP8X', 'ascii'),
      u32le(10),
      Buffer.from([
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00,
        0x00, 0x00, 0x00,
      ]),
    ]),
    error: 'Invalid WebP image: work/vp8x-only.webp',
  },
} as const;

function createMockResponse(text = 'ok') {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn' as const,
    rawAssistantText: text,
    toolCalls: [],
    toolResults: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    details: {
      stop: { reason: 'end_turn' as const, wasTruncated: false },
      usage: { inputTokens: 1, outputTokens: 1 },
      timing: { totalDurationMs: 1, attempts: 1 },
      model: { requested: 'mock', actual: 'mock', provider: 'mock' },
      cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
    },
    raw: { request: {}, response: {} },
  };
}

function createIdleMembrane() {
  return {
    async complete() {
      return createMockResponse();
    },
    streamYielding() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'complete', response: createMockResponse() };
        },
      };
    },
  } as unknown as import('@animalabs/membrane').Membrane;
}

function createInferenceKickModule(): Module {
  return {
    name: 'kick',
    async start(_ctx: ModuleContext): Promise<void> {},
    async stop(): Promise<void> {},
    getTools() {
      return [];
    },
    async handleToolCall(_call: ToolCall): Promise<ToolResult> {
      return { success: false, error: 'unexpected tool call', isError: true };
    },
    async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
      if (event.type === 'external-message') {
        return { requestInference: true };
      }
      return {};
    },
  };
}

function setupWorkspace(
  t: TestContext,
  options?: {
    mode?: 'read-write' | 'read-only';
    followSymlinks?: boolean;
    maxFileSize?: number;
  },
) {
  const root = mkdtempSync(join(tmpdir(), 'af-read-image-'));
  const mountDir = join(root, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
  const workspace = new WorkspaceModule({
    mounts: [
      {
        name: 'work',
        path: mountDir,
        mode: options?.mode ?? 'read-write',
        watch: 'never',
        followSymlinks: options?.followSymlinks,
        maxFileSize: options?.maxFileSize,
      },
    ],
  });
  workspace.initStore(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    mountDir,
    store,
    workspace,
    treeStateId: 'workspace/work/tree',
  };
}

async function callReadImage(workspace: WorkspaceModule, path: string) {
  return workspace.handleToolCall({
    id: 'call-1',
    name: 'read_image',
    input: { path },
  });
}

function expectImageResult(
  result: Awaited<ReturnType<typeof callReadImage>>,
  path: string,
  expected: { bytes: Buffer; mimeType: string },
) {
  assert.equal(result.success, true);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.data, [
    {
      type: 'text',
      text: `Path: ${path}\nMIME: ${expected.mimeType}\nBytes: ${expected.bytes.byteLength}`,
    },
    {
      type: 'image',
      data: expected.bytes.toString('base64'),
      mimeType: expected.mimeType,
    },
  ]);
}

test('tool inventory/schema includes workspace--read_image', async (t) => {
  const frameworkRoot = mkdtempSync(join(tmpdir(), 'af-read-image-fw-'));
  const workspace = new WorkspaceModule({
    mounts: [
      {
        name: 'work',
        path: join(frameworkRoot, 'mount'),
        mode: 'read-write',
        watch: 'never',
      },
    ],
  });
  const framework = await AgentFramework.create({
    storePath: join(frameworkRoot, 'framework.chronicle'),
    membrane: createIdleMembrane(),
    agents: [{ name: 'assistant', model: 'mock', systemPrompt: 'test' }],
    modules: [workspace],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  t.after(async () => {
    await framework.stop();
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  const tool = framework.getAllTools().find((entry) => entry.name === 'workspace--read_image');
  assert.ok(tool);
  assert.equal(tool.description, 'Read an image file from the workspace and return native image content.');
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Image file path (mount-prefixed, e.g., "project/assets/logo.png")' },
    },
    required: ['path'],
  });
});

test('valid tiny PNG, JPEG, GIF, and WebP return native image content with exact bytes and MIME', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t);

  for (const [ext, image] of Object.entries(TINY_IMAGES)) {
    const path = `work/tiny.${ext}`;
    writeFileSync(join(mountDir, `tiny.${ext}`), image.bytes);
    const result = await callReadImage(workspace, path);
    expectImageResult(result, path, image);
  }
});

test('JPEG with trailing pad bytes after EOI is accepted (hardware encoders pad to 4-byte boundary)', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t);
  // Raspberry Pi camera stills end `ff d9 00 00 00`; decoders stop at EOI.
  const padded = { mimeType: 'image/jpeg', bytes: Buffer.concat([TINY_IMAGES.jpeg.bytes, Buffer.from([0x00, 0x00, 0x00])]) };
  writeFileSync(join(mountDir, 'padded.jpg'), padded.bytes);
  const result = await callReadImage(workspace, 'work/padded.jpg');
  expectImageResult(result, 'work/padded.jpg', padded);
});

test('pre-existing Chronicle binary blob is preferred even when the filesystem file is absent', async (t) => {
  const { mountDir, store, workspace, treeStateId } = setupWorkspace(t);
  const image = TINY_IMAGES.png;
  const blobHash = store.storeBlob(image.bytes, image.mimeType);
  store.treeSet(treeStateId, 'chronicle-only.png', {
    blobHash,
    size: image.bytes.byteLength,
    mode: 0o644,
  });

  const result = await callReadImage(workspace, 'work/chronicle-only.png');
  expectImageResult(result, 'work/chronicle-only.png', image);
  assert.equal(existsSync(join(mountDir, 'chronicle-only.png')), false);
});

test('materialized binary file works without syncing the image through the text workspace path', async (t) => {
  const { mountDir, store, workspace, treeStateId } = setupWorkspace(t);
  const image = TINY_IMAGES.png;
  writeFileSync(join(mountDir, 'fs-only.png'), image.bytes);

  const before = store.treeGet(treeStateId, 'fs-only.png');
  assert.equal(before, null);

  const result = await callReadImage(workspace, 'work/fs-only.png');
  expectImageResult(result, 'work/fs-only.png', image);

  const after = store.treeGet(treeStateId, 'fs-only.png');
  assert.equal(after, null, 'read_image must not route binary data through ensureSynced/text blob storage');
});

test('extension and user-visible name do not override magic-byte MIME detection', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t);
  writeFileSync(join(mountDir, 'mismatch.jpg'), TINY_IMAGES.png.bytes);

  const result = await callReadImage(workspace, 'work/mismatch.jpg');
  expectImageResult(result, 'work/mismatch.jpg', TINY_IMAGES.png);
});

test('unknown mount, mount root, directory, unknown/truncated/empty/oversize files fail closed', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t, { maxFileSize: 16 });
  mkdirSync(join(mountDir, 'folder'));
  writeFileSync(join(mountDir, 'unknown.bin'), Buffer.from('not-an-image'));
  writeFileSync(join(mountDir, 'truncated.png'), PNG_SIGNATURE.subarray(0, 4));
  writeFileSync(join(mountDir, 'empty.png'), Buffer.alloc(0));
  writeFileSync(join(mountDir, 'too-large.png'), Buffer.alloc(17, 0xff));

  const cases = [
    { path: 'missing/file.png', error: 'Unknown mount: "missing". Available: work' },
    { path: 'work', error: 'Path is a directory: work' },
    { path: 'work/folder', error: 'Path is a directory: work/folder' },
    { path: 'work/unknown.bin', error: 'Unsupported image format: work/unknown.bin' },
    { path: 'work/truncated.png', error: 'Truncated image signature: work/truncated.png' },
    { path: 'work/empty.png', error: 'Image file is empty: work/empty.png' },
    { path: 'work/too-large.png', error: 'Image file exceeds max size (16 bytes): work/too-large.png' },
  ];

  for (const check of cases) {
    const result = await callReadImage(workspace, check.path);
    assert.equal(result.success, false);
    assert.equal(result.isError, true);
    assert.equal(result.error, check.error);
    assert.equal(result.data, undefined);
  }
});

test('signature-only and malformed image structures are rejected before native delivery', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t);

  for (const image of Object.values(INVALID_IMAGES)) {
    writeFileSync(join(mountDir, image.file), image.bytes);
  }

  for (const image of Object.values(INVALID_IMAGES)) {
    const result = await callReadImage(workspace, `work/${image.file}`);
    assert.equal(result.success, false, image.file);
    assert.equal(result.isError, true, image.file);
    assert.equal(result.error, image.error, image.file);
    assert.equal(result.data, undefined, image.file);
  }
});

test('lexical traversal and symlink escape fail without leaking absolute paths', async (t) => {
  const { root, mountDir, workspace } = setupWorkspace(t, { followSymlinks: true });
  const outsideDir = join(root, 'outside');
  mkdirSync(outsideDir);
  const outsideFile = join(outsideDir, 'outside.png');
  writeFileSync(outsideFile, TINY_IMAGES.png.bytes);
  symlinkSync(outsideFile, join(mountDir, 'escape.png'));

  const traversal = await callReadImage(workspace, 'work/../outside/outside.png');
  assert.equal(traversal.success, false);
  assert.equal(traversal.isError, true);
  assert.equal(traversal.error, 'Path traversal detected: "work/../outside/outside.png" resolves outside mount "work"');
  assert.ok(!traversal.error?.includes(root));

  const escape = await callReadImage(workspace, 'work/escape.png');
  assert.equal(escape.success, false);
  assert.equal(escape.isError, true);
  assert.equal(escape.error, 'Symlink escape detected: work/escape.png');
  assert.ok(!escape.error?.includes(root));
  assert.ok(!escape.error?.includes(outsideFile));
});

test('read-only mounts can still read images', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t, { mode: 'read-only' });
  writeFileSync(join(mountDir, 'readonly.png'), TINY_IMAGES.png.bytes);

  const result = await callReadImage(workspace, 'work/readonly.png');
  expectImageResult(result, 'work/readonly.png', TINY_IMAGES.png);
});

test('framework native conversion emits an image block for the live round and history stays placeholder-only', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t);
  writeFileSync(join(mountDir, 'native.png'), TINY_IMAGES.png.bytes);

  const result = await callReadImage(workspace, 'work/native.png');
  expectImageResult(result, 'work/native.png', TINY_IMAGES.png);

  const framework = Object.create(AgentFramework.prototype) as any;
  const live = framework.toMembraneToolResult('call-1', result as { success: true; data: unknown });
  assert.deepEqual(live, {
    toolUseId: 'call-1',
    isError: false,
    content: [
      {
        type: 'text',
        text: `Path: work/native.png\nMIME: image/png\nBytes: ${TINY_IMAGES.png.bytes.byteLength}`,
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          data: TINY_IMAGES.png.bytes.toString('base64'),
          mediaType: 'image/png',
        },
      },
    ],
  });

  const history = toolResultDataToHistoryString(result.data);
  assert.ok(history.includes('Path: work/native.png'));
  assert.ok(history.includes('[image: image/png,'));
  assert.ok(!history.includes(TINY_IMAGES.png.bytes.toString('base64')));
});

test('process logging persists a redacted image receipt while the live round keeps the exact base64 block', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'af-read-image-log-'));
  const mountDir = join(root, 'mount');
  mkdirSync(mountDir, { recursive: true });
  writeFileSync(join(mountDir, 'native.png'), TINY_IMAGES.png.bytes);

  const createWorkspace = () => new WorkspaceModule({
    mounts: [
      {
        name: 'work',
        path: mountDir,
        mode: 'read-write',
        watch: 'never',
      },
    ],
  });

  const storePath = join(root, 'framework.chronicle');
  const membrane = new MockMembrane();
  const workspaceModule = createWorkspace();
  let framework: AgentFramework | null = null;
  let reopened: AgentFramework | null = null;
  membrane.pushResponse(createStreamResponse([
    { type: 'text', text: 'Fetching the image.' },
    { type: 'tool_use', id: 'img-1', name: 'workspace--read_image', input: { path: 'work/native.png' } },
  ], 'tool_use'));
  membrane.pushResponse(createStreamResponse([{ type: 'text', text: 'Done.' }]));

  framework = await AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'mock', systemPrompt: 'test' }],
    modules: [workspaceModule, createInferenceKickModule()],
    processLogging: { persist: true },
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  workspaceModule.initStore(framework.getStore());

  t.after(async () => {
    await reopened?.stop().catch(() => {});
    await framework?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: 'Read work/native.png',
    metadata: {},
  });
  await framework.runUntilIdle();

  const live = membrane.lastStream?.receivedToolResults[0] as Array<{
    toolUseId: string;
    isError: boolean;
    content: Array<{ type: string; text?: string; source?: { type: string; data: string; mediaType: string } }>;
  }> | undefined;
  assert.ok(live);
  assert.deepEqual(live, [
    {
      toolUseId: 'img-1',
      isError: false,
      content: [
        {
          type: 'text',
          text: `Path: work/native.png\nMIME: image/png\nBytes: ${TINY_IMAGES.png.bytes.byteLength}`,
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            data: TINY_IMAGES.png.bytes.toString('base64'),
            mediaType: 'image/png',
          },
        },
      ],
    },
  ]);

  await framework.stop();
  framework = null;

  reopened = await AgentFramework.create({
    storePath,
    membrane: createIdleMembrane(),
    agents: [{ name: 'assistant', model: 'mock', systemPrompt: 'test' }],
    modules: [createWorkspace(), createInferenceKickModule()],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });

  const entryMeta = reopened
    .queryProcessLogs({ eventType: 'tool-result', limit: 20 })
    .entries
    .find((entry) => entry.entry.processEvent.type === 'tool-result' && entry.entry.processEvent.callId === 'img-1');
  assert.ok(entryMeta);

  const persisted = reopened.getProcessLog(entryMeta!.sequence);
  assert.ok(persisted);
  const persistedJson = JSON.stringify(persisted.entry);
  assert.ok(!persistedJson.includes(TINY_IMAGES.png.bytes.toString('base64')));
  assert.equal(persistedJson.includes(mountDir), false);

  const persistedImage = (persisted.entry.processEvent as {
    result: { data: Array<Record<string, unknown>> };
  }).result.data[1];
  assert.deepEqual(persistedImage, {
    type: 'image',
    mimeType: 'image/png',
    approxByteLength: TINY_IMAGES.png.bytes.byteLength,
    redacted: true,
  });
});

test('lazy sync never ingests binaries: tree stays clean and read_image serves shell-created files from disk', async (t) => {
  const { mountDir, store, workspace, treeStateId } = setupWorkspace(t);
  const image = TINY_IMAGES.png;
  // A binary created OUTSIDE workspace tools (shell/curl) — the Fable avatar case.
  writeFileSync(join(mountDir, 'shell-made.png'), image.bytes);

  // readBinary triggers lazy sync; the binary must be SKIPPED, not utf-8-mangled.
  const read = await workspace.readBinary('work/shell-made.png');
  assert.ok('error' in read, 'binary must not be lazily synced into the tree');
  assert.equal(store.treeGet(treeStateId, 'shell-made.png'), null);

  // The module read_image handler serves it from disk, bytes exact.
  const result = await callReadImage(workspace, 'work/shell-made.png');
  expectImageResult(result, 'work/shell-made.png', image);

  // Text files keep lazy-syncing as before.
  writeFileSync(join(mountDir, 'note.txt'), 'plain text survives lazy sync');
  const text = await workspace.readBinary('work/note.txt');
  assert.ok('data' in text);
  assert.equal(text.data.toString('utf-8'), 'plain text survives lazy sync');
});

test('bare read_image dispatch falls back to disk when the tree blob is utf-8 mangled (pre-fix stores)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'af-read-image-mangled-'));
  const mountDir = join(root, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const image = TINY_IMAGES.png;
  writeFileSync(join(mountDir, 'grid-1.png'), image.bytes);

  const membrane = new MockMembrane();
  const workspaceModule = new WorkspaceModule({
    mounts: [{ name: 'work', path: mountDir, mode: 'read-write', watch: 'never' }],
  });
  // BARE tool name — the framework-synthesized surface Fable actually called.
  membrane.pushResponse(createStreamResponse([
    { type: 'tool_use', id: 'img-mangled-1', name: 'read_image', input: { path: 'work/grid-1.png' } },
  ], 'tool_use'));
  membrane.pushResponse(createStreamResponse([{ type: 'text', text: 'Done.' }]));

  const framework = await AgentFramework.create({
    storePath: join(root, 'framework.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'mock', systemPrompt: 'test' }],
    modules: [workspaceModule, createInferenceKickModule()],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  workspaceModule.initStore(framework.getStore());
  t.after(async () => {
    await framework.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  // Poison the tree exactly the way the old ensureSynced did: utf-8 round-trip.
  const store = framework.getStore();
  const mangled = Buffer.from(image.bytes.toString('utf-8'), 'utf-8');
  assert.notDeepEqual(mangled, image.bytes, 'sanity: utf-8 round-trip must corrupt the PNG');
  store.treeSet('workspace/work/tree', 'grid-1.png', {
    blobHash: store.storeBlob(mangled, 'text/plain'),
    size: mangled.byteLength,
    mode: 0o644,
  });

  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: 'Read work/grid-1.png',
    metadata: {},
  });
  await framework.runUntilIdle();

  const live = membrane.lastStream?.receivedToolResults[0] as Array<{
    toolUseId: string;
    isError: boolean;
    content: Array<{ type: string; source?: { data: string; mediaType: string } }>;
  }> | undefined;
  assert.ok(live, 'tool result must reach the live round');
  assert.equal(live![0]!.toolUseId, 'img-mangled-1');
  assert.equal(live![0]!.isError, false, 'mangled tree blob must fall back to disk, not error');
  const imageBlock = live![0]!.content.find((b) => b.type === 'image');
  assert.ok(imageBlock?.source);
  assert.equal(imageBlock!.source!.data, image.bytes.toString('base64'), 'bytes must be the DISK bytes, exact');
  assert.equal(imageBlock!.source!.mediaType, 'image/png');
});
