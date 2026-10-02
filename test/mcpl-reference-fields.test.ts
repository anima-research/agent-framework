import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReferenceStub, classifyBlock, isReferenceExpired, REFERENCE_LIMITS,
  referenceRegistry, referenceStubOrNull,
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

test('an admitted but unparseable expiry still fails closed; schema-invalid expiry is absent', () => {
  const validShape = reference('resource', { expiresAt: 'not-a-date' }).testimony;
  assert.equal(isReferenceExpired(validShape), true);
  const invalidShape = reference('resource', { expiresAt: 'x'.repeat(REFERENCE_LIMITS.expiresAt + 1) }).testimony;
  assert.equal(invalidShape.expiresAt, undefined);
  assert.deepEqual(invalidShape.rejectedFields, ['expiresAt']);
});

test('large invalid labels cannot change the bounded model-visible stub', () => {
  const { testimony } = reference('audio', {
    name: 'x'.repeat(1024 * 1024), mimeType: 'y'.repeat(1024 * 1024), sizeBytes: 1024,
  });
  assert.equal(testimony.name, undefined);
  assert.equal(testimony.mimeType, undefined);
  const stub = buildReferenceStub(testimony, 'server');
  assert.ok(stub.length < 150);
  assert.ok(stub.includes('claimed'));
  assert.ok(!stub.includes(testimony.uri));
});
