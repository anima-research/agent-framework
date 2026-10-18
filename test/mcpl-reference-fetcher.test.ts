/**
 * RFC-005 fetcher vectors (§11: 4, 5, 10, 11, 12 + origin/expiry/budget)
 * against a live local HTTP server.
 *
 * Run: node --import tsx --test test/mcpl-reference-fetcher.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ReferenceFetcher, normalizedOrigin } from '../src/mcpl/reference-fetcher.js';
import { ReferenceRegistry, UNBOUND_REASON, classifyBlock, referenceExpiry, referenceRegistry } from '../src/mcpl/references.js';
import { AgentFramework } from '../src/framework.js';

const PAYLOAD = Buffer.from('RIFF-not-really-a-wav-'.repeat(100));
const DIGEST = 'sha256:' + createHash('sha256').update(PAYLOAD).digest('base64url');

let lastAuth: string | null = null;
/** Requests served, by path and query. */
const hits = new Map<string, number>();
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  lastAuth = req.headers.authorization ?? null;
  hits.set(req.url ?? '/', (hits.get(req.url ?? '/') ?? 0) + 1);
  if (url.pathname === '/ok') {
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(PAYLOAD);
  } else if (url.pathname === '/redirect') {
    res.writeHead(302, { location: 'http://evil.example/x' }); res.end();
  } else if (url.pathname === '/octet') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(PAYLOAD);
  } else if (url.pathname === '/untyped') {
    // no content-type header, and bytes no sniffer recognizes
    res.writeHead(200); res.end(Buffer.from('plain bytes, nothing to sniff'));
  } else if (url.pathname === '/octet-untyped') {
    // a header type with no extension of its own, over bytes no sniffer recognizes
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from('plain bytes, nothing to sniff'));
  } else if (url.pathname === '/c1-only-typed') {
    // a header type that is nothing but a C1 control, over bytes no sniffer recognizes
    res.writeHead(200, { 'content-type': '\u0085' }); res.end(Buffer.from('plain bytes, nothing to sniff'));
  } else if (url.pathname === '/c1-typed') {
    // a header type carrying a C1 control (sent as the Latin-1 byte 0x85),
    // over bytes no sniffer recognizes
    res.writeHead(200, { 'content-type': 'text/pl\u0085ain; charset=utf-8' }); res.end(Buffer.from('plain bytes, nothing to sniff'));
  } else if (url.pathname === '/drip') {
    // sends ?first bytes at once and ?rest more after ?wait ms, so a fetch
    // can be stopped partway, with what arrived before it known
    const first = Number(url.searchParams.get('first') ?? 1000);
    const rest = Number(url.searchParams.get('rest') ?? 1000);
    const timer = setTimeout(() => res.end(Buffer.alloc(rest, 9)), Number(url.searchParams.get('wait') ?? 50));
    res.on('close', () => clearTimeout(timer));
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(Buffer.alloc(first, 9));
  } else if (url.pathname === '/liar') {
    // claims small in testimony, streams big (vector 10)
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(200_000, 7));
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const ORIGIN = `http://127.0.0.1:${port}`;

const saved: Array<{ name: string; bytes: number; mime: string }> = [];
function makeFetcher(bindings: Record<string, { url: string; token?: string; autofetch?: { maxBytes?: number; maxTotalBytes?: number } }>) {
  return new ReferenceFetcher(
    (id) => bindings[id],
    async (name, data, mime) => { saved.push({ name, bytes: data.length, mime }); return `scratch/refs/${name}`; },
  );
}

function makeRecord(reg: ReferenceRegistry, uri: string, extra: Record<string, unknown> = {}, serverId: string | undefined = 'srv') {
  const c = classifyBlock({ type: 'resource', uri, ...extra });
  assert.equal(c.kind, 'reference');
  return reg.register((c as Extract<ReturnType<typeof classifyBlock>, { kind: 'reference' }>).testimony, serverId);
}

