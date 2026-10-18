import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReferenceStub, classifyBlock, isReferenceExpired, sanitizeLabel, REFERENCE_LIMITS,
  referenceRegistry, referenceStubOrNull, UNBOUND_REASON, unfetchableReason,
} from '../src/mcpl/references.js';

const fields = ['name', 'mimeType', 'expiresAt'] as const;
const types = ['resource', 'image', 'audio'] as const;
function reference(type: string, extra: Record<string, unknown> = {}) {
  const block = { type, uri: 'https://example.test/optional-fields', disposition: 'never', ...extra };
  const parsed = classifyBlock(block);
  assert.equal(parsed.kind, 'reference');
  if (parsed.kind !== 'reference') throw new Error('expected reference');
  return { block, testimony: parsed.testimony };
}

for (const field of fields) {
  test('drops overlong optional ' + field + ' while preserving each reference block and disposition', () => {
    for (const type of types) {
      const { block, testimony } = reference(type, { [field]: 'x'.repeat(REFERENCE_LIMITS[field] + 1) });
      assert.equal(testimony[field], undefined, 'invalid optional metadata is absent, not repaired');
      assert.deepEqual(testimony.rejectedFields, [field]);
      assert.deepEqual(testimony.truncatedFields, []);
      assert.equal(testimony.uri, block.uri);
      assert.equal(testimony.disposition, 'never');
      assert.ok(referenceStubOrNull(block)?.startsWith('[ref_'));
      assert.ok(!referenceStubOrNull(block)?.includes(block.uri));
    }
  });

  test('admits ' + field + ' exactly at its JSON Schema code-point limit without changing it', () => {
    for (const value of ['', 'x'.repeat(REFERENCE_LIMITS[field]), '🪶'.repeat(REFERENCE_LIMITS[field])]) {
      const { testimony } = reference('resource', { [field]: value });
      assert.equal(testimony[field], value);
      assert.deepEqual(testimony.rejectedFields, []);
      assert.deepEqual(testimony.truncatedFields, []);
    }
    const { testimony } = reference('resource', { [field]: '🪶'.repeat(REFERENCE_LIMITS[field]) + 'x' });
    assert.equal(testimony[field], undefined);
    assert.deepEqual(testimony.rejectedFields, [field]);
  });
}

test('wrong-type optional fields are dropped while a bad required URI rejects the block', () => {
  const { testimony } = reference('resource', { name: 123, mimeType: null, expiresAt: [] });
  assert.equal(testimony.name, undefined);
  assert.equal(testimony.mimeType, undefined);
  assert.equal(testimony.expiresAt, undefined);
  assert.deepEqual(testimony.rejectedFields.sort(), ['expiresAt', 'mimeType', 'name']);
  assert.equal(testimony.disposition, 'never');
  for (const uri of [undefined, null, '', 'x'.repeat(REFERENCE_LIMITS.uri + 1)]) {
    assert.equal(classifyBlock({ type: 'resource', uri, disposition: 'never' }).kind, 'invalid');
  }
});

test('schema-admitted metadata still uses independent sanitized and bounded display labels', () => {
  const name = 'A'.repeat(REFERENCE_LIMITS.name - 2) + '\u202E\n';
  const mimeType = 'B'.repeat(REFERENCE_LIMITS.mimeType);
  const { testimony } = reference('resource', { name, mimeType });
  const stub = buildReferenceStub(testimony);
  const record = referenceRegistry.findByUri(testimony.uri)!;
  assert.equal(record.testimony.name, name, 'display bounds do not alter admitted testimony');
  assert.equal(record.testimony.mimeType, mimeType);
  assert.ok(stub.includes('A'.repeat(119) + '…'));
  assert.ok(stub.includes('B'.repeat(119) + '…'));
  assert.ok(!stub.includes('\u202E') && !stub.includes('\n'));
  assert.ok(!stub.includes(testimony.uri));
  assert.ok(stub.length < 350);
});

