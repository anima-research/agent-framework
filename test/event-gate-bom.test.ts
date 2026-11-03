import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig } from '../src/gate/types.js';

// #395: a gate file saved as UTF-8 with a BOM (some Windows editors do this)
// must load like the same file without one.

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-bom');
const BOM = '\uFEFF';

function writeWithBom(name: string, value: unknown): string {
  const path = join(TMP_DIR, name);
  writeFileSync(path, BOM + JSON.stringify(value, null, 2), 'utf8');
  return path;
}

function makeGate(configPath: string, privilegedUsersPath?: string) {
  return new EventGate({
    configPath,
    ...(privilegedUsersPath ? { privilegedUsersPath } : {}),
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
  });
}

const config: GateConfig = {
  policies: [{ name: 'from-bom-file', match: {}, behavior: 'always' }],
  default: 'skip',
};

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('EventGate: UTF-8 BOM in gate files (#395)', () => {
  it('loads a gate.json that starts with a BOM', async () => {
    const gate = makeGate(writeWithBom('gate.json', config));
    const status = (await gate.handleToolCall()).data!;
    assert.deepStrictEqual(status.errors, []);
    assert.strictEqual(status.configSource, 'file');
    assert.deepStrictEqual(status.policies.map(p => p.name), ['from-bom-file']);
  });

  it('loads a privileged-users file that starts with a BOM', async () => {
    const gatePath = writeWithBom('gate.json', config);
    const privPath = writeWithBom('privileged.json', { userIds: ['u-1', 42] });
    const gate = makeGate(gatePath, privPath);
    assert.strictEqual(gate.isPrivilegedUser('u-1'), true);
    assert.strictEqual(gate.isPrivilegedUser('42'), true);
    assert.strictEqual(gate.isPrivilegedUser('u-2'), false);
    const status = (await gate.handleToolCall()).data!;
    assert.deepStrictEqual(status.errors, []);
  });

  it('still rejects text that is not JSON after the BOM', async () => {
    const path = join(TMP_DIR, 'broken.json');
    writeFileSync(path, BOM + BOM + '{}', 'utf8');
    const gate = makeGate(path);
    const status = (await gate.handleToolCall()).data!;
    assert.strictEqual(status.errors.length, 1);
  });
});
