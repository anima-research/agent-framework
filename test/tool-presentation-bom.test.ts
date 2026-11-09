import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolPresentation } from '../src/tool-presentation.js';
import type { ToolDefinition } from '../src/index.js';

// #758: a tool presentation file, or a description defaults file, saved as
// UTF-8 with a BOM (some Windows editors do this) must be read like the same
// file without one.

const BOM = '\uFEFF';
const tools = ['alpha', 'beta', 'gamma'].map((name) => ({
  name, description: `The ${name} tool.`, inputSchema: { type: 'object' as const, properties: {} },
})) as unknown as ToolDefinition[];

let dir: string;

function writeWithBom(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, BOM + JSON.stringify(value, null, 2) + '\n', 'utf8');
  return path;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'presentation-bom-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ToolPresentation: UTF-8 BOM in presentation files (#758)', () => {
  it('applies a presentation file that starts with a BOM', () => {
    const path = writeWithBom('tools.json', { version: 1, tools: { alpha: { visible: false }, beta: { description: 'Beta, as the operator wrote it.' } } });
    const snap = new ToolPresentation({ path, cataloguePath: 'board/tools.md' }).resolve(tools);
    assert.deepStrictEqual(snap.diagnostics, []);
    assert.deepStrictEqual(snap.advertised.map((t) => t.name), ['beta', 'gamma']);
    assert.strictEqual(snap.entries.find((e) => e.name === 'beta')!.description, 'Beta, as the operator wrote it.');
  });

  it('edits a presentation file that starts with a BOM, keeping its settings', () => {
    const path = writeWithBom('tools.json', { version: 1, tools: { alpha: { visible: false } } });
    const p = new ToolPresentation({ path, cataloguePath: 'board/tools.md' });
    const r = p.edit('set_tool_visibility', { name: 'gamma', visible: false }, tools);
    assert.strictEqual(r.success, true, r.error);
    const written = readFileSync(path, 'utf8');
    assert.deepStrictEqual(JSON.parse(written).tools, { alpha: { visible: false }, gamma: { visible: false } });
    assert.deepStrictEqual(p.resolve(tools).advertised.map((t) => t.name), ['beta']);
  });

  it('applies a description defaults file that starts with a BOM', () => {
    const defaults = writeWithBom('defaults.json', { version: 1, tools: { gamma: { description: 'Gamma, by default.' } } });
    const snap = new ToolPresentation({
      path: join(dir, 'absent.json'), cataloguePath: 'board/tools.md',
      defaults: [{ source: 'Unattributed', path: defaults }],
    }).resolve(tools);
    assert.deepStrictEqual(snap.diagnostics, []);
    assert.strictEqual(snap.entries.find((e) => e.name === 'gamma')!.description, 'Gamma, by default.');
  });

  it('still refuses a file that is not JSON after one BOM', () => {
    const path = join(dir, 'tools.json');
    writeFileSync(path, BOM + BOM + '{}', 'utf8');
    const snap = new ToolPresentation({ path, cataloguePath: 'board/tools.md' }).resolve(tools);
    assert.strictEqual(snap.diagnostics.length, 1);
    assert.match(snap.diagnostics[0], /isn't valid JSON/);
  });
});