test('an admitted but unparseable expiry still fails closed; a schema-invalid expiry is absent, and fails closed too', () => {
  const validShape = reference('resource', { expiresAt: 'not-a-date' }).testimony;
  assert.equal(isReferenceExpired(validShape), true);
  const invalidShape = reference('resource', { expiresAt: 'x'.repeat(REFERENCE_LIMITS.expiresAt + 1) }).testimony;
  assert.equal(invalidShape.expiresAt, undefined);
  assert.deepEqual(invalidShape.rejectedFields, ['expiresAt']);
  assert.equal(isReferenceExpired(invalidShape), true, 'an overlong expiry is never read as immortal');
  const notAString = reference('resource', { expiresAt: 1_900_000_000 }).testimony;
  assert.equal(isReferenceExpired(notAString), true, 'nor is one that is not a string');
  const nullExpiry = reference('resource', { expiresAt: null }).testimony;
  assert.deepEqual(nullExpiry.rejectedFields, ['expiresAt'], 'null is not a string either');
  assert.equal(isReferenceExpired(nullExpiry), true, 'and fails closed too');
  const absent = reference('resource', {}).testimony;
  assert.equal(isReferenceExpired(absent), false, 'a reference that claims no expiry has none');
  const future = reference('resource', { expiresAt: '2999-01-01T00:00:00Z' }).testimony;
  assert.equal(isReferenceExpired(future, Date.parse('2026-10-12T00:00:00Z')), false, 'an expiry still ahead has not passed');
  // Only a rejected expiry makes a reference expired: other rejected fields don't.
  const badName = reference('resource', { name: 123, sizeBytes: -1, digest: 'sha256:short' }).testimony;
  assert.deepEqual(badName.rejectedFields.sort(), ['digest', 'name', 'sizeBytes']);
  assert.equal(isReferenceExpired(badName), false);
});

test('the stub shows every server label without controls, and leaves out one that sanitizes to nothing', () => {
  // Its own uri: the saved path it sets below stays on this test's record in the shared registry.
  const { testimony } = reference('resource', {
    uri: 'https://example.test/stub-labels', name: '\u061C\u202E', mimeType: 'image/\u202Epng\u061C', sizeBytes: 10,
  });
  const stub = buildReferenceStub(testimony, 'from \u2066a\u0085tool\u2069');
  assert.ok(!/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(stub), stub);
  assert.ok(stub.includes('image/png, 10B claimed'), stub);
  assert.ok(stub.includes('from atool'), stub);
  const segments = stub.slice(stub.indexOf('] ') + 2).split(' — ');
  assert.ok(segments.every((part) => part.trim() !== ''), `no empty segment for the name that sanitized away: ${JSON.stringify(stub)}`);
  const record = referenceRegistry.findByUri(testimony.uri)!;
  record.fetchedPath = 'scratch/refs/\u202Eevil\u061C.bin';
  assert.ok(buildReferenceStub(testimony).includes('saved: scratch/refs/evil.bin'));
});

test('the stub leaves out a type, or a provenance, that sanitizes to nothing', () => {
  const typeGone = reference('resource', { uri: 'https://example.test/stub-type-gone', mimeType: '\u202E\u061C', sizeBytes: 10 }).testimony;
  const typeStub = buildReferenceStub(typeGone, 'from a tool', 'srv');
  assert.equal(typeStub, `[${referenceRegistry.findByUri(typeGone.uri)!.refId}] 10B claimed — from a tool — fetch with fetch_reference`);
  const originGone = reference('resource', { uri: 'https://example.test/stub-origin-gone', mimeType: 'image/png' }).testimony;
  const originStub = buildReferenceStub(originGone, '\u2066\u0085\u2069', 'srv');
  assert.equal(originStub, `[${referenceRegistry.findByUri(originGone.uri)!.refId}] image/png — fetch with fetch_reference`);
});

