/**
 * The ranges agent-framework declares for its release set (#291).
 *
 * context-manager's range takes only a release with the window APIs the
 * presentation index calls. Main published context-manager 0.23.0, then 0.24.0
 * (Dendrite's derive), without them, so the presentation release is 0.25.0, and
 * a range that admitted 0.24.0 would install a context-manager this framework fails to load on.
 * chronicle's range takes only a release with the identity-stamped batched
 * append context-manager writes a window with: the published 0.5.0 (Dendrite's
 * branch views) has none of the batched calls, so the presentation release is
 * 0.6.0, and context-manager, with no one-record-per-row path, throws at the
 * first write-down on a store from 0.5.0.
 * Each @animalabs package context-manager depends on too is declared within
 * context-manager's own range, so an install takes one copy of each: two
 * membrane copies make the host's `Membrane` a type context-manager's
 * refuses, and hand context-manager's formatter to a membrane its tests
 * don't cover; two chronicle copies give context-manager a store handle from
 * a chronicle it doesn't load.
 *
 * Whether a range admits the installed version is asked only of a package
 * installed from the registry. A sibling tree linked into node_modules (a
 * presentation branch built beside this one) keeps its main's version number
 * until its release is cut, so it is checked by the calls it has instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';

type Manifest = { name: string; version: string; dependencies?: Record<string, string> };
// From dist/test, as the suite runs.
const manifest = (path: string): Manifest => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Manifest;
const ours = manifest('../../package.json');
const installed = (name: string): Manifest => manifest(`../../node_modules/${name}/package.json`);
/** Whether `name` is a sibling tree linked into node_modules, which keeps its main's version until its release is cut. */
const linked = (name: string): boolean => lstatSync(new URL(`../../node_modules/${name}`, import.meta.url)).isSymbolicLink();

/** A caret range's floor (`^M.m.p`), the one form the release set declares. */
function floorOf(range: string): [number, number, number] {
  const parts = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  assert.ok(parts, `${range} is a caret range on a release`);
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/** Whether the caret `range` admits the release `version`, as npm reads it:
 *  at or above the floor, below the next change of its first nonzero part. */
function admits(range: string, version: string): boolean {
  const [major, minor, patch] = floorOf(range);
  const [vMajor, vMinor, vPatch] = version.split('.').map(Number) as [number, number, number];
  const atOrAbove = vMajor > major || (vMajor === major && (vMinor > minor || (vMinor === minor && vPatch >= patch)));
  if (!atOrAbove) return false;
  if (major > 0) return vMajor === major;
  if (minor > 0) return vMajor === 0 && vMinor === minor;
  return vMajor === 0 && vMinor === 0 && vPatch === patch;
}

/** Whether every release the caret range `inner` admits, `outer` admits:
 *  caret ranges nest or are apart, so it is whether `outer` takes `inner`'s floor. */
const within = (inner: string, outer: string): boolean => admits(outer, floorOf(inner).join('.'));

describe("agent-framework's dependency ranges (#291's release set)", () => {
  it('the caret reading', () => {
    assert.equal(admits('^0.25.0', '0.25.3'), true);
    assert.equal(admits('^0.25.0', '0.24.0'), false);
    assert.equal(admits('^0.25.0', '0.26.0'), false);
    assert.equal(admits('^1.2.0', '1.9.0'), true);
    assert.equal(admits('^0.0.3', '0.0.4'), false);
    assert.equal(within('^0.8.2', '^0.8.0'), true);
    assert.equal(within('^0.7.1', '^0.8.0'), false);
    assert.equal(within('^0.8.0', '^0.8.2'), false);
  });

  it("takes context-manager only at a release with the window APIs: not main's 0.23.0 or 0.24.0, which have none", (t) => {
    const range = ours.dependencies?.['@animalabs/context-manager'];
    assert.ok(range, 'agent-framework depends on context-manager');
    for (const published of ['0.23.0', '0.24.0']) {
      assert.equal(admits(range, published), false,
        `${range} admits context-manager ${published}, published without windowStatusOf, presentRows, retractRows or getPresentedMessages`);
    }
    const proto = ContextManager.prototype as unknown as Record<string, unknown>;
    for (const method of ['windowStatusOf', 'presentRows', 'retractRows', 'getPresentedMessages']) {
      assert.equal(typeof proto[method], 'function', `the context-manager this suite runs on has ${method}`);
    }
    const version = installed('@animalabs/context-manager').version;
    if (linked('@animalabs/context-manager')) {
      t.diagnostic(`context-manager is a linked tree (version ${version}): the range is not asked of it`);
      return;
    }
    assert.ok(admits(range, version), `${range} admits the context-manager this suite runs on (${version})`);
  });

  it("takes chronicle only at a release with the batched append: not 0.4.0, or the published 0.5.0, which has none", (t) => {
    const range = ours.dependencies?.['@animalabs/chronicle'];
    assert.ok(range, 'agent-framework depends on chronicle');
    for (const published of ['0.4.0', '0.5.0']) {
      assert.equal(admits(range, published), false,
        `${range} admits chronicle ${published}, published without appendManyToStateJsonWithIdentity, appendManyToStateJson, getStateItemsJson or getRecords`);
    }
    const proto = JsStore.prototype as unknown as Record<string, unknown>;
    for (const method of ['appendManyToStateJsonWithIdentity', 'appendManyToStateJson', 'getStateItemsJson', 'getRecords']) {
      assert.equal(typeof proto[method], 'function', `the chronicle this suite runs on has JsStore.${method}`);
    }
    const version = installed('@animalabs/chronicle').version;
    if (linked('@animalabs/chronicle')) {
      t.diagnostic(`chronicle is a linked tree (version ${version}): the range is not asked of it`);
      return;
    }
    assert.ok(admits(range, version), `${range} admits the chronicle this suite runs on (${version})`);
  });

  it("names the declared floors in create()'s refusals", () => {
    // The refusals tell an operator what to install; each names the range package.json declares.
    const source = readFileSync(new URL('../../src/framework.ts', import.meta.url), 'utf8');
    for (const name of ['@animalabs/context-manager', '@animalabs/chronicle']) {
      const range = ours.dependencies![name]!;
      assert.ok(source.includes(`Install ${name} ${range}, which this package declares`), `create() names ${name} ${range}`);
    }
  });

  it("declares each @animalabs package context-manager depends on within context-manager's range, so an install takes one copy of each", () => {
    const contextManager = installed('@animalabs/context-manager');
    const shared = Object.entries(contextManager.dependencies ?? {})
      .filter(([name]) => name.startsWith('@animalabs/') && ours.dependencies?.[name] !== undefined);
    assert.ok(shared.some(([name]) => name === '@animalabs/membrane'), 'both depend on membrane');
    assert.ok(shared.some(([name]) => name === '@animalabs/chronicle'), 'both depend on chronicle');
    const apart = shared
      .filter(([name, theirs]) => !within(ours.dependencies![name]!, theirs))
      .map(([name, theirs]) => `${name}: agent-framework ${ours.dependencies![name]}, context-manager ${contextManager.version} ${theirs}`);
    assert.deepEqual(apart, []);
    if (linked('@animalabs/membrane')) return;
    const membrane = installed('@animalabs/membrane');
    assert.ok(admits(ours.dependencies!['@animalabs/membrane']!, membrane.version),
      `${ours.dependencies!['@animalabs/membrane']} admits the membrane this suite runs on (${membrane.version})`);
  });
});
