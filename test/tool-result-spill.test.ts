/**
 * Oversized tool-result spill — completion coverage for issue #89.
 *
 * The mechanism (spill to workspace file + bounded preview) landed in
 * f231bbf; these tests pin the completion semantics: the house-safe 24000
 * default (no more 42k accidental ingests), the durable
 * FrameworkConfig.toolResultInlineMaxChars cap, hot-override provenance and
 * restart behavior, error results under the same policy, the explicit
 * no-writable-workspace fallback, history/wire byte-identity, and native
 * image blocks surviving next to a spilled text payload.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventResponse,
  Module,
  ProcessEvent,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, PassthroughStrategy } from '../src/index.js';
import { DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS } from '../src/tool-result-history.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

/**
 * Bound for "inline copy is capped" assertions: the cap itself plus room for
 * the truncation notice. Derived from the constant on purpose — these bounds
 * were once hardcoded at the 5000-era value and so silently pinned the old
 * default; raising it broke three tests that were only ever checking that
 * SOMETHING capped the payload.
 */
const CAPPED = DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS + 1000;

class CappedPassthroughStrategy extends PassthroughStrategy {
  readonly maxMessageTokens = 1000;
}

function tempStorePath(prefix: string): { tempDir: string; storePath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  return { tempDir, storePath: join(tempDir, 'store') };
}

/** Module returning one canned result for its single `fetch` tool. */
class CannedToolModule implements Module {
  readonly name = 'canned';
  constructor(private result: ToolResult) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{
      name: 'fetch',
      description: 'Returns the canned payload.',
      inputSchema: { type: 'object', properties: {} },
    }];
  }
  async handleToolCall(): Promise<ToolResult> {
    return this.result;
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

interface SpillHarness {
  framework: AgentFramework;
  membrane: MockMembrane;
  workspace: WorkspaceModule | null;
  tempDir: string;
  storePath: string;
}

async function startSpillTurn(opts: {
  prefix: string;
  result: ToolResult;
  withWorkspace: boolean;
  toolResultInlineMaxChars?: number;
  workspaceMaxFileSize?: number;
  cappedStrategy?: boolean;
  storePath?: string;
  tempDir?: string;
}): Promise<SpillHarness> {
  const { tempDir, storePath } = opts.storePath && opts.tempDir
    ? { tempDir: opts.tempDir, storePath: opts.storePath }
    : tempStorePath(opts.prefix);
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([
    { type: 'text', text: 'Fetching.' },
    { type: 'tool_use', id: 'call_fetch', name: 'canned--fetch', input: {} },
  ], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Handled.' }]));

  let workspace: WorkspaceModule | null = null;
  const modules: Module[] = [new CannedToolModule(opts.result)];
  if (opts.withWorkspace) {
    const mountDir = join(tempDir, 'mount');
    mkdirSync(mountDir, { recursive: true });
    workspace = new WorkspaceModule({
      mounts: [{
        name: 'files',
        path: mountDir,
        mode: 'read-write',
        watch: 'never',
        ...(opts.workspaceMaxFileSize !== undefined
          ? { maxFileSize: opts.workspaceMaxFileSize }
          : {}),
      }],
    });
    modules.push(workspace as unknown as Module);
  }

  const framework = await AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime',
      model: 'test-model',
      systemPrompt: 'You are prime.',
      allowedTools: 'all',
      ...(opts.cappedStrategy ? { strategy: new CappedPassthroughStrategy() as never } : {}),
    }],
    modules,
    syncIntervalMs: 0,
    ...(opts.toolResultInlineMaxChars !== undefined
      ? { toolResultInlineMaxChars: opts.toolResultInlineMaxChars }
      : {}),
  });
  workspace?.initStore(framework.getStore());
  framework.start();
  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: [{ type: 'text', text: 'fetch it' }],
    metadata: {},
    triggerInference: true,
  } as unknown as ProcessEvent);
  return { framework, membrane, workspace, tempDir, storePath };
}