test('happy path: origin-bound fetch, bearer auth applied host-side, digest verified', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: `ws://127.0.0.1:${port}`, token: 'sekrit' } });
  const rec = makeRecord(reg, `${ORIGIN}/ok`, { sizeBytes: PAYLOAD.length, digest: DIGEST, mimeType: 'audio/wav', disposition: 'never' });
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.bytes, PAYLOAD.length);
  assert.equal(out.digestVerified, true);
  assert.equal(lastAuth, 'Bearer sekrit', 'connection credential must ride as a header, host-side');
  assert.equal(rec.fetchedPath, `scratch/refs/${rec.refId}.wav`, 'storage name is host-generated from the record');
  // idempotent: second fetch returns the cached materialization
  const again = await f.fetch(rec);
  assert.equal(again.path, out.path);
});

test('vector 5: digest mismatch is never presented', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/ok`, { digest: 'sha256:' + 'B'.repeat(43) });
  const out = await f.fetch(rec);
  assert.equal(out.ok, false);
  assert.match(out.error!, /digest mismatch/);
  assert.equal(rec.fetchedPath, undefined);
});

test('vector 10: stream past the ceiling aborts on actual bytes', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/liar`, { sizeBytes: 100 });
  const out = await f.fetch(rec, { maxBytes: 50_000 });
  assert.equal(out.ok, false);
  assert.match(out.error!, /exceeded ceiling/);
});

test('vector 4: a claim already over the ceiling refuses without dialing', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/ok`, { sizeBytes: 10_000_000 });
  const out = await f.fetch(rec, { maxBytes: 1000 });
  assert.equal(out.ok, false);
  assert.match(out.error!, /exceeds fetch ceiling/);
});

test('vector 11: non-http(s) scheme refused', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, 'file:///etc/passwd');
  const out = await f.fetch(rec);
  assert.equal(out.ok, false);
  assert.match(out.error!, /scheme not allowed|third-party/);
});

test('vector 12: redirects refused, no traversal', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/redirect`);
  const out = await f.fetch(rec);
  assert.equal(out.ok, false);
  assert.match(out.error!, /redirect refused/);
});

test('third-party origin refused (v1 policy: dialed origin only)', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, 'https://cdn.example.com/thing.wav');
  const out = await f.fetch(rec);
  assert.equal(out.ok, false);
  assert.match(out.error!, /third-party origin/);
});

test('vector 16: expired (and unparseable-expiry) references refuse locally, and take no eager slot', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  for (const [expiresAt, why] of [['2001-01-01T00:00:00Z', /has passed/], ['not-a-date', /does not parse/]] as const) {
    // Small, sized and from the dialed origin: only its expiry keeps it from the eager default.
    const rec = makeRecord(reg, `${ORIGIN}/ok?e=${expiresAt}`, { expiresAt, sizeBytes: PAYLOAD.length });
    assert.equal(f.isEagerEligible(rec), false, `${expiresAt}: the eager default would only be refused`);
    const out = await f.fetch(rec);
    assert.equal(out.ok, false);
    assert.match(out.error!, /expired/);
    assert.match(out.error!, why);
  }
});

test('vector 16: an expiry rejected as a field refuses locally, with nothing dialed, and takes no eager slot', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const before = saved.length;
  lastAuth = 'untouched';
  for (const [label, expiresAt] of [['overlong', 'x'.repeat(65)], ['numeric', 1_900_000_000], ['null', null]] as const) {
    const rec = makeRecord(reg, `${ORIGIN}/ok?e=${label}`, { expiresAt, sizeBytes: PAYLOAD.length });
    assert.deepEqual(rec.testimony.rejectedFields, ['expiresAt'], label);
    assert.equal(f.isEagerEligible(rec), false, `${label}: the eager default would only be refused`);
    const out = await f.fetch(rec);
    assert.equal(out.ok, false, label);
    assert.match(out.error!, /rejected as a field/, label);
  }
  assert.equal(saved.length, before, 'nothing saved');
  assert.equal(lastAuth, 'untouched', 'the origin was never dialed');
});