test("an expired reference's stub says why, where a live one's advises fetch_reference", () => {
  // Each bound to its server, as a tool result's references are, so the expiry is what's left to say.
  const cases = [['2001-01-01T00:00:00Z', /expired: its expiresAt has passed/], ['not-a-date', /treated as expired: its expiresAt does not parse/],
    ['x'.repeat(REFERENCE_LIMITS.expiresAt + 1), /treated as expired: its expiresAt was rejected as a field/]] as const;
  for (const [i, [expiresAt, why]] of cases.entries()) {
    const { testimony } = reference('resource', { uri: `https://example.test/stub-expired-${i}`, expiresAt });
    const stub = buildReferenceStub(testimony, undefined, 'srv');
    assert.match(stub, why);
    assert.ok(!stub.includes('fetch_reference'), stub);
  }
  const live = reference('resource', { uri: 'https://example.test/stub-live', expiresAt: '2999-01-01T00:00:00Z' }).testimony;
  assert.match(buildReferenceStub(live, undefined, 'srv'), /\] fetch with fetch_reference$/);
  // A copy saved before its expiry passed is still served, and its stub says where.
  const saved = reference('resource', { uri: 'https://example.test/stub-expired-0', expiresAt: '2001-01-01T00:00:00Z' }).testimony;
  const savedRecord = referenceRegistry.findByUri(saved.uri)!;
  savedRecord.fetchedPath = 'scratch/refs/kept.png';
  assert.match(buildReferenceStub(saved), /\] saved: scratch\/refs\/kept\.png$/);
  // So no refusal is foreseen for it either, whoever asks.
  assert.equal(unfetchableReason(savedRecord), null);
});

test("an unbound reference's stub says it can't be fetched and why, where a bound one's advises fetch_reference", () => {
  // Registered with no server, as an in-process module's reference or a channel message's is.
  const { testimony } = reference('resource', { uri: 'https://example.test/stub-unbound' });
  const unbound = buildReferenceStub(testimony, 'from a module');
  assert.ok(unbound.endsWith(`] from a module — ${UNBOUND_REASON}`), unbound);
  assert.ok(!unbound.includes('fetch_reference'), unbound);
  // Expired as well: the fetcher refuses it as unbound first, so the stub says that.
  const { testimony: both } = reference('resource', { uri: 'https://example.test/stub-unbound-expired', expiresAt: '2001-01-01T00:00:00Z' });
  assert.ok(buildReferenceStub(both).endsWith(`] ${UNBOUND_REASON}`));
  // A later registration that knows its server binds the record, and the next stub advises fetch_reference.
  assert.ok(buildReferenceStub(testimony, 'from a server', 'srv').endsWith('] from a server — fetch with fetch_reference'));
});

test('display labels lose every bidi control, the Arabic letter mark included', () => {
  const controls = ['\u061C', '\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069'];
  for (const ch of controls) {
    assert.equal(sanitizeLabel(`a${ch}b`, 100), 'ab', `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  assert.equal(sanitizeLabel('a\u0000\u001F\u007F\u0085\u009Fb', 100), 'ab', 'C0, DEL and C1 controls');
  assert.equal(sanitizeLabel('\u0627\u0644\u0639\u0631\u0628\u064A\u0629 \u05E2\u05D1\u05E8\u05D9\u05EA', 100), '\u0627\u0644\u0639\u0631\u0628\u064A\u0629 \u05E2\u05D1\u05E8\u05D9\u05EA', 'right-to-left text itself is kept');
});

test('display labels are trimmed, so a label of whitespace is nothing', () => {
  assert.equal(sanitizeLabel(' \uFEFFimage/png \u202E', 100), 'image/png', 'whitespace and a BOM left at either end');
  assert.equal(sanitizeLabel('a b', 100), 'a b', 'inner whitespace is kept');
  assert.equal(sanitizeLabel(' \u00A0 ', 100), '');
});

test('large invalid labels cannot change the bounded model-visible stub', () => {
  const { testimony } = reference('audio', {
    name: 'x'.repeat(1024 * 1024), mimeType: 'y'.repeat(1024 * 1024), sizeBytes: 1024,
  });
  assert.equal(testimony.name, undefined);
  assert.equal(testimony.mimeType, undefined);
  const stub = buildReferenceStub(testimony, 'server', 'srv');
  assert.ok(stub.length < 150);
  assert.ok(stub.includes('claimed'));
  assert.ok(stub.includes('fetch with fetch_reference'), `an unfetched reference's stub: ${stub}`);
  assert.ok(!stub.includes(testimony.uri));
});
