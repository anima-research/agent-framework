import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/install-dependency-floors.mjs', import.meta.url));

const FAKE_NPM = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FLOORS_SEEN, JSON.stringify(args) + '\\n');
if (args[0] === 'view') {
  const answer = JSON.parse(process.env.FLOORS_VIEW)[args[1]];
  if (answer === undefined) {
    process.stderr.write('npm error code E404\\nnpm error 404 No match found for version ' + args[1].slice(args[1].lastIndexOf('@') + 1) + '\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(answer));
} else if (args[0] === 'install') {
  const instead = JSON.parse(process.env.FLOORS_INSTEAD ?? '{}');
  for (const spec of args.slice(2)) {
    const at = spec.lastIndexOf('@');
    const name = spec.slice(0, at);
    fs.mkdirSync('node_modules/' + name, { recursive: true });
    fs.writeFileSync('node_modules/' + name + '/package.json', JSON.stringify({ name, version: instead[name] ?? spec.slice(at + 1) }));
  }
}
`;

function floors(mode: string, manifest: object, view: Record<string, string | string[]>, opts: { leg?: object; instead?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'install-dependency-floors-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), FAKE_NPM);
    chmodSync(join(bin, 'npm'), 0o755);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    const seen = join(dir, 'seen');
    writeFileSync(seen, '');
    const run = spawnSync(process.execPath, [SCRIPT, mode], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'LEG')),
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        FLOORS_SEEN: seen,
        FLOORS_VIEW: JSON.stringify(view),
        FLOORS_INSTEAD: JSON.stringify(opts.instead ?? {}),
        ...(opts.leg ? { LEG: JSON.stringify(opts.leg) } : {}),
      },
    });
    const calls = readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
    const legsLine = /^legs=(.*)$/m.exec(run.stdout)?.[1];
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls, legs: legsLine === undefined ? undefined : JSON.parse(legsLine) as Array<{ name: string; install: Record<string, string> }> };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("plan: one leg at every range's lowest, from dependencies, optional and peer dependencies but not devDependencies", () => {
  const run = floors('plan', {
    dependencies: { 'discord.js': '^14.25.1', chokidar: '^4.0.3' },
    optionalDependencies: { ws: '^8.18.0' },
    peerDependencies: { chokidar: '^4.0.3' },
    devDependencies: { typescript: '^7.0.2' },
  }, {
    'discord.js@^14.25.1': ['14.26.0', '14.25.1', '14.28.1'],
    'chokidar@^4.0.3': '4.0.3',
    'ws@^8.18.0': ['8.22.2', '8.18.0', '8.19.0'],
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.legs, [{ name: 'lowest', install: { 'discord.js': '14.25.1', chokidar: '4.0.3', ws: '8.18.0' } }]);
  assert.ok(!run.calls.some((args) => args.join(' ').includes('typescript')), 'devDependencies are never asked about');
  assert.ok(!run.calls.some((args) => args[0] === 'install'), 'plan installs nothing');
});

test('plan: one more leg for each further line a || range admits, the rest at their lowest, and no crossed legs', () => {
  const run = floors('plan', {
    dependencies: { '@animalabs/membrane': '^0.8.0 || ^0.9.0', other: '^1.0.0 || ^2.0.0', ws: '^8.18.0' },
  }, {
    '@animalabs/membrane@^0.8.0 || ^0.9.0': ['0.9.0', '0.8.0', '0.9.2'],
    '@animalabs/membrane@^0.8.0': '0.8.0',
    '@animalabs/membrane@^0.9.0': ['0.9.2', '0.9.0'],
    'other@^1.0.0 || ^2.0.0': ['1.0.0', '2.1.0'],
    'other@^1.0.0': '1.0.0',
    'other@^2.0.0': ['2.1.0'],
    'ws@^8.18.0': '8.18.0',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.legs, [
    { name: 'lowest', install: { '@animalabs/membrane': '0.8.0', other: '1.0.0', ws: '8.18.0' } },
    { name: '@animalabs/membrane 0.9.0', install: { '@animalabs/membrane': '0.9.0', other: '1.0.0', ws: '8.18.0' } },
    { name: 'other 2.1.0', install: { '@animalabs/membrane': '0.8.0', other: '2.1.0', ws: '8.18.0' } },
  ]);
});

test('install: installs the leg it is given, without saving, and passes when each is at its floor', () => {
  const leg = { name: '@animalabs/membrane 0.9.0', install: { '@animalabs/membrane': '0.9.0', ws: '8.18.0' } };
  const run = floors('install', { dependencies: { '@animalabs/membrane': '^0.8.0 || ^0.9.0' }, peerDependencies: { ws: '^8.18.0' } }, {}, { leg });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls.find((args) => args[0] === 'install'), ['install', '--no-save', '@animalabs/membrane@0.9.0', 'ws@8.18.0']);
  assert.ok(!run.calls.some((args) => args[0] === 'view'), 'install asks the registry nothing');
});

test('install: fails, naming it, when a dependency is installed at a release other than its floor', () => {
  const run = floors('install', { dependencies: { ws: '^8.18.0' } }, {}, { leg: { name: 'lowest', install: { ws: '8.18.0' } }, instead: { ws: '8.22.2' } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Not at its floor: ws 8\.22\.2, not 8\.18\.0/);
});

test('install refuses, before npm runs, a LEG that is absent, empty, partial or names an undeclared dependency', () => {
  const manifest = { dependencies: { '@animalabs/membrane': '^0.8.0' }, optionalDependencies: { ws: '^8.18.0' } };
  const refused = [
    [undefined, /it gives none/],
    [{ name: 'lowest', install: {} }, /it gives none/],
    [{ name: 'lowest', install: { ws: '8.18.0' } }, /it leaves out @animalabs\/membrane$/m],
    [{ name: 'lowest', install: { '@animalabs/membrane': '0.8.0', ws: '8.18.0', other: '1.0.0' } }, /it names other, which package\.json doesn't declare/],
  ] as const;
  for (const [leg, why] of refused) {
    const run = floors('install', manifest, {}, leg ? { leg } : {});
    assert.equal(run.status, 1, JSON.stringify(leg));
    assert.match(run.stderr, /LEG must give a floor for each dependency package\.json declares/);
    assert.match(run.stderr, why);
    assert.deepEqual(run.calls, [], `npm never runs for ${JSON.stringify(leg)}`);
  }
});

test('plan refuses, naming it, a range that admits a prerelease', () => {
  const run = floors('plan', { dependencies: { early: '^1.0.0-rc.2' } }, { 'early@^1.0.0-rc.2': ['1.0.0-rc.2', '1.0.0-rc.10', '1.0.0'] });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /early \^1\.0\.0-rc\.2 admits a prerelease, 1\.0\.0-rc\.2/);
  assert.equal(run.legs, undefined);
});

test('plan fails, naming it, on a range or a || member that no published release satisfies, as npm answers it with E404', () => {
  const run = floors('plan', { dependencies: { ws: '^9.0.0' } }, {});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /npm view ws@\^9\.0\.0 version --json exited 1/);
  assert.equal(run.legs, undefined);
  const member = floors('plan', { dependencies: { m: '^0.8.0 || ^0.10.0' } }, { 'm@^0.8.0 || ^0.10.0': '0.8.0', 'm@^0.8.0': '0.8.0' });
  assert.equal(member.status, 1);
  assert.match(member.stderr, /npm view m@\^0\.10\.0 version --json exited 1/);
  assert.equal(member.legs, undefined);
});

test('plan refuses, naming it, a dependency whose spec is a git, file or other non-registry spec, before npm is asked anything', () => {
  for (const [name, spec] of [['ws', 'github:websockets/ws'], ['x', 'file:./sub']]) {
    const run = floors('plan', { dependencies: { [name]: spec } }, { 'ws@github:websockets/ws': '8.22.2', 'x@file:./sub': '1.2.3' });
    assert.equal(run.status, 1, spec);
    assert.ok(run.stderr.includes(`${name} is declared as ${spec}, which isn't a registry range`), run.stderr);
    assert.deepEqual(run.calls, [], spec);
    assert.equal(run.legs, undefined);
  }
});

test('plan refuses one name declared with two different ranges', () => {
  const run = floors('plan', { dependencies: { ws: '^8.18.0' }, peerDependencies: { ws: '^8.0.0' } }, {});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ws is declared as \^8\.18\.0 and as \^8\.0\.0/);
});