test('a reference whose expiry is still ahead is fetched', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/ok?e=future`, { expiresAt: '2999-01-01T00:00:00Z', sizeBytes: PAYLOAD.length });
  assert.equal(f.isEagerEligible(rec), true);
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
});

test('a claimed type that neither the bytes nor a header override reaches the result without controls', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/untyped`, { mimeType: 'text/\u202Eplain\u061C' });
  assert.equal(rec.testimony.mimeType, 'text/\u202Eplain\u061C', 'testimony keeps what the server said');
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'text/plain', 'fetch_reference shows it as a label is shown');
  assert.equal(saved.at(-1)!.mime, 'text/plain');
});

test('a header type that sanitizes to nothing counts as absent, so the claimed type names the result', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/c1-only-typed`, { mimeType: 'text/plain' });
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'text/plain');
  assert.equal(saved.at(-1)!.mime, 'text/plain', 'the saved type');
  assert.equal(rec.verifiedMimeType, 'text/plain', "the record's verified type");
  assert.equal(rec.fetchedPath, `scratch/refs/${rec.refId}.txt`);
});

test('a claimed type that sanitizes to nothing counts as absent: octet-stream, saved as .bin', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  // Bidi controls between spaces: nothing is left once they're stripped and the ends trimmed.
  const rec = makeRecord(reg, `${ORIGIN}/untyped?claim=empty`, { mimeType: ' \u202E \u061C ' });
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'application/octet-stream');
  assert.equal(saved.at(-1)!.mime, 'application/octet-stream');
  assert.equal(rec.fetchedPath, `scratch/refs/${rec.refId}.bin`);
});

test('the response header type is shown as a label is shown, wherever it names the saved type', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/c1-typed`);
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'text/plain', "fetch_reference's mime_type");
  assert.equal(saved.at(-1)!.mime, 'text/plain', 'the saved type');
  assert.equal(rec.verifiedMimeType, 'text/plain', "the record's verified type, which a later fetch serves");
  assert.equal(rec.fetchedPath, `scratch/refs/${rec.refId}.txt`, 'its extension comes from the label');
});

test("where the bytes and header name no extension, the claimed type names it as its label reads", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/octet-untyped`, { mimeType: 'text/\u202Eplain' });
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'application/octet-stream', 'the header names the type');
  assert.equal(rec.fetchedPath, `scratch/refs/${rec.refId}.txt`);
});

test("a server's type naming an Object.prototype member saves as .bin, not as inherited text", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/untyped?claim=constructor`, { mimeType: 'constructor' });
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
  assert.equal(rec.fetchedPath, `scratch/refs/${rec.refId}.bin`);
});

test('a copy saved earlier is still served once its expiry has passed or reads as rejected', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const readings = {
    passed: { expiresAt: '2001-01-01T00:00:00Z' },
    rejected: { expiresAt: undefined, rejectedFields: ['expiresAt'] },
  };
  for (const [reading, testimony] of Object.entries(readings)) {
    const rec = makeRecord(reg, `${ORIGIN}/ok?saved=${reading}`, { expiresAt: '2999-01-01T00:00:00Z' });
    const first = await f.fetch(rec);
    assert.equal(first.ok, true, first.error);
    // Its expiry now reads as one the fetcher refuses: the clock passed it,
    // or the record's testimony changed while its fetch was in flight.
    Object.assign(rec.testimony, testimony);
    assert.equal(referenceExpiry(rec.testimony), reading);
    lastAuth = 'untouched';
    const again = await f.fetch(rec);
    assert.equal(again.ok, true, `${reading}: ${again.error}`);
    assert.equal(again.path, first.path, reading);
    assert.equal(lastAuth, 'untouched', `${reading}: served from the saved copy, with nothing dialed`);
  }
});

/** The framework's eager default, autoFetchReferences, run over `content`
 *  as a tool result from server `srv`, with this file's fetcher. It
 *  registers in the process-wide referenceRegistry, so each test's uris are
 *  its own. */
async function eagerFetch(content: unknown[]): Promise<void> {
  const fetcher = makeFetcher({ srv: { url: ORIGIN } });
  const framework = Object.create(AgentFramework.prototype) as {
    getReferenceFetcher(): ReferenceFetcher;
    autoFetchReferences(content: unknown[], serverId: string, eager: boolean): Promise<void>;
  };
  framework.getReferenceFetcher = () => fetcher;
  await framework.autoFetchReferences(content, 'srv', true);
}

