/**
 * Durable channel-label history (mcpl/channel-label-history append log).
 *
 * `resolveProseTarget()` resolves a label to a channel id only against the
 * live `channels` map, which is empty for anything the bot has disconnected
 * from or that hasn't re-registered since a restart. `appendLabelSighting()`
 * durably records "this channelId had this label" on every descriptor
 * observation, and `resolveProseTargetDurable()` falls back to that history
 * when the live path misses — the case that matters for browsing message
 * history on an old/quiet/disconnected channel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

const CHANNEL_LABEL_HISTORY_LOG_ID = 'mcpl/channel-label-history';

function makeRegistry(store?: unknown) {
  const serverRegistry = {
    getServer: (_id: string) => null,
  } as unknown as McplServerRegistry;
  return new ChannelRegistry(
    serverRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    store ? { store: store as never } : undefined,
  );
}

/** In-memory Chronicle-store stand-in, keyed by state id (unlike a single
 *  flat array) so the lifecycle log and the label-history log don't bleed
 *  into each other's getStateJson()/appendToStateJson() results. */
function memoryStore() {
  const registered = new Set<string>();
  const events = new Map<string, unknown[]>();
  const store = {
    registerState: (opts: { id: string }) => {
      if (registered.has(opts.id)) throw new Error('State already exists');
      registered.add(opts.id);
      if (!events.has(opts.id)) events.set(opts.id, []);
    },
    getStateJson: (id: string) => events.get(id) ?? null,
    appendToStateJson: (id: string, event: unknown) => {
      if (!events.has(id)) events.set(id, []);
      events.get(id)!.push(event);
    },
  };
  return { store, events };
}

function descriptor(id: string, label: string) {
  return { id, type: 'discord', label, direction: 'bidirectional' as const };
}

function dmDescriptor(
  id: string,
  label: string,
  opts: { recipientId?: string; recipientName?: string; channelType?: string } = {},
) {
  return {
    id,
    type: 'discord',
    label,
    direction: 'bidirectional' as const,
    metadata: {
      channelType: opts.channelType ?? 'dm',
      ...(opts.recipientId ? { recipientId: opts.recipientId } : {}),
      ...(opts.recipientName ? { recipientName: opts.recipientName } : {}),
    },
  };
}

