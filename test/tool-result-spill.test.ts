/**
 * Oversized tool-result spill — completion coverage for issue #89.
 *
 * The mechanism (spill to workspace file + bounded preview) landed in
 * f231bbf; these tests pin the completion semantics: the house-safe 5000
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
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

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
  it('caps at the house default 5000 with no config and no strategy bound', async () => {
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
      assert.ok(stored.content.length < 6_000, `inline copy must be near the 5000 cap, got ${stored.content.length}`);
      assert.match(stored.content, /showing 5000 of \d+ chars; full content: workspace file files\/tool-results\//);
      const prov = capProvenance(h.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars, null);
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 5000);
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
      assert.ok(stored.content.length < 6_000, `inline error copy must be capped, got ${stored.content.length}`);
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

  it('falls back to EXPLICIT plain truncation with no writable workspace', async () => {
    const h = await startSpillTurn({
      prefix: 'spill-nows-',
      result: { success: true, data: { blob: 'z'.repeat(42_000) } },
      withWorkspace: false,
    });
    try {
      const stored = await waitForStoredToolResult(h.framework);
      assert.ok(stored, 'tool result should be stored');
      assert.ok(stored.content.length < 6_000, 'inline copy must be capped');
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
      assert.ok(text.text.length < 6_000, 'text block must be capped');
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
    // maxMessageTokens=1000 → strategy bound 4000 < default 5000. This branch
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
      assert.strictEqual(prov.tool_result_inline_max_chars_source, 'default (strategy-clamped)');
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

  it('flags a resident value pinned above the strategy bound in provenance', async () => {
    const h = await startSpillTurn({
      prefix: 'spill-exceeds-',
      result: { success: true, data: { small: true } },
      withWorkspace: true,
      cappedStrategy: true, // strategy bound 4000
    });
    try {
      frameworkExtension(h.framework).update('prime', { tool_result_inline_max_chars: 50_000 });
      const prov = capProvenance(h.framework);
      assert.strictEqual(prov.tool_result_inline_max_chars_effective, 50_000, 'resident value is honored');
      assert.strictEqual(
        prov.tool_result_inline_max_chars_source,
        'agent-settings-override (exceeds strategy bound)',
        'the over-bound pin must be visible, never silent',
      );
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
