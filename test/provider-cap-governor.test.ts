/**
 * ProviderCapGovernor: durable park state. The durability discipline is the
 * same one the cost lane was held to — unique temp + fsync + rename + parent
 * fsync, durable-through advanced only after a FULLY successful write,
 * injected failures preserve the prior durable state and unlink orphan temps,
 * corrupt state is preserved (renamed aside) and surfaced, never silently
 * reset. Plus the park-specific mechanics: deterministic jitter, backoff on
 * past/stale resets, the single canary permit, and metadata-only content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync,
  fsyncSync as realFsyncSync, unlinkSync as realUnlinkSync, openSync as realOpenSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProviderCapGovernor,
  defaultProviderCapStatePath,
  type ProviderCapClassification,
} from '../src/provider-cap.js';

const CLS: ProviderCapClassification = {
  provider: 'anthropic',
  scope: 'workspace',
  errorClass: 'usage_cap',
  resetAt: Date.UTC(2026, 8, 1),
};

const T0 = Date.UTC(2026, 7, 11, 12, 0, 0); // "now": 2026-08-11T12:00Z

function makeGovernor(opts?: { jitterMaxMs?: number; fsOps?: Record<string, unknown> }) {
  const dir = mkdtempSync(join(tmpdir(), 'provider-cap-'));
  const statePath = join(dir, 'provider-cap.json');
  const gov = new ProviderCapGovernor({
    statePath,
    jitterMaxMs: opts?.jitterMaxMs ?? 0,
    fsOps: opts?.fsOps as never,
  });
  return { gov, dir, statePath };
}

test('park entry persists a metadata-only record and survives a reload', () => {
  const { gov, statePath } = makeGovernor();
  const { entered, record } = gov.recordCapError('cairn', CLS, T0);
  assert.equal(entered, true);
  assert.equal(record.attemptCount, 1);
  assert.equal(record.eligibleAt, CLS.resetAt, 'future reset + zero jitter = reset instant');

  const raw = readFileSync(statePath, 'utf8');
  // Metadata only: the provider's sentence (or any prose) must never be here.
  assert.ok(!/usage limits|regain access/i.test(raw), 'no provider error text on disk');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.parks), ['cairn']);
  assert.equal(parsed.parks.cairn.resetAt, CLS.resetAt);

  const gov2 = new ProviderCapGovernor({ statePath, jitterMaxMs: 0 });
  gov2.load(T0 + 1000);
  assert.equal(gov2.isParked('cairn'), true, 'restart keeps the park');
  assert.equal(gov2.status('cairn')!.attemptCount, 1);
  assert.equal(gov2.loadError, null);
});

test('suppression, canary window and the single permit', () => {
  const { gov } = makeGovernor();
  gov.recordCapError('cairn', CLS, T0);

  assert.equal(gov.shouldSuppress('cairn', T0 + 1), true, 'suppressed before reset');
  assert.equal(gov.tryAcquireCanary('cairn', T0 + 1), false, 'no canary before the window');

  const after = CLS.resetAt + 1;
  assert.equal(gov.shouldSuppress('cairn', after), false, 'window open');
  assert.equal(gov.tryAcquireCanary('cairn', after), true, 'first claim wins');
  assert.equal(gov.tryAcquireCanary('cairn', after), false, 'permit is single');
  assert.equal(gov.shouldSuppress('cairn', after), true, 'suppressed while the canary flies');

  gov.canaryAborted('cairn');
  assert.equal(gov.tryAcquireCanary('cairn', after), true, 'aborted canary frees the permit');
});

test('failed canary: attempt++, changed reset adopted, backoff on past resets', () => {
  const { gov } = makeGovernor();
  gov.recordCapError('cairn', CLS, T0);

  // Canary fails and the provider now states a LATER reset — adopt it.
  const later = { ...CLS, resetAt: Date.UTC(2026, 9, 1) };
  const r2 = gov.recordCapError('cairn', later, CLS.resetAt + 5000);
  assert.equal(r2.entered, false);
  assert.equal(r2.record.attemptCount, 2);
  assert.equal(r2.record.resetAt, later.resetAt);
  assert.equal(r2.record.eligibleAt, later.resetAt, 'future reset: wait for it');

  // Provider keeps stating an instant that is already past (skew / stale):
  // exponential backoff from the attempt count, never a hot loop.
  const past = { ...CLS, resetAt: T0 - 1000 };
  const now3 = later.resetAt + 10;
  const r3 = gov.recordCapError('cairn', past, now3);
  assert.equal(r3.record.attemptCount, 3);
  assert.equal(r3.record.eligibleAt, now3 + 60_000 * 2 ** 2, 'attempt 3 → 4 min backoff');
});

test('deterministic jitter: same episode → same instant, different agents spread', () => {
  const { gov: a } = makeGovernor({ jitterMaxMs: 300_000 });
  const { gov: b } = makeGovernor({ jitterMaxMs: 300_000 });
  const ra = a.recordCapError('cairn', CLS, T0).record;
  const rb = b.recordCapError('cairn', CLS, T0).record;
  assert.equal(ra.eligibleAt, rb.eligibleAt, 'restart-stable jitter (no RNG)');
  assert.ok(ra.eligibleAt >= CLS.resetAt && ra.eligibleAt < CLS.resetAt + 300_000);
  const rc = b.recordCapError('mythos', CLS, T0).record;
  assert.notEqual(rc.eligibleAt, rb.eligibleAt, 'agents do not stampede the same second');
});

test('a provider/model change while parked opens the canary window at once', () => {
  const { gov } = makeGovernor();
  gov.recordCapError('cairn', CLS, T0, 'claude-opus-4-8');
  assert.equal(gov.status('cairn')!.model, 'claude-opus-4-8');
  assert.equal(gov.noteModelChanged('cairn', 'claude-opus-4-8', T0 + 1), false, 'same model: nothing');
  assert.equal(gov.noteModelChanged('cairn', undefined, T0 + 1), false, 'unknown model: fail closed');
  assert.equal(gov.shouldSuppress('cairn', T0 + 2), true, 'still suppressed');

  assert.equal(gov.noteModelChanged('cairn', 'bedrock-opus-4-8', T0 + 5), true, 'change detected once');
  assert.equal(gov.shouldSuppress('cairn', T0 + 6), false, 'canary immediately eligible');
  assert.equal(gov.noteModelChanged('cairn', 'bedrock-opus-4-8', T0 + 7), false, 'not re-triggered');
  // A park with NO recorded model (pre-upgrade record) never auto-releases.
  const { gov: g2 } = makeGovernor();
  g2.recordCapError('cairn', CLS, T0);
  assert.equal(g2.noteModelChanged('cairn', 'anything', T0 + 1), false);
});

test('release records lastRelease and clears the park durably', () => {
  const { gov, statePath } = makeGovernor();
  gov.recordCapError('cairn', CLS, T0);
  gov.noteHeldWakes('cairn', 7, T0 + 1);
  const rec = gov.noteSuccess('cairn', CLS.resetAt + 60_000, 'canary');
  assert.ok(rec);
  assert.equal(rec!.heldWakes, 7);
  assert.equal(gov.isParked('cairn'), false);

  const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(parsed.parks, {}, 'park removed on disk');
  assert.equal(parsed.lastRelease.agent, 'cairn');
  assert.equal(parsed.lastRelease.releasedBy, 'canary');
  assert.equal(parsed.lastRelease.heldWakes, 7);

  // Operator release path carries attribution.
  gov.recordCapError('cairn', CLS, T0);
  const cleared = gov.operatorClear('cairn', 'antra', T0 + 5000);
  assert.ok(cleared);
  const parsed2 = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(parsed2.lastRelease.releasedBy, 'operator:antra');
});

test('bug-14 discipline: failed persist keeps prior durable state, unlinks the orphan temp', () => {
  let failFsync = false;
  let unlinked: string[] = [];
  const { gov, statePath, dir } = makeGovernor({
    fsOps: {
      fsyncSync: (fd: number) => {
        if (failFsync) throw new Error('injected fsync failure');
        return realFsyncSync(fd);
      },
      unlinkSync: (p: string) => {
        unlinked.push(p);
        return realUnlinkSync(p);
      },
    },
  });

  gov.recordCapError('cairn', CLS, T0);
  const durableAfterEntry = gov.durableThrough;
  assert.equal(durableAfterEntry, T0, 'entry persisted');

  failFsync = true;
  unlinked = [];
  gov.recordCapError('cairn', CLS, T0 + 10_000); // canary failure → persist attempt fails
  assert.equal(gov.persistError !== null, true, 'failure is visible');
  assert.equal(gov.durableThrough, durableAfterEntry, 'durable-through NOT advanced');
  assert.equal(unlinked.length, 1, 'orphan temp unlinked');
  assert.ok(unlinked[0].includes('.tmp.'), 'the unlinked file was the temp');
  assert.equal(gov.status('cairn')!.attemptCount, 2, 'in-memory state kept');
  const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(onDisk.parks.cairn.attemptCount, 1, 'disk still holds last good state');
  assert.equal(readdirSync(dir).filter((f) => f.includes('.tmp.')).length, 0, 'no temp litter');

  failFsync = false;
  gov.recordCapError('cairn', CLS, T0 + 20_000);
  assert.equal(gov.persistError, null, 'recovery clears the visible error');
  assert.equal(gov.durableThrough, T0 + 20_000);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).parks.cairn.attemptCount, 3);
});

test('BLOCKER 1: default state path is residence-scoped (store-anchored), and two stores never alias', () => {
  const a = defaultProviderCapStatePath('/home/u/mythos-cm/data/store');
  const b = defaultProviderCapStatePath('/home/u/cairn/data/store');
  assert.equal(a, '/home/u/mythos-cm/data/store/provider-cap.json');
  assert.notEqual(a, b, 'residences cannot share a park file through a common cwd');
});

test('BLOCKER 4: the corrupt-state preservation rename is fsynced like any other durability claim', () => {
  const dirFsyncs: number[] = [];
  let opened: string[] = [];
  const { gov, statePath } = makeGovernor({
    fsOps: {
      openSync: ((p: string, flags: string, mode?: number) => {
        opened.push(p);
        return realOpenSync(p, flags as never, mode);
      }) as never,
      fsyncSync: (fd: number) => { dirFsyncs.push(fd); return realFsyncSync(fd); },
    },
  });
  writeFileSync(statePath, '{ corrupt', 'utf8');
  opened = []; dirFsyncs.length = 0;
  gov.load(T0);
  assert.ok(gov.loadError, 'visible error');
  // After the move-aside rename, the PARENT DIRECTORY was opened and fsynced.
  const dir = statePath.slice(0, statePath.lastIndexOf('/'));
  assert.ok(opened.includes(dir), 'parent dir opened for fsync after preservation rename');
  assert.ok(dirFsyncs.length >= 1, 'fsync issued');
  const aside = readdirSync(dir).find((f) => f.includes('.corrupt-'));
  assert.ok(aside, 'evidence preserved');
});

test('corrupt state: preserved aside, loudly surfaced, fails toward UNPARKED', () => {
  const { gov, statePath, dir } = makeGovernor();
  writeFileSync(statePath, '{ definitely not json', 'utf8');
  gov.load(T0);
  assert.ok(gov.loadError, 'corrupt load is a visible error');
  assert.equal(gov.isParked('cairn'), false, 'fails toward unparked (one $0 call re-parks)');
  assert.equal(existsSync(statePath), false, 'corrupt bytes moved, not overwritten');
  const aside = readdirSync(dir).find((f) => f.includes('.corrupt-'));
  assert.ok(aside, 'corrupt bytes preserved aside');
  assert.equal(readFileSync(join(dir, aside!), 'utf8'), '{ definitely not json');

  // Fresh persistence works after the move-aside.
  gov.recordCapError('cairn', CLS, T0 + 1000);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).parks.cairn.attemptCount, 1);
});

test('a valid file with a malformed record is treated as corrupt, not partially trusted', () => {
  const { gov, statePath } = makeGovernor();
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    updatedAt: T0,
    parks: { cairn: { agent: 'cairn', resetAt: 'tomorrow' } },
  }), 'utf8');
  gov.load(T0);
  assert.ok(gov.loadError);
  assert.equal(gov.isParked('cairn'), false);
});