test('the eager default skips expired references, so the live ones after them get its slots', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  // Nine small references from the dialed origin, the first three expired:
  // passed, unparseable and rejected as a field.
  const expired = ['2001-01-01T00:00:00Z', 'not-a-date', 'x'.repeat(65)].map((expiresAt, i) => (
    { type: 'resource', uri: `${ORIGIN}/ok?eager-expired=${i}`, sizeBytes: PAYLOAD.length, expiresAt }));
  const live = Array.from({ length: 6 }, (_, i) => (
    { type: 'resource', uri: `${ORIGIN}/ok?eager-live=${i}`, sizeBytes: PAYLOAD.length }));
  await eagerFetch([...expired, ...live]);
  for (const block of live) {
    assert.ok(referenceRegistry.findByUri(block.uri)?.fetchedPath, `${block.uri} took an eager slot`);
  }
  for (const block of expired) {
    assert.equal(referenceRegistry.findByUri(block.uri)?.fetchedPath, undefined, `${block.uri} took none`);
  }
  const refusals = errors.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('[rfc005]'));
  assert.deepEqual(refusals, [], 'no refused fetch is logged');
});

test('a uri the result repeats takes one eager slot, and the slots stop at eight', async () => {
  // Nine distinct small references, the first sent twice: ten blocks.
  const blocks = Array.from({ length: 9 }, (_, i) => (
    { type: 'resource', uri: `${ORIGIN}/ok?eager-distinct=${i}`, sizeBytes: PAYLOAD.length }));
  await eagerFetch([blocks[0], ...blocks]);
  for (const block of blocks.slice(0, 8)) {
    assert.ok(referenceRegistry.findByUri(block.uri)?.fetchedPath, `${block.uri} took an eager slot`);
  }
  assert.equal(referenceRegistry.findByUri(blocks[8].uri)?.fetchedPath, undefined, 'the ninth stays lazy');
});

test('within one result, a uri that any block calls expired takes no eager slot; a later result can refresh it', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const block = (uri: string, expiresAt?: string) => ({ type: 'resource', uri, sizeBytes: PAYLOAD.length, ...(expiresAt ? { expiresAt } : {}) });
  for (const order of ['expired-first', 'expired-last']) {
    const uri = `${ORIGIN}/ok?eager-mixed=${order}`;
    const expired = block(uri, '2001-01-01T00:00:00Z');
    await eagerFetch(order === 'expired-first' ? [expired, block(uri)] : [block(uri), expired]);
    assert.equal(referenceRegistry.findByUri(uri)?.fetchedPath, undefined, `${order}: no slot`);
  }
  const refusals = errors.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('[rfc005]'));
  assert.deepEqual(refusals, [], 'no refused fetch is logged');
  // A later result re-issues the uri with a fresh expiry, as a re-signed URL would.
  const refreshed = `${ORIGIN}/ok?eager-mixed=expired-first`;
  await eagerFetch([block(refreshed, '2999-01-01T00:00:00Z')]);
  assert.ok(referenceRegistry.findByUri(refreshed)?.fetchedPath, 'the later result\'s fresh testimony stands');
});

// The registry holds 2000 records. Found by Beth-2389's and Beatrice-2379's
// reads of this change; these adapt their probes.
const REGISTRY_RECORDS = 2000;
const registerResource = (uri: string, sizeBytes?: number) => {
  const c = classifyBlock({ type: 'resource', uri, ...(sizeBytes !== undefined ? { sizeBytes } : {}) });
  if (c.kind !== 'reference') throw new Error('fixture: not a reference');
  return referenceRegistry.register(c.testimony, 'srv');
};

test("a uri a result mentions isn't evicted by the result's later blocks, so its eager copy lands in the record its stub names", async () => {
  const target = '/ok?registered=again';
  // Fill the registry so that the target's record is its oldest.
  const first = registerResource(`${ORIGIN}${target}`, PAYLOAD.length);
  for (let i = 1; i < REGISTRY_RECORDS; i++) registerResource(`${ORIGIN}/history?registered=again&i=${i}`);
  await eagerFetch([
    { type: 'resource', uri: `${ORIGIN}${target}`, sizeBytes: PAYLOAD.length },
    { type: 'resource', uri: `${ORIGIN}/ok?registered=again-new`, sizeBytes: PAYLOAD.length }, // a new uri, which evicts one record
  ]);
  assert.equal(hits.get(target) ?? 0, 1, 'requests for the target');
  assert.equal(referenceRegistry.findByUri(`${ORIGIN}${target}`), first, 'the registry still holds the target');
  assert.ok(first.fetchedPath, 'and its record holds the copy');
});