/** Poll the agent's stored context for the first tool_result block. */
async function waitForStoredToolResult(
  framework: AgentFramework,
  timeoutMs = 20_000,
): Promise<{ content: string; isError: boolean } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const cm = framework.getAgent('prime')?.getContextManager();
    const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{
      content: Array<{ type: string; content?: unknown; isError?: boolean }>;
    }>;
    for (const m of msgs) {
      for (const b of m.content ?? []) {
        if (b.type === 'tool_result') {
          return { content: b.content as string, isError: b.isError === true };
        }
      }
    }
  }
  return null;
}

/** Effective-cap provenance through the framework's own settings extension. */
function capProvenance(framework: AgentFramework): Record<string, unknown> {
  const extensions = (framework as unknown as {
    collectAgentSettingsExtensions(): Map<string, { get(agentName: string): Record<string, unknown> }>;
  }).collectAgentSettingsExtensions();
  return extensions.get('_framework')!.get('prime');
}

function frameworkExtension(framework: AgentFramework): {
  update(agentName: string, patch: Record<string, unknown>): Record<string, unknown>;
  reset(agentName: string, keys?: string[]): Record<string, unknown>;
} {
  const extensions = (framework as unknown as {
    collectAgentSettingsExtensions(): Map<string, unknown>;
  }).collectAgentSettingsExtensions();
  return extensions.get('_framework') as ReturnType<typeof frameworkExtension>;
}

