import { it } from 'node:test';
import assert from 'node:assert/strict';
import { firstFreeBranchName } from '../src/branch-names.js';

it('firstFreeBranchName returns the base when it is free, else the first free numbered name', () => {
  const taken = (names: string[]) => (name: string) => names.includes(name);
  assert.equal(firstFreeBranchName('suppress/a/1', taken([])), 'suppress/a/1');
  assert.equal(firstFreeBranchName('suppress/a/1', taken(['main'])), 'suppress/a/1');
  assert.equal(firstFreeBranchName('suppress/a/1', taken(['suppress/a/1'])), 'suppress/a/1-2');
  assert.equal(firstFreeBranchName('suppress/a/1', taken(['suppress/a/1', 'suppress/a/1-2'])), 'suppress/a/1-3');
  // A gap is reused: the first free name wins, not one past the highest.
  assert.equal(firstFreeBranchName('suppress/a/1', taken(['suppress/a/1', 'suppress/a/1-3'])), 'suppress/a/1-2');
});