for (const expired of [true, false]) {
  test(`past the registry's bound, a repeated uri ${expired ? 'that a block calls expired still takes no eager slot' : 'still takes one eager slot'} when the result itself evicts its record`, async () => {
    const tag = expired ? 'expired' : 'fresh';
    const target = `/ok?past-bound=${tag}`;
    const first = registerResource(`${ORIGIN}${target}`, PAYLOAD.length);
    // The target, then as many new uris as the registry holds (sizes
    // unclaimed, so none is eager-eligible), then the target again: the new
    // uris evict its first record, and its last block registers a second.
    await eagerFetch([
      { type: 'resource', uri: `${ORIGIN}${target}`, sizeBytes: PAYLOAD.length, ...(expired ? { expiresAt: '2001-01-01T00:00:00Z' } : {}) },
      ...Array.from({ length: REGISTRY_RECORDS }, (_, i) => ({ type: 'resource', uri: `${ORIGIN}/filler?past-bound=${tag}&i=${i}` })),
      { type: 'resource', uri: `${ORIGIN}${target}`, sizeBytes: PAYLOAD.length },
    ]);
    const current = referenceRegistry.findByUri(`${ORIGIN}${target}`);
    assert.notEqual(current?.refId, first.refId, 'the result evicted the target\'s record, and its last block registered a second');
    assert.equal(hits.get(target) ?? 0, expired ? 0 : 1, 'requests for the target');
    if (!expired) assert.ok(current?.fetchedPath, "the uri's current record, the one its stub names, holds the copy");
  });
}

/** A refusal by the budget says it lasts, so a second try is no use unless
 *  whoever runs the host raises or renews it. */
const BUDGET_LASTS = "the budget doesn't renew on its own, so calling again won't change that unless whoever runs this host raises or renews it";
/** The budget's stop partway, with the server's running total and the budget. */
const STOPPED_BY_BUDGET = new RegExp(`^aborted: per-server fetch budget exhausted \\((\\d+)/(\\d+) bytes\\); ${BUDGET_LASTS}$`);

test('per-server budget exhausts cumulatively, each fetch counting once', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: 2 * PAYLOAD.length } } });
  const a = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?n=1`));
  assert.equal(a.ok, true, a.error);
  // Exactly what's left: still within the budget.
  const b = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?n=2`));
  assert.equal(b.ok, true, b.error);
  const c = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?n=3`));
  assert.equal(c.ok, false);
  assert.equal(c.error, `per-server fetch budget exhausted (${2 * PAYLOAD.length}/${2 * PAYLOAD.length} bytes); ${BUDGET_LASTS}`);
});

test("a download the budget stops says so, and what arrived counts toward the next fetch's refusal", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: 1000 } } });
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/liar?budget-abort`));
  // The refusal shows the server's running total, past the budget, and the budget.
  const [, total, budget] = STOPPED_BY_BUDGET.exec(out.error!) ?? [];
  assert.ok(Number(total) > 1000, out.error);
  assert.equal(budget, '1000');
  const next = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?after-budget-abort`));
  assert.equal(next.error, `per-server fetch budget exhausted (${total}/1000 bytes); ${BUDGET_LASTS}`);
});

test('a budget crossed on a later chunk stops the download there, with every chunk counted', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: 1500 } } });
  // 1000 bytes, then after a pause 1000 more: only a chunk of the second write
  // passes the budget, and only if the first was already counted.
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/drip?first=1000&rest=1000&wait=500`));
  const [, total, budget] = STOPPED_BY_BUDGET.exec(out.error ?? '') ?? [];
  assert.equal(budget, '1500', out.error);
  assert.ok(Number(total) > 1500 && Number(total) <= 2000, out.error);
});