test('a label sighting persists across a simulated restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-label-history-'));
  try {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const first = makeRegistry(store);
    await first.handleRegister('discord', {
      channels: [descriptor('discord:g1:c1', "#general (Antra's Guild)")],
    });

    // Fresh registry over the SAME store, like a real restart — its live
    // `channels` map starts empty (no handleRegister call this time), so
    // resolveProseTarget() alone cannot see this channel at all.
    const second = makeRegistry(store);
    const liveMiss = second.resolveProseTarget("#general (Antra's Guild)");
    assert.ok('error' in liveMiss, 'expected a live-path miss on a fresh registry');

    // resolveProseTargetDurable() falls back to replayed history and finds it.
    assert.deepEqual(
      second.resolveProseTargetDurable("#general (Antra's Guild)"),
      { channelId: 'discord:g1:c1', label: "#general (Antra's Guild)" },
    );

    // Name-segment match (bare name, parenthetical guild suffix omitted)
    // mirrors resolveProseTarget()'s own byName normalization.
    assert.deepEqual(
      second.resolveProseTargetDurable('#general'),
      { channelId: 'discord:g1:c1', label: "#general (Antra's Guild)" },
    );

    // Raw channelId also resolves, like resolveProseTarget()'s raw-id path.
    assert.deepEqual(
      second.resolveProseTargetDurable('discord:g1:c1'),
      { channelId: 'discord:g1:c1', label: "#general (Antra's Guild)" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repeated identical label sightings do not bloat the log', async () => {
  const { store, events } = memoryStore();
  const registry = makeRegistry(store);

  for (let i = 0; i < 3; i++) {
    await registry.handleRegister('discord', {
      channels: [descriptor('discord:g1:c1', '#general')],
    });
  }

  const log = events.get(CHANNEL_LABEL_HISTORY_LOG_ID) ?? [];
  assert.equal(log.length, 1, 'unchanged sightings must not append new records');
});

test('a new label sighted for a channel is the one that resolves after a restart', async () => {
  const { store } = memoryStore();
  const registry = makeRegistry(store);

  await registry.handleRegister('discord', { channels: [descriptor('discord:g1:c1', '#general')] });
  await registry.handleRegister('discord', { channels: [descriptor('discord:g1:c1', '#general-renamed')] });

  // Later sighting wins on replay.
  const second = makeRegistry(store);
  assert.deepEqual(second.resolveProseTargetDurable('#general-renamed'), {
    channelId: 'discord:g1:c1',
    label: '#general-renamed',
  });
});

test('resolveProseTargetDurable prefers the live path and only falls back to history on a live miss', async () => {
  const { store, events } = memoryStore();
  // Pre-seed history: a DIFFERENT (now-disconnected) channel historically
  // held the same label text that a currently-live channel holds now.
  events.set(CHANNEL_LABEL_HISTORY_LOG_ID, [
    { channelId: 'discord:g1:ghost', label: 'shared-label', ts: 1 },
  ]);

  const registry = makeRegistry(store);
  await registry.handleRegister('discord', {
    channels: [descriptor('discord:g1:live', 'shared-label')],
  });

  // Live path resolves uniquely against the live channel — must win over
  // the (stale) history entry for the ghost channel.
  const live = registry.resolveProseTarget('shared-label');
  assert.deepEqual(live, { channelId: 'discord:g1:live', serverId: 'discord', label: 'shared-label' });
  assert.deepEqual(registry.resolveProseTargetDurable('shared-label'), live);
});

test('a channel with no history at all still returns the original resolveProseTarget error/candidates unchanged', async () => {
  const registry = makeRegistry(); // no chronicle store at all — appendLabelSighting must no-op safely
  await registry.handleRegister('discord', { channels: [descriptor('discord:g1:c1', '#other')] });

  const live = registry.resolveProseTarget('#nonexistent');
  assert.ok('error' in live);

  const durable = registry.resolveProseTargetDurable('#nonexistent');
  assert.deepEqual(durable, live);

  // Also true for an entirely empty registry (no channels ever seen).
  const empty = makeRegistry();
  const liveEmpty = empty.resolveProseTarget('#anything');
  assert.deepEqual(empty.resolveProseTargetDurable('#anything'), liveEmpty);
});

test('ensureChannelRegistered and handleChanged updates also feed label history', async () => {
  const { store } = memoryStore();
  const registry = makeRegistry(store);

  // ensureChannelRegistered: lazy registration with NO label at all (e.g. a
  // DM push missing both channelName and an author name). This must NOT be
  // durably recorded as if the bare channelId were a real label (finding
  // #3) — only the in-memory descriptor gets the placeholder, for live
  // routing purposes.
  registry.ensureChannelRegistered('discord', 'discord:dm:1', undefined);
  // ...then a later message reveals a real label — the backfill path.
  registry.ensureChannelRegistered('discord', 'discord:dm:1', 'DM: Antra');

  // handleChanged: an "added" channel, then an "updated" descriptor for it.
  await registry.handleChanged('discord', {
    added: [descriptor('discord:g1:c2', '#dev')],
  });
  await registry.handleChanged('discord', {
    updated: [descriptor('discord:g1:c2', '#dev-renamed')],
  });

  const restarted = makeRegistry(store);
  assert.deepEqual(restarted.resolveProseTargetDurable('DM: Antra'), {
    channelId: 'discord:dm:1',
    label: 'DM: Antra',
  });
  assert.deepEqual(restarted.resolveProseTargetDurable('#dev-renamed'), {
    channelId: 'discord:g1:c2',
    label: '#dev-renamed',
  });
});

test('a label-less lazy re-registration after restart does not clobber an already-durable real label (finding #3)', async () => {
  const { store } = memoryStore();
  const first = makeRegistry(store);
  // Boot 1: a real label lands on file (e.g. a DM push that DID carry a
  // display name).
  first.ensureChannelRegistered('discord', 'discord:dm:3', 'DM: Antra');

  // Simulated restart: fresh registry, live `channels` map starts empty —
  // this is exactly the state that makes the NEXT event take the
  // fresh-registration branch of ensureChannelRegistered again, even
  // though the channel already has a real label on file.
  const second = makeRegistry(store);
  assert.deepEqual(second.resolveProseTargetDurable('DM: Antra'), {
    channelId: 'discord:dm:3',
    label: 'DM: Antra',
  });

  // A label-less push arrives post-restart. This used to durably overwrite
  // the real label with the bare-id placeholder, and the dedup guard would
  // then append a SECOND record the moment a later event restored the real
  // label — degrading the log forever on every boot that hit this path.
  second.ensureChannelRegistered('discord', 'discord:dm:3', undefined);

  assert.deepEqual(second.resolveProseTargetDurable('DM: Antra'), {
    channelId: 'discord:dm:3',
    label: 'DM: Antra',
  });
});

test('a label-less descriptor from handleRegister does not crash and does not poison labelHistory (finding #2)', async () => {
  const { store } = memoryStore();
  const registry = makeRegistry(store);

  // ChannelDescriptor.label: string is a compile-time-only assertion over
  // untrusted wire data — handleRegister only runtime-validates `id`. Build
  // a descriptor with a missing label the way a misbehaving MCPL server
  // could actually send one.
  const labelless = { id: 'discord:g1:broken', type: 'discord', direction: 'bidirectional' as const };
  await registry.handleRegister('discord', { channels: [labelless as unknown as ReturnType<typeof descriptor>] });

  // A subsequent, UNRELATED resolution call must still work — before the
  // fix, an undefined label silently written into labelHistory threw a
  // TypeError inside normalizeChannelLabel's `.replace()` on every future
  // resolveProseTargetDurable call with a channelId, not just this one
  // (this is what made it crash all four HistoryModule tools process-wide).
  await registry.handleRegister('discord', { channels: [descriptor('discord:g1:c2', '#general')] });
  assert.deepEqual(registry.resolveProseTargetDurable('#general'), {
    channelId: 'discord:g1:c2',
    serverId: 'discord',
    label: '#general',
  });
  assert.doesNotThrow(() => registry.resolveProseTargetDurable('#anything-else'));
});

test('a channel renamed A -> B -> A is still resolvable by a name from BEFORE the most recent rename (finding #9)', async () => {
  const { store } = memoryStore();
  const registry = makeRegistry(store);

  await registry.handleRegister('discord', { channels: [descriptor('discord:g1:c1', '#alpha')] });
  await registry.handleChanged('discord', { updated: [descriptor('discord:g1:c1', '#beta')] });
  await registry.handleChanged('discord', { updated: [descriptor('discord:g1:c1', '#alpha')] });

  // Live-path check: '#alpha' is current again, so it resolves live.
  assert.deepEqual(registry.resolveProseTarget('#alpha'), { channelId: 'discord:g1:c1', serverId: 'discord', label: '#alpha' });

  // The interesting case: '#beta' is a name from BEFORE the most recent
  // rename (A -> B -> A), not the current OR immediately-previous label —
  // labelHistory alone (latest-only) could never answer this; it needs
  // allLabelsSeen's full per-channel history.
  const restarted = makeRegistry(store);
  assert.deepEqual(restarted.resolveProseTargetDurable('#beta'), {
    channelId: 'discord:g1:c1',
    label: '#alpha', // reported label is always the CURRENT/latest one
  });
});

test('a genuine label collision across two different channels reports ambiguity, not a silent pick (finding #9)', async () => {
  const { store } = memoryStore();
  const registry = makeRegistry(store);

  // Two DIFFERENT channels each historically held the label '#shared' —
  // channel a's label has since moved on, channel b's has not.
  await registry.handleRegister('discord', { channels: [descriptor('discord:g1:a', '#shared')] });
  await registry.handleChanged('discord', { updated: [descriptor('discord:g1:a', '#a-current')] });
  await registry.handleRegister('discord', { channels: [descriptor('discord:g1:b', '#shared')] });

  // A fresh (post-restart) registry — live path can't shortcut this to a
  // unique live match, so resolution goes through the historical-label
  // scan that must detect the collision across the two distinct channelIds.
  const restarted = makeRegistry(store);
  const result = restarted.resolveProseTargetDurable('#shared');
  assert.ok('error' in result, `expected an ambiguity error, got ${JSON.stringify(result)}`);
});

test("durable DM resolution keeps the live resolver's recipientName-over-label precedence, not a flat equal-priority pool (finding: false ambiguity across two channels)", async () => {
  // Two fully-recorded DMs whose identity data happens to cross-reference:
  // A's actual username is 'alpha_user', but its stale/leftover display
  // label is 'DM: beta_user'; B's actual username IS 'beta_user', with an
  // unrelated display label. Live, '@beta_user' resolves uniquely to B —
  // the live resolver prefers recipientName outright and never considers
  // A's label a candidate at all. A flat "equal priority" pool of
  // recipientName+label candidates made this falsely ambiguous after a
  // restart (both A's label and B's recipientName satisfied the same
  // query), even though the persisted recipientName data was sufficient on
  // its own to resolve it uniquely, exactly like the live path does.
  const { store } = memoryStore();
  const registry = makeRegistry(store);

  await registry.handleRegister('discord', {
    channels: [
      dmDescriptor('discord:dm:A', 'DM: beta_user', { recipientId: 'a', recipientName: 'alpha_user' }),
      dmDescriptor('discord:dm:B', 'DM: unrelated-label', { recipientId: 'b', recipientName: 'beta_user' }),
    ],
  });

  const restarted = makeRegistry(store);
  const resolved = restarted.resolveProseTargetDurable('@beta_user');
  assert.ok('channelId' in resolved, `expected a unique resolution, got ${JSON.stringify(resolved)}`);
  assert.equal((resolved as { channelId: string }).channelId, 'discord:dm:B');

  // The label-derived fallback for a channel WITHOUT a competing
  // recipientName match still works (recipientName tier only blocks the
  // label tier when it actually resolves the query, not unconditionally) —
  // '@unrelated-label' isn't anyone's recipientName, so it should still
  // resolve to B via B's own label.
  const byLabel = restarted.resolveProseTargetDurable('@unrelated-label');
  assert.ok('channelId' in byLabel, `expected B's own label to still resolve it, got ${JSON.stringify(byLabel)}`);
  assert.equal((byLabel as { channelId: string }).channelId, 'discord:dm:B');
});

test('a DM registered live resolves after a restart via @name, not just the literal stored label (DM-addressing regression)', async () => {
  const { store } = memoryStore();
  const first = makeRegistry(store);
  await first.handleRegister('discord', {
    channels: [dmDescriptor('discord:dm:antra', 'DM: antra', { recipientId: '123456789' })],
  });

  // Live check: '@antra' already resolves live, before any restart —
  // establishes this is real DM-shaped addressing, not a coincidence.
  assert.deepEqual(first.resolveProseTarget('@antra'), {
    channelId: 'discord:dm:antra',
    serverId: 'discord',
    label: 'DM: antra',
  });

  // Simulated restart: fresh registry, live `channels` map starts empty —
  // resolveProseTarget() alone can no longer see this DM at all.
  const restarted = makeRegistry(store);
  const liveMiss = restarted.resolveProseTarget('@antra');
  assert.ok('error' in liveMiss, 'expected a live-path miss on a fresh registry');

  // The durable fallback must still resolve '@antra' — normalizeChannelLabel
  // alone (its previous only tool) has no '@'-handling at all, so this used
  // to fail silently before falling through to resolveProseTarget's
  // original (post-#8-fix: now HARD-thrown from HistoryModule) error.
  assert.deepEqual(restarted.resolveProseTargetDurable('@antra'), {
    channelId: 'discord:dm:antra',
    label: 'DM: antra',
  });
});

test('a DM registered live resolves after a restart via the <@id> mention form (recipientId persisted durably)', async () => {
  const { store } = memoryStore();
  const first = makeRegistry(store);
  await first.handleRegister('discord', {
    channels: [dmDescriptor('discord:dm:antra', 'DM: antra', { recipientId: '123456789' })],
  });

  const restarted = makeRegistry(store);
  assert.ok('error' in restarted.resolveProseTarget('<@123456789>'), 'expected a live-path miss on a fresh registry');
  assert.deepEqual(restarted.resolveProseTargetDurable('<@123456789>'), {
    channelId: 'discord:dm:antra',
    label: 'DM: antra',
  });
});

test('a bare (non-DM-metadata) channel whose id merely contains ":dm:" is still DM-matched by @name after a restart', async () => {
  // Exercises the id-shape half of isDmChannelId() independently of the
  // 'DM: ' label-prefix half — a descriptor with no metadata.channelType
  // at all, the way ensureChannelRegistered's lazy DM path (no server
  // metadata yet) actually looks.
  const { store } = memoryStore();
  const first = makeRegistry(store);
  first.ensureChannelRegistered('discord', 'discord:dm:5', 'DM: ghost');

  const restarted = makeRegistry(store);
  assert.deepEqual(restarted.resolveProseTargetDurable('@ghost'), {
    channelId: 'discord:dm:5',
    label: 'DM: ghost',
  });
});

test('a DM whose live username differs from its display label resolves by USERNAME after a restart (finding: recipientName persistence)', async () => {
  // id `discord:dm:42`, label "DM: Tess" — but the actual live resolver
  // prefers metadata.recipientName ("antra_tessera") over the label for
  // DM name-matching, so '@antra_tessera' must resolve live, and the
  // durable fallback (which previously only had the label "Tess" to
  // search) needs recipientName persisted to answer it too.
  const { store } = memoryStore();
  const first = makeRegistry(store);
  await first.handleRegister('discord', {
    channels: [dmDescriptor('discord:dm:42', 'DM: Tess', { recipientName: 'antra_tessera' })],
  });

  // Live check: the live resolver already prefers recipientName over the
  // label for DM matching — establishes this is real behavior to mirror,
  // not an invented requirement.
  assert.deepEqual(first.resolveProseTarget('@antra_tessera'), {
    channelId: 'discord:dm:42',
    serverId: 'discord',
    label: 'DM: Tess',
  });

  const restarted = makeRegistry(store);
  const liveMiss = restarted.resolveProseTarget('@antra_tessera');
  assert.ok('error' in liveMiss, 'expected a live-path miss on a fresh registry');

  // Durable fallback must resolve it by USERNAME, not just by the label text.
  assert.deepEqual(restarted.resolveProseTargetDurable('@antra_tessera'), {
    channelId: 'discord:dm:42',
    label: 'DM: Tess',
  });
  // The label-derived name ("tess") must still work too — recipientName is
  // additive, not a replacement for the label fallback.
  assert.deepEqual(restarted.resolveProseTargetDurable('@tess'), {
    channelId: 'discord:dm:42',
    label: 'DM: Tess',
  });
});

test('a DM classified only via metadata.channelType (non-conventional id/label) is still recognized and resolvable after a restart (finding: isDm persistence)', async () => {
  // id `private-room-42` (no ":dm:"), label "Tess" (no "DM: " prefix) — the
  // ONLY signal this is a DM at all is metadata.channelType === 'dm',
  // which the live resolver checks FIRST. Without persisting that
  // classification, the durable fallback's DM classifier has no way to
  // even consider this channel a DM once disconnected, let alone resolve
  // a <@id> mention against it.
  const { store } = memoryStore();
  const first = makeRegistry(store);
  await first.handleRegister('discord', {
    channels: [dmDescriptor('private-room-42', 'Tess', { recipientId: '42', channelType: 'dm' })],
  });

  // Live check: classified as a DM live via metadata alone.
  assert.deepEqual(first.resolveProseTarget('<@42>'), {
    channelId: 'private-room-42',
    serverId: 'discord',
    label: 'Tess',
  });

  const restarted = makeRegistry(store);
  const liveMiss = restarted.resolveProseTarget('<@42>');
  assert.ok('error' in liveMiss, 'expected a live-path miss on a fresh registry');

  // Durable fallback must still recognize it as a DM (via the persisted
  // isDm classification, not id/label shape) and resolve the mention.
  assert.deepEqual(restarted.resolveProseTargetDurable('<@42>'), {
    channelId: 'private-room-42',
    label: 'Tess',
  });
  assert.deepEqual(restarted.resolveProseTargetDurable('@tess'), {
    channelId: 'private-room-42',
    label: 'Tess',
  });
});
