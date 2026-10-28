import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintVouches, type StatFingerprint } from '../src/modules/workspace/observe.js';
import type { Fingerprint } from '../src/modules/workspace/disk-agreement.js';

const MS = 1_000_000n;
const HASHED_AT = 1_800_000_000_000;
const at = (ms: number) => (BigInt(ms) * MS).toString();

function file(beforeHash: number, fields: Partial<StatFingerprint> = {}): StatFingerprint {
  return { size: 4, mtimeNs: at(HASHED_AT - beforeHash), ctimeNs: at(HASHED_AT - beforeHash), ino: '1234', dev: '66306', ...fields };
}
const recorded = (f: StatFingerprint): Fingerprint => ({ ...f, hashedAt: HASHED_AT });

describe('a recorded fingerprint vouches for the bytes hashed with it', () => {
  test('when none of size, mtime, ctime, inode and device has changed since, and its stamps are past the window', () => {
    const was = file(10_000);
    assert.equal(fingerprintVouches(recorded(was), was, true), true, 'nothing changed, stamps 10 s before the hash');
  });

  test('not once the size alone has changed', () => {
    const was = file(10_000);
    assert.equal(fingerprintVouches(recorded(was), { ...was, size: 5 }, true), false);
  });

  test('not once mtime alone has changed', () => {
    const was = file(10_000);
    assert.equal(fingerprintVouches(recorded(was), { ...was, mtimeNs: (BigInt(was.mtimeNs) + 1n).toString() }, true), false);
  });

  test('not once ctime alone has changed', () => {
    const was = file(10_000);
    assert.equal(fingerprintVouches(recorded(was), { ...was, ctimeNs: (BigInt(was.ctimeNs) + 1n).toString() }, true), false);
  });

  test('not once the inode alone has changed', () => {
    const was = file(10_000);
    assert.equal(fingerprintVouches(recorded(was), { ...was, ino: '1235' }, true), false);
  });

  test('not once the device alone has changed', () => {
    const was = file(10_000);
    assert.equal(fingerprintVouches(recorded(was), { ...was, dev: '66307' }, true), false);
  });
});

describe('a recorded fingerprint vouches only for stamps more than 2,000 ms older than the hash', () => {
  test('not for stamps exactly 2,000 ms before the hash', () => {
    const was = file(2_000);
    assert.equal(fingerprintVouches(recorded(was), was, true), false);
  });

  test('for stamps 2,000 ms and 1 ns before the hash', () => {
    const stamp = (BigInt(HASHED_AT - 2_000) * MS - 1n).toString();
    const was = file(10_000, { mtimeNs: stamp, ctimeNs: stamp });
    assert.equal(fingerprintVouches(recorded(was), was, true), true);
  });

  test('not for a ctime inside the window, though mtime is older', () => {
    const was = file(10_000, { ctimeNs: at(HASHED_AT - 500) });
    assert.equal(fingerprintVouches(recorded(was), was, true), false);
  });

  test('not for an mtime inside the window, though ctime is older', () => {
    const was = file(10_000, { mtimeNs: at(HASHED_AT - 500) });
    assert.equal(fingerprintVouches(recorded(was), was, true), false);
  });
});