test('concurrent fetches from one server share its budget, and none takes what another spent', async () => {
  const reg = new ReferenceRegistry();
  const budget = 2 * PAYLOAD.length + 100;
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: budget } } });
  // As the eager path does: several at once, each starting with the whole budget left.
  const outs = await Promise.all([1, 2, 3, 4].map((n) => f.fetch(makeRecord(reg, `${ORIGIN}/ok?shared-${n}`))));
  const kept = outs.filter((o) => o.ok);
  assert.ok(kept.length * PAYLOAD.length <= budget, `${kept.length} kept, ${kept.length * PAYLOAD.length} bytes against ${budget}`);
  const refused = outs.filter((o) => !o.ok);
  assert.ok(refused.length > 0, 'four payloads cannot fit a budget of two and a bit');
  for (const o of refused) assert.match(o.error!, STOPPED_BY_BUDGET);
  // Every byte read counts, so a fifth is refused before it dials.
  const fifth = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?shared-5`));
  assert.match(fifth.error!, /^per-server fetch budget exhausted/);
});

test("bytes the workspace couldn't store still count against the budget", async () => {
  const reg = new ReferenceRegistry();
  const unsaved = new ReferenceFetcher(() => ({ url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length + 100 } }), async () => null);
  const notStored = await unsaved.fetch(makeRecord(reg, `${ORIGIN}/ok?unsaved-1`));
  assert.equal(notStored.error, 'no writable workspace mount to store the payload');
  assert.match((await unsaved.fetch(makeRecord(reg, `${ORIGIN}/ok?unsaved-2`))).error!, STOPPED_BY_BUDGET);
});

test("bytes that don't match their digest still count against the budget", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length + 100 } } });
  const mismatch = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?mismatch-charged`, { digest: 'sha256:' + 'B'.repeat(43) }));
  assert.match(mismatch.error!, /^digest mismatch/);
  const after = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?after-mismatch`));
  // The stop shows the server's total, the mismatched payload included, not
  // this download's own bytes.
  const [, total, budget] = STOPPED_BY_BUDGET.exec(after.error ?? '') ?? [];
  assert.equal(budget, String(PAYLOAD.length + 100), after.error);
  assert.ok(Number(total) > PAYLOAD.length, after.error);
});

test('bytes that arrived before a timeout still count against the budget', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length + 300 } } });
  // 1000 bytes arrive at once, and the rest only after the fetch gives up.
  // The timeout leaves a second for the headers and the first 1000 bytes.
  const slow = await f.fetch(makeRecord(reg, `${ORIGIN}/drip?first=1000&rest=1000&wait=60000`), { timeoutMs: 1000 });
  assert.equal(slow.error, 'fetch timed out or aborted');
  assert.match((await f.fetch(makeRecord(reg, `${ORIGIN}/ok?after-timeout`))).error!, STOPPED_BY_BUDGET);
});

test('bytes past the ceiling still count against the budget', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length + 500 } } });
  // 1200 bytes arrive before the pause: past max_bytes, within the budget. A
  // payload alone fits what's left only if what was read went uncounted.
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/drip?first=1200&rest=5000&wait=10000`), { maxBytes: 1000 });
  assert.match(out.error!, /^aborted: actual bytes exceeded ceiling at \d+$/);
  assert.match((await f.fetch(makeRecord(reg, `${ORIGIN}/ok?after-ceiling`))).error!, STOPPED_BY_BUDGET);
});

test('max_bytes limits each download, not the server\'s running total', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  // Each payload is under max_bytes, though together they pass it.
  for (const n of [1, 2]) {
    const out = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?per-download-${n}`), { maxBytes: PAYLOAD.length + 100 });
    assert.equal(out.ok, true, out.error);
  }
});

test('a download past both max_bytes and the budget is told about the budget, which no max_bytes lifts', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: 1000 } } });
  // A first fetch's total is its own bytes, so both limits fall at the same chunk.
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?both-limits`), { maxBytes: 1000 });
  assert.match(out.error!, STOPPED_BY_BUDGET);
});

