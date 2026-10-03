/**
 * MCPL RFC-008 tool classes: the server's `_meta["mcpl/class"]` hint, the
 * host's effective class (override > host knowledge > server declaration),
 * and the RFC-007 §6.2 pattern grammar the tables use.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_TOOL_CLASSES,
  normalizeClassTable,
  parseDeclaredClasses,
  resolveToolClass,
} from '../src/mcpl/tool-classes.js';
import { globMatch } from '../src/mcpl/tool-glob.js';

const quiet = <T>(fn: () => T): T => {
  const orig = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = orig; }
};

const builtin = normalizeClassTable(BUILTIN_TOOL_CLASSES as Record<string, readonly string[]>, 'builtin');

test('vector 1 — declared', () => {
  assert.deepEqual(parseDeclaredClasses({ 'mcpl/class': ['shell'] }), ['shell']);
});

test('vector 2 — nothing declared → unclassed', () => {
  assert.equal(parseDeclaredClasses(undefined), undefined);
  assert.equal(parseDeclaredClasses({}), undefined);
  assert.deepEqual(resolveToolClass('s--go', undefined, { overrides: [], host: [] }), { classes: [], source: 'none' });
});

test('vectors 3/4 — unknown strings are ignored; only-unknown is unclassed', () => {
  assert.equal(quiet(() => parseDeclaredClasses({ 'mcpl/class': ['quantum'] })), undefined);
  assert.deepEqual(quiet(() => parseDeclaredClasses({ 'mcpl/class': ['shell', 'quantum', 'shell'] })), ['shell']);
  assert.equal(quiet(() => parseDeclaredClasses({ 'mcpl/class': 'shell' })), undefined, 'non-array is malformed');
});

test('vector 6 — override wins entirely over the declaration', () => {
  const r = resolveToolClass('s--speak', ['body'], { overrides: [['s--speak', ['comms']]], host: [] });
  assert.deepEqual(r, { classes: ['comms'], source: 'override' });
});

test('vector 7 — host built-ins have the class the host assigns', () => {
  const r = (name: string) => resolveToolClass(name, undefined, { overrides: [], host: builtin });
  assert.deepEqual(r('channel_publish'), { classes: ['comms'], source: 'host' });
  assert.deepEqual(r('skip_reply').classes, ['comms']);
  assert.deepEqual(r('journal').classes, ['memory']);
  assert.deepEqual(r('code_execution').classes, ['shell']);
  assert.deepEqual(r('discord--send').classes, ['comms']);
  assert.deepEqual(r('workspace--write').classes, ['files']);
  assert.deepEqual(r('something_new').classes, [], 'an unlisted built-in fails closed: unclassed');
});

test('precedence: override > host > server; first pattern wins within a source', () => {
  const tables = {
    overrides: [['x--*', ['files']], ['x--a', ['comms']]] as Array<[string, Array<'files' | 'comms'>]>,
    host: [['x--a', ['control']]] as Array<[string, Array<'control'>]>,
  };
  assert.equal(resolveToolClass('x--a', ['shell'], tables).source, 'override');
  assert.deepEqual(resolveToolClass('x--a', ['shell'], tables).classes, ['files']);
  assert.equal(resolveToolClass('y--a', ['shell'], { overrides: [], host: [['y--a', ['control']]] }).source, 'host');
  assert.equal(resolveToolClass('y--a', ['shell'], { overrides: [], host: [] }).source, 'server');
});

test('config tables drop unknown classes and empty entries', () => {
  const t = quiet(() => normalizeClassTable({ 'a--*': ['files', 'nope'], 'b--*': ['nope'] }, 'cfg'));
  assert.deepEqual(t, [['a--*', ['files']]]);
});

test('glob: * is any run, whole-string, case-sensitive, nothing else is special', () => {
  assert.ok(globMatch('computer--*', 'computer--click'));
  assert.ok(globMatch('*', ''));
  assert.ok(globMatch('a*b*c', 'aXXbYYc'));
  assert.ok(!globMatch('a*b*c', 'aXXbYY'));
  assert.ok(!globMatch('Click', 'click'));
  assert.ok(globMatch('a.b', 'a.b'));
  assert.ok(!globMatch('a.b', 'aXb'), '. is literal');
  assert.ok(!globMatch('a?', 'ab'), '? is literal');
  assert.ok(globMatch('a?', 'a?'));
});

test('glob: adversarial patterns stay fast (no exponential backtracking)', () => {
  const pattern = '*a*a*a*a*a*a*a*a*a*a*b';
  const subject = 'a'.repeat(4000);
  const t0 = Date.now();
  assert.equal(globMatch(pattern, subject), false);
  assert.ok(Date.now() - t0 < 500, 'should finish well under half a second');
});
