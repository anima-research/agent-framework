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
import { ReferenceRegistry, classifyBlock } from '../src/mcpl/references.js';

const PAYLOAD = Buffer.from('RIFF-not-really-a-wav-'.repeat(100));
const DIGEST = 'sha256:' + createHash('sha256').update(PAYLOAD).digest('base64url');

let lastAuth: string | null = null;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  lastAuth = req.headers.authorization ?? null;
  if (url.pathname === '/ok') {
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(PAYLOAD);
  } else if (url.pathname === '/redirect') {
    res.writeHead(302, { location: 'http://evil.example/x' }); res.end();
  } else if (url.pathname === '/octet') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(PAYLOAD);
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

test('vector 16: expired (and unparseable-expiry) references refuse locally', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  for (const expiresAt of ['2001-01-01T00:00:00Z', 'not-a-date']) {
    const rec = makeRecord(reg, `${ORIGIN}/ok?e=${expiresAt}`, { expiresAt });
    const out = await f.fetch(rec);
    assert.equal(out.ok, false);
    assert.match(out.error!, /expired/);
  }
});

test('per-server budget exhausts cumulatively', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length + 10 } } });
  const a = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?n=1`));
  assert.equal(a.ok, true, a.error);
  const b = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?n=2`));
  assert.equal(b.ok, false);
  assert.match(b.error!, /budget/);
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