test("a claim over max_bytes and over what's left of the budget is refused for the budget, before dialing", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length + 100 } } });
  assert.equal((await f.fetch(makeRecord(reg, `${ORIGIN}/ok?spend-most`))).ok, true);
  // 100 bytes are left: a larger max_bytes wouldn't let this claim through.
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?claim-past-both`, { sizeBytes: 10_000 }), { maxBytes: 1000 });
  assert.equal(out.error, `claimed 10000 bytes exceeds what's left of the per-server fetch budget (${PAYLOAD.length}/${PAYLOAD.length + 100} bytes); ${BUDGET_LASTS}`);
  // Within what's left, the same claim is refused for the ceiling, which a larger max_bytes lifts.
  const roomy = makeFetcher({ srv: { url: ORIGIN } });
  const ceilingOnly = await roomy.fetch(makeRecord(reg, `${ORIGIN}/ok?claim-past-ceiling`, { sizeBytes: 10_000 }), { maxBytes: 1000 });
  assert.equal(ceilingOnly.error, 'claimed 10000 bytes exceeds fetch ceiling 1000');
});

test("a claim over what's left of the budget but within max_bytes still dials, since a claim can be wrong", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: 2 * PAYLOAD.length + 100 } } });
  assert.equal((await f.fetch(makeRecord(reg, `${ORIGIN}/ok?spend-one`))).ok, true);
  // The claim is past what's left, but the payload is the same 2200 bytes, which fit.
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?claims-too-much`, { sizeBytes: 10_000 }));
  assert.equal(out.ok, true, out.error);
});

test('a claim over max_bytes, once the budget is spent, is refused for the budget', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length } } });
  assert.equal((await f.fetch(makeRecord(reg, `${ORIGIN}/ok?spend`))).ok, true);
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?claim-over`, { sizeBytes: 10_000 }), { maxBytes: 1000 });
  assert.equal(out.error, `per-server fetch budget exhausted (${PAYLOAD.length}/${PAYLOAD.length} bytes); ${BUDGET_LASTS}`);
});

test('eager eligibility: small + sized + connection origin only', () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  assert.equal(f.isEagerEligible(makeRecord(reg, `${ORIGIN}/a`, { sizeBytes: 1000 })), true);
  assert.equal(f.isEagerEligible(makeRecord(reg, `${ORIGIN}/b`, { sizeBytes: 50_000_000 })), false, 'over eager ceiling');
  assert.equal(f.isEagerEligible(makeRecord(reg, `${ORIGIN}/c`)), false, 'no sizeBytes claim');
  assert.equal(f.isEagerEligible(makeRecord(reg, `https://cdn.example/d`, { sizeBytes: 10 })), false, 'third-party');
  {
    // explicit-undefined would trigger makeRecord's default; build directly
    const c = classifyBlock({ type: 'resource', uri: `${ORIGIN}/e`, sizeBytes: 10 });
    assert.equal(c.kind, 'reference');
    const rec = reg.register((c as Extract<ReturnType<typeof classifyBlock>, { kind: 'reference' }>).testimony, undefined);
    assert.equal(f.isEagerEligible(rec), false, 'no server binding');
  }
});

test('vector 20 substrate: registry dedup + defined miss', () => {
  const reg = new ReferenceRegistry();
  const a = makeRecord(reg, `${ORIGIN}/same`);
  const b = makeRecord(reg, `${ORIGIN}/same`);
  assert.equal(a.refId, b.refId, 'same uri+server shares a record');
  assert.equal(reg.get('ref_nope'), undefined, 'stale/unknown id is a defined miss');
});

test('normalizedOrigin maps ws/wss and elides default ports', () => {
  assert.equal(normalizedOrigin('ws://Host.Example:80/x'), 'http://host.example');
  assert.equal(normalizedOrigin('wss://host.example/x'), 'https://host.example');
  assert.equal(normalizedOrigin('https://host.example:8443'), 'https://host.example:8443');
  assert.equal(normalizedOrigin('not a url'), null);
});

test.after(() => { server.close(); });

