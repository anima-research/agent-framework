import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('importing the package loads no discord.js, and constructing a DiscordJsClient loads it', () => {
  const probe = spawnSync(process.execPath, [
    fileURLToPath(new URL('./fixtures/discord-load-probe.mjs', import.meta.url)),
    new URL('../src/index.js', import.meta.url).href,
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, `stdout: ${probe.stdout}\nstderr: ${probe.stderr}`);
  assert.deepEqual(JSON.parse(probe.stdout), { afterImport: false, afterConstruct: true });
});