describe('tool-result spill completion (issue #89)', () => {
  it('caps at the house default 24000 with no config and no strategy bound', async () => {
    // Pre-#89 behavior: PassthroughStrategy has no maxMessageTokens, so the
    // cap was undefined and a 42k result went inline whole. This pins the fix.
    const h = await startSpillTurn({
      prefix: 'spill-default-',
      result: { success: true, data: { blob: 'x'.repeat(42_000) } },
      withWorkspace: true,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.ok(stored.content.length < CAPPED, `inline copy must be near the cap, got ${stored.content.length}`);
      assert.match(stored.content, /showing 24000 of \d+ chars; full content: workspace file files\/tool-results\//);
      const prov = capProvenance(h.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars, null);
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 24000);
      assert.strictEqual(prov.tool_result_inline_max_chars_source, 'default');
      // Full content is recoverable from the spill file.
      const refMatch = stored.content.match(/workspace file (files\/tool-results\/\S+\.txt)/);
      assert.ok(refMatch, 'reference should name the spill file');
      const file = await h.workspace!.readBinary(refMatch[1]);
      assert.ok('data' in file, `spill file should be readable: ${JSON.stringify(file)}`);
      assert.ok((file as { data: Buffer }).data.byteLength >= 42_000, 'full content in file');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('honors the durable FrameworkConfig cap and reports framework-config provenance', async () => {
    const h = await startSpillTurn({
      prefix: 'spill-config-',
      result: { success: true, data: { blob: 'x'.repeat(42_000) } },
      withWorkspace: true,
      toolResultInlineMaxChars: 12_000,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.match(stored.content, /showing 12000 of \d+ chars/);
      const prov = capProvenance(h.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 12_000);
      assert.strictEqual(prov.tool_result_inline_max_chars_source, 'framework-config');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('hot override wins over config; reset restores the durable cap', async () => {
    const h = await startSpillTurn({
      prefix: 'spill-override-',
      result: { success: true, data: { small: true } },
      withWorkspace: true,
      toolResultInlineMaxChars: 12_000,
    });
    try {
      const ext = frameworkExtension(h.framework);
      ext.update('prime', { tool_result_inline_max_chars: 50_000 });
      let prov = capProvenance(h.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars, 50_000);
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 50_000);
      assert.strictEqual(prov.tool_result_inline_max_chars_source, 'agent-settings-override');
      ext.reset('prime');
      prov = capProvenance(h.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars, null);
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 12_000);
      assert.strictEqual(prov.tool_result_inline_max_chars_source, 'framework-config');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('spills giant ERROR results under the same policy, preserving isError', async () => {
    const h = await startSpillTurn({
      prefix: 'spill-error-',
      result: { success: false, error: 'E'.repeat(42_000), isError: true },
      withWorkspace: true,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'error tool result should be stored');
      assert.strictEqual(stored.isError, true);
      assert.ok(stored.content.length < CAPPED, `inline error copy must be capped, got ${stored.content.length}`);
      assert.match(stored.content, /full content: workspace file files\/tool-results\//);
      // Wire copy byte-matches the stored copy.
      const wire = h.membrane.lastStream?.receivedToolResults[0] as
        Array<{ content: unknown; isError?: boolean }> | undefined;
      assert.ok(wire && wire.length === 1, 'one wire tool result expected');
      assert.strictEqual(wire[0].isError, true);
      assert.strictEqual(wire[0].content, stored.content, 'history and live wire must be byte-identical');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('keeps history and live wire byte-identical for spilled successes', async () => {
    const h = await startSpillTurn({
      prefix: 'spill-identity-',
      result: { success: true, data: { blob: 'y'.repeat(42_000) } },
      withWorkspace: true,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      const wire = h.membrane.lastStream?.receivedToolResults[0] as
        Array<{ content: unknown }> | undefined;
      assert.ok(wire && wire.length === 1, 'one wire tool result expected');
      assert.strictEqual(wire[0].content, stored.content, 'history and live wire must be byte-identical');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  for (const [name, body, cap, maxFileSize] of [
    ['JSON tokens', '{"id":12345678901234567890,"n":1.0,"e":1e+09,"k":0,"k":1,"escaped":"\\u0061","rows":['
      + Array.from({ length: 900 }, (_, i) => `{"i":${i},"pad":"${'x'.repeat(60)}"}`).join(',') + ']}', 24_000, undefined],
    ['one huge JSON string', JSON.stringify({ blob: '😀'.repeat(12_000) }), 24_000, undefined],
    ['non-JSON and JSON escaping at a low cap', ('plain text\t\r\x01"\\😀').repeat(500), 1000, undefined],
    ['compact JSON at the mount limit', JSON.stringify(Array(21_000).fill(0)), 24_000, 42_001],
  ] as const) {
    it(`recovers ${name} exactly through bounded read-back pages`, async () => {
      const h = await startSpillTurn({
        prefix: 'spill-pageable-',
        result: { success: true, data: [{ type: 'text', text: body }] },
        withWorkspace: true,
        toolResultInlineMaxChars: cap,
        workspaceMaxFileSize: maxFileSize,
      });
      try {
        const stored = await waitForStoredToolResult(h.framework);
        assert.ok(stored);
        assert.doesNotMatch(stored.content, /re-indented|not retained/);
        const command = stored.content.match(/Page with workspace--read (\{[^\n]*?\});/);
        assert.ok(command, 'notice supplies a concrete bounded read');
        const input = JSON.parse(command[1]) as { path: string; offsetChars: number; limitChars: number };
        const file = await h.workspace!.readBinary(input.path);
        assert.ok('data' in file);
        assert.deepStrictEqual(file.data, Buffer.from(body), 'saved bytes are unchanged');
        if (maxFileSize !== undefined) {
          assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(body), null, 2)) > maxFileSize,
            'old formatting would have lost this result');
        }

        let recovered = '';
        let pages = 0;
        while (true) {
          const result = await h.framework.executeToolCall({
            id: `page-${pages}`, name: 'workspace--read', input, callerAgentName: 'prime',
          });
          assert.strictEqual(result.success, true, result.error);
          const page = result.data as { content: string; offsetChars: number; nextOffsetChars: number | null };
          assert.strictEqual(page.offsetChars, recovered.length);
          assert.ok(page.content.length > 0);
          // Exercise the actual stored/live spill policy on each read result.
          const storage = await (h.framework as unknown as {
            buildStoredToolResultContent(agent: string, calls: unknown[], cap: number): Promise<{
              spilled: Map<string, { text: string; filePath: string | null }>;
            }>;
          }).buildStoredToolResultContent('prime', [{
            id: `page-${pages}`, name: 'workspace--read', input, result, durationMs: 0,
          }], cap);
          const outcome = storage.spilled.get(`page-${pages}`)!;
          assert.strictEqual(outcome.filePath, null, 'read-back must not spill again');
          assert.ok(outcome.text.length <= cap);
          assert.strictEqual(JSON.parse(outcome.text).content, page.content);
          recovered += page.content;
          pages++;
          if (page.nextOffsetChars === null) break;
          assert.ok(page.nextOffsetChars > input.offsetChars, 'cursor must advance');
          input.offsetChars = page.nextOffsetChars;
          assert.ok(pages <= body.length, 'paging must terminate');
        }
        assert.ok(pages > 1);
        assert.strictEqual(recovered, body, 'all original text remains reachable, without token changes');
      } finally {
        await h.framework.stop();
        rmSync(h.tempDir, { recursive: true, force: true });
      }
    });
  }

  it('retains the review reproduction under the default 5 MiB mount limit', async () => {
    const data = Array(1_100_000).fill(0);
    const expected = Buffer.from(JSON.stringify(data));
    assert.strictEqual(expected.length, 2_200_001);
    assert.ok(Buffer.byteLength(JSON.stringify(data, null, 2)) > 5 * 1024 * 1024);
    const h = await startSpillTurn({
      prefix: 'spill-default-mount-limit-', result: { success: true, data }, withWorkspace: true,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored);
      const ref = stored.content.match(/workspace file (files\/tool-results\/\S+\.txt)/);
      assert.ok(ref);
      const file = await h.workspace!.readBinary(ref[1]);
      assert.ok('data' in file);
      assert.deepStrictEqual(file.data, expected);
      const lastPage = await h.workspace!.handleToolCall({
        id: 'tail', name: 'read', input: { path: ref[1], offsetChars: expected.length - 100, limitChars: 100 },
      });
      assert.strictEqual(lastPage.success, true);
      assert.deepStrictEqual((lastPage.data as { content: string }).content, expected.toString().slice(-100));
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('writes a non-JSON spill byte-for-byte and does not claim to have re-indented it', async () => {
    // Text results already have lines, and a spill file's contract is that it
    // holds what the tool actually returned.
    const body = Array.from({ length: 3000 }, (_, i) => `line ${i}: ${'t'.repeat(20)}`).join('\n');
    const h = await startSpillTurn({
      prefix: 'spill-verbatim-',
      result: { success: true, data: [{ type: 'text', text: body }] },
      withWorkspace: true,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.doesNotMatch(stored.content, /re-indented/);

      const refMatch = stored.content.match(/workspace file (files\/tool-results\/\S+\.txt)/);
      assert.ok(refMatch, 'reference should name the spill file');
      const file = await h.workspace!.readBinary(refMatch[1]);
      assert.ok('data' in file, 'spill file should be readable');
      assert.strictEqual((file as { data: Buffer }).data.toString('utf8'), body, 'verbatim');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('spills a plain string result as its text: lines intact, greppable, not one JSON-quoted line', async () => {
    // A module tool that answers with a line-per-item listing returns a
    // string. It used to be JSON-quoted on the way to history, so its spill
    // file held one escaped line that could only be paged by character.
    const body = Array.from({ length: 3000 }, (_, i) => `[review] org/repo#${i} "title ${i}"\tsize ${'t'.repeat(10)}`).join('\n');
    const h = await startSpillTurn({
      prefix: 'spill-string-',
      result: { success: true, data: body },
      withWorkspace: true,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.ok(stored.content.startsWith('[review] org/repo#0 "title 0"\t'), 'inline head is the text itself, unquoted');

      const refMatch = stored.content.match(/workspace file (files\/tool-results\/\S+\.txt)/);
      assert.ok(refMatch, 'reference should name the spill file');
      const file = await h.workspace!.readBinary(refMatch[1]);
      assert.ok('data' in file, 'spill file should be readable');
      const saved = (file as { data: Buffer }).data.toString('utf8');
      assert.strictEqual(saved, body, 'the spill file holds the string verbatim');
      assert.strictEqual(saved.split('\n').length, 3000, 'one line per item');

      // grep finds one item, on its own line.
      const grep = await h.workspace!.handleToolCall({
        id: 'grep', name: 'grep', input: { pattern: 'repo#2999 ', path: refMatch[1] },
      });
      assert.strictEqual(grep.success, true, grep.error);
      const matches = (grep.data as { results: Array<{ matches: Array<{ line: number; text: string }> }> })
        .results.flatMap((r) => r.matches);
      assert.deepStrictEqual(matches.map((m) => [m.line, m.text]), [[3000, body.split('\n')[2999]]]);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('a plain string result reaches history and the live wire as its text, byte-identical', async () => {
    const body = 'As of 10:00. 2 open.\n[review] org/repo#1 "Fix it"\n[merge] org/repo#2 done';
    const h = await startSpillTurn({
      prefix: 'string-wire-',
      result: { success: true, data: body },
      withWorkspace: false,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.strictEqual(stored.content, body, 'history holds the string, not its JSON encoding');
      const wire = h.membrane.lastStream?.receivedToolResults[0] as
        Array<{ content: unknown }> | undefined;
      assert.ok(wire && wire.length === 1, 'one wire tool result expected');
      assert.strictEqual(wire[0].content, body, 'the wire carries the same text');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to EXPLICIT plain truncation with no writable workspace', async () => {
    const h = await startSpillTurn({
      prefix: 'spill-nows-',
      result: { success: true, data: { blob: 'z'.repeat(42_000) } },
      withWorkspace: false,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.ok(stored.content.length < CAPPED, 'inline copy must be capped');
      assert.match(stored.content, /no writable workspace, full content not retained/);
      assert.doesNotMatch(stored.content, /workspace file/);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('preserves native image blocks and references the spill file from the wire text block', async () => {
    // 1x1 transparent PNG.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const h = await startSpillTurn({
      prefix: 'spill-image-',
      result: {
        success: true,
        data: [
          { type: 'text', text: 'T'.repeat(42_000) },
          { type: 'image', data: png, mimeType: 'image/png' },
        ],
      },
      withWorkspace: true,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      // History copy: text spilled; the image placeholder sits past the
      // preview boundary, so it lives in the spill file, never as base64.
      assert.match(stored.content, /full content: workspace file/);
      assert.doesNotMatch(stored.content, new RegExp(png.slice(0, 24)));
      const refMatch = stored.content.match(/workspace file (files\/tool-results\/\S+\.txt)/);
      assert.ok(refMatch, 'reference should name the spill file');
      const file = await h.workspace!.readBinary(refMatch[1]);
      assert.ok('data' in file, 'spill file should be readable');
      const full = (file as { data: Buffer }).data.toString('utf8');
      assert.match(full, /\[image: image\/png/, 'spill file keeps the image placeholder, not base64');
      // Wire copy: native blocks — image bytes intact, text bounded with a
      // pointer at the same spill file.
      const wire = h.membrane.lastStream?.receivedToolResults[0] as
        Array<{ content: unknown }> | undefined;
      assert.ok(wire && wire.length === 1, 'one wire tool result expected');
      const blocks = wire[0].content as Array<
        { type: string; text?: string; source?: { data?: string } }
      >;
      assert.ok(Array.isArray(blocks), 'wire content should be native blocks');
      const image = blocks.find((b) => b.type === 'image');
      assert.ok(image, 'image block must survive');
      assert.strictEqual(image.source?.data, png, 'base64 must be byte-intact');
      const text = blocks.find((b) => b.type === 'text');
      assert.ok(text?.text, 'text block expected');
      assert.ok(text.text.length < CAPPED, 'text block must be capped');
      assert.match(text.text, /full serialized result: workspace file files\/tool-results\//);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('reports a FAILED spill write distinctly from having no workspace, with a trace', async () => {
    // A writable mount exists but refuses the write (size cap). The agent
    // must NOT be told "no writable workspace" — that teaches them their
    // residence lacks a capability it actually has (opus-rev finding #1).
    const h = await startSpillTurn({
      prefix: 'spill-wfail-',
      result: { success: true, data: { blob: 'w'.repeat(60_000) } },
      withWorkspace: true,
      workspaceMaxFileSize: 20_000,
    });
    const traces: Array<Record<string, unknown>> = [];
    h.framework.onTrace((e) => {
      if ((e as { type: string }).type === 'tool:spill_failed') {
        traces.push(e as unknown as Record<string, unknown>);
      }
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.match(stored.content, /spill to workspace file files\/tool-results\/\S+\.txt FAILED \(/);
      assert.match(stored.content, /content over the cap was not retained/);
      assert.doesNotMatch(stored.content, /no writable workspace/);
      assert.strictEqual(traces.length, 1, 'exactly one tool:spill_failed trace expected');
      assert.strictEqual(traces[0].contentLength, 60_011);
      assert.match(String(traces[0].path), /files\/tool-results\//);
      assert.ok(String(traces[0].error).length > 0, 'trace should carry the failure reason');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('clamps the default down to the strategy bound and reports it', async () => {
    // maxMessageTokens=1000 → strategy bound 4000 < default 24000. This branch
    // decides the cap for every resident on a bounded strategy — pin it.
    const h = await startSpillTurn({
      prefix: 'spill-clamp-',
      result: { success: true, data: { blob: 'c'.repeat(42_000) } },
      withWorkspace: true,
      cappedStrategy: true,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.match(stored.content, /showing 4000 of \d+ chars/);
      const prov = capProvenance(h.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 4000);
      assert.strictEqual(prov.tool_result_inline_max_chars_source, 'default');
      assert.strictEqual(prov.tool_result_inline_max_chars_clamped_by, 'strategy-bound');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('restart keeps BOTH the configured cap and the resident-set value; reset returns to config', async () => {
    // The resident's agent_settings value is durable (antra + Sol, 08-06):
    // it persists in framework state like the core runtime settings.
    const { tempDir, storePath } = tempStorePath('spill-restart-');
    const boot = () => startSpillTurn({
      prefix: 'unused-',
      result: { success: true, data: { small: true } },
      withWorkspace: true,
      toolResultInlineMaxChars: 8_000,
      tempDir,
      storePath,
    });

    const first = await boot();
    try {
      frameworkExtension(first.framework).update('prime', { tool_result_inline_max_chars: 60_000 });
      assert.strictEqual(capProvenance(first.framework).tool_result_inline_max_chars_effective, 60_000);
    } finally {
      await first.framework.stop();
    }

    const second = await boot();
    try {
      const prov = capProvenance(second.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars, 60_000, 'resident value must survive restart');
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 60_000);
      assert.strictEqual(prov.tool_result_inline_max_chars_source, 'agent-settings-override');
      frameworkExtension(second.framework).reset('prime');
      const afterReset = capProvenance(second.framework);
      assert.strictEqual(afterReset.tool_result_inline_max_chars_effective, 8_000, 'reset returns to the residence config');
      assert.strictEqual(afterReset.tool_result_inline_max_chars_source, 'framework-config');
    } finally {
      await second.framework.stop();
    }

    const third = await boot();
    try {
      const prov = capProvenance(third.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars, null, 'reset must also survive restart');
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 8_000);
      assert.strictEqual(prov.tool_result_inline_max_chars_source, 'framework-config');
    } finally {
      await third.framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('hard-clamps a resident value above the strategy bound, reporting desired AND effective', async () => {
    // Sol's #94 ruling: persist the desired cap, but the effective inline
    // cap is min(desired, strategy bound) — durable preference must not be a
    // durable path past the per-message safety limit.
    const h = await startSpillTurn({
      prefix: 'spill-exceeds-',
      result: { success: true, data: { blob: 'q'.repeat(42_000) } },
      withWorkspace: true,
      cappedStrategy: true, // strategy bound 4000
    });
    try {
      frameworkExtension(h.framework).update('prime', { tool_result_inline_max_chars: 50_000 });
      const prov = capProvenance(h.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars, 50_000, 'desired value is preserved');
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 4_000, 'effective is hard-clamped');
      assert.strictEqual(prov.tool_result_inline_max_chars_source, 'agent-settings-override');
      assert.strictEqual(prov.tool_result_inline_max_chars_clamped_by, 'strategy-bound');
      // The clamp is enforced on the wire, not just reported.
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.match(stored.content, /showing 4000 of \d+ chars/);
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid configured cap at create()', async () => {
    const { tempDir, storePath } = tempStorePath('spill-invalid-');
    const membrane = new MockMembrane();
    try {
      await assert.rejects(
        AgentFramework.create({
          storePath,
          membrane: membrane.asMembrane(),
          agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'p', allowedTools: 'all' }],
          modules: [],
          syncIntervalMs: 0,
          toolResultInlineMaxChars: 500,
        }),
        /toolResultInlineMaxChars must be a number >= 1000/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