test('binding upgrade: unbound stub-time registration gains the dispatch serverId', () => {
  const reg = new ReferenceRegistry();
  const c = classifyBlock({ type: 'resource', uri: `${ORIGIN}/upgrade.wav`, sizeBytes: 10 });
  assert.equal(c.kind, 'reference');
  const t = (c as Extract<ReturnType<typeof classifyBlock>, { kind: 'reference' }>).testimony;
  const unbound = reg.register(t);                    // stub site: no server context
  const bound = reg.register(t, 'srv');               // dispatch: knows the server
  assert.equal(unbound.refId, bound.refId, 'one record, not a fork');
  assert.equal(unbound.serverId, 'srv', 'binding upgraded in place');
});

test('fetch_reference answers an unbound reference with the reason its stub gives, and dials nothing', { timeout: 10_000 }, async () => {
  // Registered with no server, as an in-process module's reference or a channel message's is.
  const c = classifyBlock({ type: 'resource', uri: `${ORIGIN}/ok?unbound`, sizeBytes: PAYLOAD.length });
  assert.equal(c.kind, 'reference');
  const record = referenceRegistry.register((c as Extract<ReturnType<typeof classifyBlock>, { kind: 'reference' }>).testimony);
  const fetcher = makeFetcher({ srv: { url: ORIGIN } });
  assert.equal(fetcher.isEagerEligible(record), false, 'no eager slot either');
  type Answer = { result: { success: boolean; error?: string; isError?: boolean } };
  const framework = Object.create(AgentFramework.prototype) as {
    getReferenceFetcher(): ReferenceFetcher;
    emitTrace(event: unknown): void;
    pushEvent(event: unknown): void;
    dispatchFetchReferenceToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
  };
  framework.getReferenceFetcher = () => fetcher;
  framework.emitTrace = () => {};
  const answered = new Promise<Answer>((resolve) => { framework.pushEvent = (event) => resolve(event as Answer); });
  framework.dispatchFetchReferenceToolCall('prime', { id: 'call_fetch', name: 'fetch_reference', input: { ref_id: record.refId } });
  const { result } = await answered;
  assert.equal(result.success, false);
  assert.equal(result.isError, true);
  assert.equal(result.error, `reference ${UNBOUND_REASON}`);
  assert.equal(hits.get('/ok?unbound') ?? 0, 0, 'nothing dialed');
});

test('a reference both unbound and expired is refused as unbound, the reason its stub gives', async () => {
  const reg = new ReferenceRegistry();
  const c = classifyBlock({ type: 'resource', uri: `${ORIGIN}/ok?unbound-expired`, expiresAt: '2001-01-01T00:00:00Z' });
  assert.equal(c.kind, 'reference');
  const t = (c as Extract<ReturnType<typeof classifyBlock>, { kind: 'reference' }>).testimony;
  assert.equal(referenceExpiry(t), 'passed');
  const out = await makeFetcher({ srv: { url: ORIGIN } }).fetch(reg.register(t));
  assert.equal(out.ok, false);
  assert.equal(out.error, `reference ${UNBOUND_REASON}`);
  assert.equal(hits.get('/ok?unbound-expired') ?? 0, 0, 'nothing dialed');
});

test('testimony refreshes while unfetched, freezes after fetch', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const mk = (digest: string) => {
    const c = classifyBlock({ type: 'resource', uri: `${ORIGIN}/ok?refresh=1`, digest });
    return (c as Extract<ReturnType<typeof classifyBlock>, { kind: 'reference' }>).testimony;
  };
  const stale = 'sha256:' + 'C'.repeat(43);
  const rec = reg.register(mk(stale), 'srv');
  reg.register(mk(DIGEST), 'srv');                    // re-issued with the real digest
  assert.equal(rec.testimony.digest, DIGEST, 'unfetched record must take the new digest');
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
  reg.register(mk(stale), 'srv');                     // later stale re-issue
  assert.equal(rec.testimony.digest, DIGEST, 'fetched record keeps verified testimony');
});

test('vector 13: magic bytes beat a lying Content-Type header for storage type', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/octet`);     // server sends RIFF bytes as octet-stream
  const out = await f.fetch(rec);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'audio/wav', 'sniffed type must win');
  assert.ok(rec.fetchedPath!.endsWith('.wav'), rec.fetchedPath);
});
