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
import { DEFAULT_FETCH_MAX_BYTES, ReferenceFetcher, normalizedOrigin, type ServerResolution } from '../src/mcpl/reference-fetcher.js';
import { EXPIRY_REASON, noAddressReason, ReferenceRegistry, UNBOUND_REASON, classifyBlock, referenceExpiry, referenceRegistry, shownServerId } from '../src/mcpl/references.js';
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
  } else if (url.pathname.startsWith('/status/')) {
    // answers with the status its path names, and nothing else
    res.writeHead(Number(url.pathname.slice('/status/'.length))); res.end();
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const ORIGIN = `http://127.0.0.1:${port}`;

const saved: Array<{ name: string; bytes: number; mime: string }> = [];
function makeFetcher(bindings: Record<string, ServerResolution>) {
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

// What a failure says calling again can do, in the fetcher's words.
const NOTHING_TO_DO = "Calling again won't change that.";
const FRESH_REFERENCE = "Once a fresh reference to it arrives, fetching may work; until then, fetching it again won't.";
const TRY_LATER = 'Trying again later may work.';
const REQUEST_FAILED = "Trying again later may work; if it fails the same way, whoever runs this host can check its connection to the server.";
const BUDGET = "The budget doesn't renew on its own, so calling again won't change that unless whoever runs this host raises or renews it.";
const HOST_CEILING = "No max_bytes or setting lifts that limit, so calling again won't change it.";
const SERVER_BACK = "Calling again won't change that unless whoever runs this host adds that server back.";

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
  assert.match(out.error!, /^the bytes that arrived don't match the reference's digest \(sha256:B{13}…, against sha256:[\w-]{13}…\), so they weren't kept$/);
  assert.equal(out.remedy, "Trying again may work; if it fails the same way, fetching may work once a fresh reference to it arrives.");
  assert.equal(rec.fetchedPath, undefined);
});

test('vector 10: stream past the ceiling aborts on actual bytes', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/liar`, { sizeBytes: 100 });
  const out = await f.fetch(rec, { maxBytes: 50_000 });
  assert.equal(out.ok, false);
  const [, received] = /^the download had reached (\d+) bytes, past the 50000 bytes this call allows, so it was stopped and nothing was kept$/.exec(out.error!) ?? [];
  assert.ok(received, out.error);
  // Its whole size is unknown, only that it's past what arrived, and the budget has room for the host's ceiling.
  assert.equal(out.remedy, `It's at least ${received} bytes; a larger max_bytes, up to ${DEFAULT_FETCH_MAX_BYTES}, may fetch it.`);
});

test('vector 4: a claim already over the ceiling refuses without dialing', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/ok`, { sizeBytes: 10_000_000 });
  const out = await f.fetch(rec, { maxBytes: 1000 });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'it claims 10000000 bytes, over the 1000 bytes this call allows');
  assert.equal(out.remedy, 'Pass max_bytes of at least 10000000 to fetch it.');
  // Past the host's own ceiling, no max_bytes can fetch it.
  const huge = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?huge`, { sizeBytes: DEFAULT_FETCH_MAX_BYTES + 1 }), { maxBytes: 1000 });
  assert.equal(huge.error, `it claims ${DEFAULT_FETCH_MAX_BYTES + 1} bytes, over the ${DEFAULT_FETCH_MAX_BYTES} bytes this host fetches at most`);
  assert.equal(huge.remedy, HOST_CEILING);
  assert.equal(hits.get('/ok?huge') ?? 0, 0, 'nothing dialed');
});

test('vector 11: non-http(s) scheme refused', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, 'file:///etc/passwd');
  const out = await f.fetch(rec);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'its address uses file:, and this host fetches only http: and https: addresses');
  assert.equal(out.remedy, NOTHING_TO_DO);
});

test("a ws: or wss: reference on its server's own origin is refused for its scheme, with nothing dialed", async () => {
  // An origin reads ws: as http: and wss: as https:, so each is on the dialed
  // origin. fetch can't dial either, and would fail only once dialed.
  const reg = new ReferenceRegistry();
  for (const [scheme, dialed] of [['ws:', `ws://127.0.0.1:${port}`], ['wss:', 'wss://ws-ref.example.invalid']] as const) {
    const f = makeFetcher({ srv: { url: dialed } });
    const host = scheme === 'ws:' ? `127.0.0.1:${port}` : 'ws-ref.example.invalid';
    const out = await f.fetch(makeRecord(reg, `${scheme}//${host}/ok?scheme=${scheme}`));
    assert.equal(out.error, `its address uses ${scheme}, and this host fetches only http: and https: addresses`, scheme);
    assert.equal(out.remedy, NOTHING_TO_DO, scheme);
  }
  assert.equal(hits.get('/ok?scheme=ws:') ?? 0, 0, 'nothing dialed');
});

test('vector 12: redirects refused, no traversal', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, `${ORIGIN}/redirect`);
  const out = await f.fetch(rec);
  assert.equal(out.ok, false);
  assert.equal(out.error, `the "srv" server answered HTTP 302, a redirect, and this host doesn't follow redirects`);
  assert.equal(out.remedy, NOTHING_TO_DO);
});

test('third-party origin refused (v1 policy: dialed origin only)', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const rec = makeRecord(reg, 'https://cdn.example.com/thing.wav');
  const out = await f.fetch(rec);
  assert.equal(out.ok, false);
  assert.equal(out.error,
    `it points to https://cdn.example.com, not to the "srv" server's own address (${ORIGIN}), and this host fetches only from the server itself`);
  assert.equal(out.remedy, NOTHING_TO_DO);
});

test('a reference whose address carries a user name or password is refused before dialing, without repeating them', async () => {
  // fetch refuses such a url with a message that holds it whole, so the
  // credential would reach the agent's context and the host's log.
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: `ws://127.0.0.1:${port}` } });
  const clause = "its address carries a user name or password, which this host doesn't send";
  // A user name with a password, a user name alone, and a password alone.
  for (const uri of [`http://user:s3cret@127.0.0.1:${port}/ok?userinfo`, `http://justauser@127.0.0.1:${port}/ok?userinfo-name`,
    `http://:s3cret@127.0.0.1:${port}/ok?userinfo-password`]) {
    // A claimed size within the eager limit, so only the refusal keeps the eager fetch away.
    const rec = makeRecord(reg, uri, { sizeBytes: 1000 });
    assert.deepEqual(f.refusal(rec), { error: clause, remedy: NOTHING_TO_DO }, uri);
    assert.equal(f.isEagerEligible(rec), false, uri);
    const out = await f.fetch(rec);
    assert.equal(out.error, clause, uri);
    assert.equal(out.remedy, NOTHING_TO_DO, uri);
  }
  assert.equal(['/ok?userinfo', '/ok?userinfo-name', '/ok?userinfo-password'].reduce((n, k) => n + (hits.get(k) ?? 0), 0), 0, 'nothing dialed');
});

test('an http: reference from a server dialed over TLS is refused as another origin, with nothing dialed', async () => {
  // The same host and port, so only the scheme differs: the origin check, which
  // compares origins with their schemes, is all that refuses it.
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: `wss://127.0.0.1:${port}` } });
  const rec = makeRecord(reg, `${ORIGIN}/ok?plaintext-from-tls`);
  const out = await f.fetch(rec);
  assert.equal(out.error,
    `it points to ${ORIGIN}, not to the "srv" server's own address (wss://127.0.0.1:${port}), and this host fetches only from the server itself`);
  assert.equal(out.remedy, NOTHING_TO_DO);
  assert.equal(hits.get('/ok?plaintext-from-tls') ?? 0, 0, 'nothing dialed');
});

test('vector 16: expired (and unparseable-expiry) references refuse locally, and take no eager slot', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  for (const [expiresAt, why] of [['2001-01-01T00:00:00Z', /^the reference is expired$/], ['not-a-date', /^the reference is treated as expired, since its expiry time can't be read$/]] as const) {
    // Small, sized and from the dialed origin: only its expiry keeps it from the eager default.
    const rec = makeRecord(reg, `${ORIGIN}/ok?e=${expiresAt}`, { expiresAt, sizeBytes: PAYLOAD.length });
    assert.equal(f.isEagerEligible(rec), false, `${expiresAt}: the eager default would only be refused`);
    const out = await f.fetch(rec);
    assert.equal(out.ok, false);
    assert.match(out.error!, why);
    assert.equal(out.remedy, FRESH_REFERENCE);
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
    assert.equal(out.error, "the reference is treated as expired, since its expiry time isn't in a form this host accepts", label);
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
 *  as a tool result from server `srv`, with this file's fetcher or the one
 *  given. It registers in the process-wide referenceRegistry, so each test's
 *  uris are its own. */
async function eagerFetch(content: unknown[], fetcher: ReferenceFetcher = makeFetcher({ srv: { url: ORIGIN } })): Promise<void> {
  const framework = Object.create(AgentFramework.prototype) as {
    getReferenceFetcher(): ReferenceFetcher;
    autoFetchReferences(content: unknown[], serverId: string, forScript: boolean): Promise<void>;
  };
  framework.getReferenceFetcher = () => fetcher;
  // The eager pass alone, as for the model's call: a script's demand would fetch the rest.
  await framework.autoFetchReferences(content, 'srv', false);
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

/** The budget's stop partway, with the server's running total and the budget. */
const STOPPED_BY_BUDGET = /^this host's fetch budget for the "srv" server ran out during the download \((\d+) of (\d+) bytes\), so it was stopped and nothing was kept$/;
/** The budget's refusal before dialing, with what's used of it. */
const usedUp = (used: number | string, budget: number | string) => `this host's fetch budget for the "srv" server is used up (${used} of ${budget} bytes)`;

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
  assert.equal(c.error, usedUp(2 * PAYLOAD.length, 2 * PAYLOAD.length));
  // A refusal by the budget says it lasts, so a second try is no use unless
  // whoever runs the host raises or renews it.
  assert.equal(c.remedy, BUDGET);
});

test("a download the budget stops says so, and what arrived counts toward the next fetch's refusal", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: 1000 } } });
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/liar?budget-abort`));
  // The refusal shows the server's running total, past the budget, and the budget.
  const [, total, budget] = STOPPED_BY_BUDGET.exec(out.error!) ?? [];
  assert.ok(Number(total) > 1000, out.error);
  assert.equal(budget, '1000');
  assert.equal(out.remedy, BUDGET);
  const next = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?after-budget-abort`));
  assert.equal(next.error, usedUp(total, 1000));
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
  assert.match(fifth.error!, /^this host's fetch budget for the "srv" server is used up /);
});

test("bytes the workspace couldn't store still count against the budget", async () => {
  const reg = new ReferenceRegistry();
  const unsaved = new ReferenceFetcher(() => ({ url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length + 100 } }), async () => null);
  const notStored = await unsaved.fetch(makeRecord(reg, `${ORIGIN}/ok?unsaved-1`));
  assert.equal(notStored.error, "it was fetched, but this host couldn't store it in its workspace, so nothing was kept");
  assert.equal(notStored.remedy, 'Calling again is likely to fail the same way; whoever runs this host can see why in its log.');
  assert.match((await unsaved.fetch(makeRecord(reg, `${ORIGIN}/ok?unsaved-2`))).error!, STOPPED_BY_BUDGET);
});

test("bytes that don't match their digest still count against the budget", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length + 100 } } });
  const mismatch = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?mismatch-charged`, { digest: 'sha256:' + 'B'.repeat(43) }));
  assert.match(mismatch.error!, /^the bytes that arrived don't match the reference's digest /);
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
  assert.equal(slow.error, 'it took longer than 1 second');
  assert.equal(slow.remedy, TRY_LATER);
  assert.match((await f.fetch(makeRecord(reg, `${ORIGIN}/ok?after-timeout`))).error!, STOPPED_BY_BUDGET);
});

test('bytes past the ceiling still count against the budget', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length + 500 } } });
  // 1200 bytes arrive before the pause: past max_bytes, within the budget. A
  // payload alone fits what's left only if what was read went uncounted.
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/drip?first=1200&rest=5000&wait=10000`), { maxBytes: 1000 });
  const [, received] = /^the download had reached (\d+) bytes, past the 1000 bytes this call allows, so it was stopped and nothing was kept$/.exec(out.error!) ?? [];
  assert.ok(received, out.error);
  // Past max_bytes, and no more than the 1200 bytes sent before the pause, however they were chunked.
  assert.ok(Number(received) > 1000 && Number(received) <= 1200, received);
  // A larger max_bytes can read no more than the budget has left after these bytes.
  assert.equal(out.remedy, `It's at least ${received} bytes; a larger max_bytes, up to ${PAYLOAD.length + 500 - Number(received)}, may fetch it.`);
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
  assert.equal(out.error, `it claims 10000 bytes, more than the 100 bytes left of this host's fetch budget for the "srv" server`);
  assert.equal(out.remedy, BUDGET);
  // Within what's left, the same claim is refused for the ceiling, which a larger max_bytes lifts.
  const roomy = makeFetcher({ srv: { url: ORIGIN } });
  const ceilingOnly = await roomy.fetch(makeRecord(reg, `${ORIGIN}/ok?claim-past-ceiling`, { sizeBytes: 10_000 }), { maxBytes: 1000 });
  assert.equal(ceilingOnly.error, 'it claims 10000 bytes, over the 1000 bytes this call allows');
  assert.equal(ceilingOnly.remedy, 'Pass max_bytes of at least 10000 to fetch it.');
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
  assert.equal(out.error, usedUp(PAYLOAD.length, PAYLOAD.length));
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

test('an unbound stub-time registration gains the dispatch server, in the same record', () => {
  const reg = new ReferenceRegistry();
  const c = classifyBlock({ type: 'resource', uri: `${ORIGIN}/upgrade.wav`, sizeBytes: 10 });
  assert.equal(c.kind, 'reference');
  const t = (c as Extract<ReturnType<typeof classifyBlock>, { kind: 'reference' }>).testimony;
  const unbound = reg.register(t);                    // stub site: no server context
  const bound = reg.register(t, 'srv');               // dispatch: knows the server
  assert.equal(unbound.refId, bound.refId, 'one record, not a fork');
  assert.deepEqual(unbound.serverIds, ['srv'], 'the dispatch server added to the same record');
});

test('fetch_reference answers an unbound reference with the reason its stub gives, and dials nothing', { timeout: 10_000 }, async () => {
  // Registered with no server, as a reference in a module's own tool result is.
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
  // The fetcher's clause and remedy, in fetch_reference's sentence.
  assert.equal(result.error, `fetch_reference couldn't fetch "${record.refId}": it's ${UNBOUND_REASON}. ${FRESH_REFERENCE}`);
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
  assert.equal(out.error, `it's ${UNBOUND_REASON}`);
  assert.equal(out.remedy, FRESH_REFERENCE);
  assert.equal(hits.get('/ok?unbound-expired') ?? 0, 0, 'nothing dialed');
});

test('a uri two servers deliver is fetched through the one on its origin, whichever came first, with that server\'s token, eager cap and budget', async () => {
  for (const order of [['relay', 'owner'], ['owner', 'relay']] as const) {
    const reg = new ReferenceRegistry();
    // The relay's own limits would refuse both the eager slot and the fetch,
    // so the record is eligible and fetched only by the owner's.
    const f = makeFetcher({
      relay: { url: 'https://relay.example.invalid', token: 'relay-token', autofetch: { maxBytes: 1, maxTotalBytes: 0 } },
      owner: { url: `ws://127.0.0.1:${port}`, token: 'owner-token' },
    });
    const uri = `${ORIGIN}/ok?two-servers=${order[0]}`;
    const record = makeRecord(reg, uri, { sizeBytes: PAYLOAD.length }, order[0]);
    assert.equal(makeRecord(reg, uri, { sizeBytes: PAYLOAD.length }, order[1]), record, 'one record for the uri');
    makeRecord(reg, uri, { sizeBytes: PAYLOAD.length }, order[0]);
    assert.deepEqual(record.serverIds, [...order], 'each server once, in the order they delivered it');
    assert.equal(f.isEagerEligible(record), true);
    const out = await f.fetch(record);
    assert.equal(out.ok, true, out.error);
    assert.equal(lastAuth, 'Bearer owner-token', 'dialed with the token of the server on the origin');
  }
});

test('a uri on none of its servers\' origins is refused with the first server\'s refusal, in either order', async () => {
  for (const order of [['a', 'b'], ['b', 'a']] as const) {
    const reg = new ReferenceRegistry();
    const f = makeFetcher({ a: { url: 'https://a.example.invalid' }, b: { url: 'https://b.example.invalid' } });
    const uri = `${ORIGIN}/ok?none-on-origin=${order[0]}`;
    // A claim within both servers' eager limits, so only the origin check
    // keeps the record from the eager pass.
    const record = makeRecord(reg, uri, { sizeBytes: PAYLOAD.length }, order[0]);
    makeRecord(reg, uri, { sizeBytes: PAYLOAD.length }, order[1]);
    assert.equal(f.isEagerEligible(record), false);
    const out = await f.fetch(record);
    assert.equal(out.ok, false);
    assert.equal(out.error,
      `it points to ${ORIGIN}, not to the "${order[0]}" server's own address (https://${order[0]}.example.invalid), and this host fetches only from the server itself`);
    assert.equal(hits.get(`/ok?none-on-origin=${order[0]}`) ?? 0, 0, 'nothing dialed');
  }
});

test('a server unknown to the host ahead of one off the origin is the refusal, and the other way round the origin check\'s is', async () => {
  for (const [order, refusal] of [
    [['gone', 'a'], /^this host no longer has the "gone" server it came from$/],
    [['a', 'gone'], /^it points to http:\/\/127\.0\.0\.1:\d+, not to the "a" server's own address \(https:\/\/a\.example\.invalid\)/],
  ] as const) {
    const reg = new ReferenceRegistry();
    const f = makeFetcher({ a: { url: 'https://a.example.invalid' } });
    const uri = `${ORIGIN}/ok?unknown-and-off-origin=${order[0]}`;
    const record = makeRecord(reg, uri, {}, order[0]);
    makeRecord(reg, uri, {}, order[1]);
    const out = await f.fetch(record);
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', refusal);
    assert.equal(hits.get(`/ok?unknown-and-off-origin=${order[0]}`) ?? 0, 0, 'nothing dialed');
  }
});

test('of two servers on the uri\'s origin, the first to deliver it is dialed, with its token', async () => {
  for (const order of [['first', 'second'], ['second', 'first']] as const) {
    const reg = new ReferenceRegistry();
    const f = makeFetcher({
      first: { url: `ws://127.0.0.1:${port}`, token: 'first-token' },
      second: { url: ORIGIN, token: 'second-token' },
    });
    const uri = `${ORIGIN}/ok?same-origin=${order[0]}`;
    const record = makeRecord(reg, uri, {}, order[0]);
    makeRecord(reg, uri, {}, order[1]);
    const out = await f.fetch(record);
    assert.equal(out.ok, true, out.error);
    assert.equal(lastAuth, `Bearer ${order[0]}-token`, 'dialed with the token of the first to deliver it');
  }
});

test('a server unknown to the host is its refusal while it is the only one, and passed over for one on the origin', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ owner: { url: `ws://127.0.0.1:${port}` } });
  const uri = `${ORIGIN}/ok?unknown-first`;
  const record = makeRecord(reg, uri, {}, 'gone');
  const gone = await f.fetch(record);
  assert.equal(gone.error, 'this host no longer has the "gone" server it came from');
  // The resolver reads the host's configs at each fetch, so the server's return would change it.
  assert.equal(gone.remedy, SERVER_BACK);
  makeRecord(reg, uri, {}, 'owner');
  assert.deepEqual(record.serverIds, ['gone', 'owner']);
  const out = await f.fetch(record);
  assert.equal(out.ok, true, out.error);
});

test('a server with no address is refused in a phrase naming it, and passed over for one on the origin', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ 'stdio-srv': 'no-address', owner: { url: `ws://127.0.0.1:${port}` } });
  const uri = `${ORIGIN}/ok?no-address`;
  // Small enough for an eager slot, so it takes none only for the server it came from.
  const record = makeRecord(reg, uri, { sizeBytes: PAYLOAD.length }, 'stdio-srv');
  assert.deepEqual(f.refusal(record), { error: noAddressReason('stdio-srv'), remedy: NOTHING_TO_DO });
  assert.equal((await f.fetch(record)).error, "this host doesn't connect to the \"stdio-srv\" server over a network, so there's nowhere to fetch it from");
  assert.equal(f.isEagerEligible(record), false);
  assert.equal(hits.get('/ok?no-address') ?? 0, 0, 'nothing dialed');
  makeRecord(reg, uri, { sizeBytes: PAYLOAD.length }, 'owner');
  assert.equal(f.refusal(record), null);
  assert.equal(f.isEagerEligible(record), true);
  const out = await f.fetch(record);
  assert.equal(out.ok, true, out.error);
});

test('a server with no address ahead of one off the origin is the refusal, and the other way round the origin check\'s is', async () => {
  for (const [order, refusal] of [
    [['stdio-srv', 'a'], /^this host doesn't connect to the "stdio-srv" server over a network/],
    [['a', 'stdio-srv'], /^it points to http:\/\/127\.0\.0\.1:\d+, not to the "a" server's own address \(https:\/\/a\.example\.invalid\)/],
  ] as const) {
    const reg = new ReferenceRegistry();
    const f = makeFetcher({ 'stdio-srv': 'no-address', a: { url: 'https://a.example.invalid' } });
    const uri = `${ORIGIN}/ok?no-address-and-off-origin=${order[0]}`;
    const record = makeRecord(reg, uri, {}, order[0]);
    makeRecord(reg, uri, {}, order[1]);
    assert.match(f.refusal(record)?.error ?? '', refusal);
    assert.match((await f.fetch(record)).error ?? '', refusal);
    assert.equal(hits.get(`/ok?no-address-and-off-origin=${order[0]}`) ?? 0, 0, 'nothing dialed');
  }
});

test('refusal() answers what the fetch would refuse before dialing, case by case, the eager check gives none of them a slot, and null where it would serve or dial', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({
    srv: { url: `ws://127.0.0.1:${port}` },
    'stdio-srv': 'no-address',
    spent: { url: `ws://127.0.0.1:${port}`, autofetch: { maxTotalBytes: 0 } },
    // A scheme that isn't special, whose URL origin is 'null', and a token in its userinfo.
    relay: { url: 'mcpl://tok:sekrit@relay.example:9000/path?key=x' },
    // An eager limit past the fetch's own ceiling and its budget: those still decide.
    roomy: { url: `ws://127.0.0.1:${port}`, autofetch: { maxBytes: 4 * 1024 * 1024 * 1024 } },
  });
  const small = { sizeBytes: PAYLOAD.length };
  // Each with what it says happened, and what it says calling again can do.
  const cases: Array<[string, ReturnType<typeof makeRecord>, string, string]> = [
    // makeRecord's server defaults when given undefined, so this one registers itself.
    ['unbound', reg.register((classifyBlock({ type: 'resource', uri: `${ORIGIN}/ok?case=unbound`, ...small }) as Extract<ReturnType<typeof classifyBlock>, { kind: 'reference' }>).testimony),
      `it's ${UNBOUND_REASON}`, FRESH_REFERENCE],
    ['unknown server', makeRecord(reg, `${ORIGIN}/ok?case=unknown`, small, 'gone'), 'this host no longer has the "gone" server it came from', SERVER_BACK],
    ['no address', makeRecord(reg, `${ORIGIN}/ok?case=no-address`, small, 'stdio-srv'), noAddressReason('stdio-srv'), NOTHING_TO_DO],
    ['off the origin', makeRecord(reg, 'https://cdn.example.invalid/case-origin', small, 'srv'),
      `it points to https://cdn.example.invalid, not to the "srv" server's own address (ws://127.0.0.1:${port}), and this host fetches only from the server itself`, NOTHING_TO_DO],
    // The server's address as configured, its scheme and host, without its userinfo, path or query.
    ['off the origin of a server on another scheme', makeRecord(reg, 'https://cdn.example.invalid/case-relay', small, 'relay'),
      'it points to https://cdn.example.invalid, not to the "relay" server\'s own address (mcpl://relay.example:9000), and this host fetches only from the server itself', NOTHING_TO_DO],
    ['expired', makeRecord(reg, `${ORIGIN}/ok?case=expired`, { ...small, expiresAt: '2001-01-01T00:00:00Z' }, 'srv'), `the reference is ${EXPIRY_REASON.passed}`, FRESH_REFERENCE],
    ['budget spent', makeRecord(reg, `${ORIGIN}/ok?case=budget`, small, 'spent'), 'this host\'s fetch budget for the "spent" server is used up (0 of 0 bytes)', BUDGET],
    ['over the ceiling', makeRecord(reg, `${ORIGIN}/ok?case=ceiling`, { sizeBytes: 512 * 1024 * 1024 }, 'roomy'),
      'it claims 536870912 bytes, over the 268435456 bytes this host fetches at most', HOST_CEILING],
    // Past the host's own ceiling, whatever the budget has left, since no budget lifts it.
    ['over the host ceiling and what is left of the budget', makeRecord(reg, `${ORIGIN}/ok?case=both`, { sizeBytes: 2 * 1024 * 1024 * 1024 }, 'roomy'),
      'it claims 2147483648 bytes, over the 268435456 bytes this host fetches at most', HOST_CEILING],
  ];
  for (const [what, record, error, remedy] of cases) {
    const refusal = f.refusal(record);
    assert.ok(refusal, `${what}: a refusal`);
    assert.equal(f.isEagerEligible(record), false, `${what}: no eager slot`);
    // A stub's own words (inStub) ride along where the clause names the uri's parts.
    assert.deepEqual({ error: refusal.error, remedy: refusal.remedy }, { error, remedy }, what);
    const out = await f.fetch(record);
    assert.equal(out.ok, false, what);
    assert.deepEqual({ error: out.error, remedy: out.remedy }, { error, remedy }, `${what}: the fetch answers what refusal() said`);
  }
  assert.equal([...hits.keys()].filter((k) => k.startsWith('/ok?case=')).length, 0, 'nothing dialed');
  // Null where the fetch serves a saved copy or dials, and the one it would dial takes an eager slot.
  const savedCopy = makeRecord(reg, `${ORIGIN}/ok?case=saved`, { expiresAt: '2001-01-01T00:00:00Z' }, 'stdio-srv');
  savedCopy.fetchedPath = 'scratch/refs/saved.bin';
  assert.equal(f.refusal(savedCopy), null);
  const dial = makeRecord(reg, `${ORIGIN}/ok?case=dial`, small, 'srv');
  assert.equal(f.refusal(dial), null);
  assert.equal(f.isEagerEligible(dial), true);
  // A saved copy of one the fetch would otherwise dial takes no eager slot either: the fetch serves it.
  const keptCopy = makeRecord(reg, `${ORIGIN}/ok?case=kept`, small, 'srv');
  keptCopy.fetchedPath = 'scratch/refs/kept.bin';
  assert.equal(f.refusal(keptCopy), null);
  assert.equal(f.isEagerEligible(keptCopy), false);
});

test('a reference with two faults is refused for the first the fetch checks: the server, then the expiry, a claim past the host\'s ceiling, the spent budget', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ 'stdio-srv': 'no-address', spent: { url: `ws://127.0.0.1:${port}`, autofetch: { maxTotalBytes: 0 } } });
  const past = '2001-01-01T00:00:00Z';
  const huge = 512 * 1024 * 1024;
  const cases: Array<[string, ReturnType<typeof makeRecord>, string]> = [
    ['no address, expired', makeRecord(reg, `${ORIGIN}/ok?two=1`, { expiresAt: past }, 'stdio-srv'), noAddressReason('stdio-srv')],
    ['no address, over the host ceiling', makeRecord(reg, `${ORIGIN}/ok?two=5`, { sizeBytes: huge }, 'stdio-srv'), noAddressReason('stdio-srv')],
    ['expired, budget spent, over the ceiling', makeRecord(reg, `${ORIGIN}/ok?two=2`, { expiresAt: past, sizeBytes: huge }, 'spent'), `the reference is ${EXPIRY_REASON.passed}`],
    // Nothing lifts the host's ceiling, so it comes before a budget whoever runs the host can raise.
    ['over the host ceiling, budget spent', makeRecord(reg, `${ORIGIN}/ok?two=3`, { sizeBytes: huge }, 'spent'), 'it claims 536870912 bytes, over the 268435456 bytes this host fetches at most'],
    ['budget spent, within the ceiling', makeRecord(reg, `${ORIGIN}/ok?two=4`, { sizeBytes: 1000 }, 'spent'), 'this host\'s fetch budget for the "spent" server is used up (0 of 0 bytes)'],
  ];
  for (const [what, record, error] of cases) {
    const refusal = f.refusal(record);
    assert.ok(refusal, what);
    assert.equal(refusal.error, error, what);
    assert.equal((await f.fetch(record)).error, error, what);
  }
});

test('refusal() answers nothing while a fetch of the record is under way, which the fetch would join', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const record = makeRecord(reg, `${ORIGIN}/ok?in-flight`, { sizeBytes: PAYLOAD.length }, 'srv');
  const fetching = f.fetch(record);
  // The fetch has made its checks; the record's claims change while it is under way.
  record.testimony = { ...record.testimony, expiresAt: '2001-01-01T00:00:00Z' };
  assert.equal(f.refusal(record), null, 'joined, not refused');
  const out = await fetching;
  assert.equal(out.ok, true, out.error);
});

test("a reference whose fetch is under way stays eager-eligible once that fetch has spent its server's budget, so the eager fetch joins it", async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  let saveStarted!: () => void;
  const saveCalled = new Promise<void>((resolve) => { saveStarted = resolve; });
  let releaseSave!: () => void;
  const saving = new Promise<void>((resolve) => { releaseSave = resolve; });
  // A budget of exactly one payload, and a save held open until released.
  const f = new ReferenceFetcher(
    (id) => (id === 'srv' ? { url: ORIGIN, autofetch: { maxTotalBytes: PAYLOAD.length } } : undefined),
    async (name) => { saveStarted(); await saving; return `scratch/refs/${name}`; },
  );
  // In the process-wide registry, where the eager pass registers a result's references.
  const uri = `${ORIGIN}/ok?join-after-budget`;
  const record = makeRecord(referenceRegistry, uri, { sizeBytes: PAYLOAD.length }, 'srv');
  assert.equal(f.isEagerEligible(record), true);
  const fetching = f.fetch(record);
  // Bounded by the fetch itself: one that ends before its save fails here, at once.
  await Promise.race([saveCalled, fetching.then((out) => Promise.reject(new Error(`the fetch ended before its save: ${JSON.stringify(out)}`)))]);
  // Its bytes are read, so the budget is spent, and its save hasn't landed.
  const another = makeRecord(referenceRegistry, `${ORIGIN}/ok?join-after-budget-other`, { sizeBytes: PAYLOAD.length }, 'srv');
  assert.equal(f.isEagerEligible(another), false, 'a new dial is refused for the spent budget');
  assert.equal(f.isEagerEligible(record), true, 'the fetch under way is joined');
  // An expiry the record now claims doesn't enter either: that fetch passed the expiry check when it began.
  const claimed = record.testimony;
  record.testimony = { ...claimed, expiresAt: '2001-01-01T00:00:00Z' };
  assert.equal(f.isEagerEligible(record), true, 'still joined');
  assert.equal(f.refusal(record), null);
  record.testimony = claimed;
  // A later tool result carrying the reference: the eager pass asks fetch() for it, and gets the fetch under way.
  const asked = t.mock.method(f, 'fetch');
  const eager = eagerFetch([{ type: 'resource', uri, sizeBytes: PAYLOAD.length }], f);
  assert.equal(asked.mock.callCount(), 1, 'the eager pass asked for the reference');
  assert.equal(asked.mock.calls[0].arguments[0], record);
  assert.equal(asked.mock.calls[0].result, fetching, 'and joined the fetch under way');
  releaseSave();
  const [out] = await Promise.all([fetching, eager]);
  assert.equal(out.ok, true, out.error);
  assert.equal(record.fetchedPath, out.path);
  assert.equal(hits.get('/ok?join-after-budget'), 1, 'dialed once');
  assert.equal(errors.mock.callCount(), 0, 'no eager failure logged');
  assert.equal(f.isEagerEligible(record), false, 'a saved copy takes no slot');
});

test('a fetch is charged to the budget of the server it dials, not of the first to deliver the uri', async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({
    relay: { url: 'https://relay.example.invalid' },
    owner: { url: `ws://127.0.0.1:${port}`, autofetch: { maxTotalBytes: PAYLOAD.length } },
  });
  const relayed = makeRecord(reg, `${ORIGIN}/ok?charged-relayed`, {}, 'relay');
  makeRecord(reg, `${ORIGIN}/ok?charged-relayed`, {}, 'owner');
  const first = await f.fetch(relayed);
  assert.equal(first.ok, true, first.error);
  // That spent the owner's budget, so its own next reference is refused for it.
  const next = await f.fetch(makeRecord(reg, `${ORIGIN}/ok?charged-own`, {}, 'owner'));
  assert.equal(next.error, `this host's fetch budget for the "owner" server is used up (${PAYLOAD.length} of ${PAYLOAD.length} bytes)`);
  assert.equal(hits.get('/ok?charged-own') ?? 0, 0, 'nothing dialed');
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

test("the fetcher's own clauses name a server by its id as a stub does, bounded and with its controls removed", async () => {
  const reg = new ReferenceRegistry();
  const id = `zz-\u202E${'x'.repeat(300)}`;
  const shown = shownServerId(id);
  // Bounded at 120 characters, its controls gone, cut with an ellipsis.
  assert.equal(shown, `zz-${'x'.repeat(116)}…`);
  // An answer's status, which every clause after dialing names the server in.
  const answered = await makeFetcher({ [id]: { url: `ws://127.0.0.1:${port}` } }).fetch(makeRecord(reg, `${ORIGIN}/status/503`, {}, id));
  assert.equal(answered.error, `the "${shown}" server answered HTTP 503`);
  // A spent budget, and a claim past what's left of one.
  const spent = await makeFetcher({ [id]: { url: `ws://127.0.0.1:${port}`, autofetch: { maxTotalBytes: 0 } } })
    .fetch(makeRecord(reg, `${ORIGIN}/ok?shown-id-spent`, {}, id));
  assert.equal(spent.error, `this host's fetch budget for the "${shown}" server is used up (0 of 0 bytes)`);
  const claimed = await makeFetcher({ [id]: { url: `ws://127.0.0.1:${port}`, autofetch: { maxTotalBytes: 1000 } } })
    .fetch(makeRecord(reg, `${ORIGIN}/ok?shown-id-claim`, { sizeBytes: 2000 }, id), { maxBytes: 1500 });
  assert.equal(claimed.error, `it claims 2000 bytes, more than the 1000 bytes left of this host's fetch budget for the "${shown}" server`);
  for (const error of [answered.error, spent.error, claimed.error]) {
    assert.ok(!error!.includes('\u202E') && !error!.includes('x'.repeat(200)), error);
  }
});

test("each HTTP status says what calling again can do: later, a fresh reference, the host's credentials, or nothing", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN } });
  const expect: Array<[number, string]> = [
    // Passing trouble, which can clear.
    [408, TRY_LATER], [429, TRY_LATER], [500, TRY_LATER], [503, TRY_LATER],
    // A conflict or a lock the server's state can clear, and a request it calls too early.
    [409, TRY_LATER], [423, TRY_LATER], [425, TRY_LATER],
    // The server doesn't support the request, which later won't change.
    [501, NOTHING_TO_DO], [505, NOTHING_TO_DO],
    // This host's credentials for the server, which a fresh reference keeps.
    [401, "Calling again won't change that; whoever runs this host can check its credentials for the server."],
    [403, "Once a fresh reference to it arrives, fetching may work; if that's refused too, whoever runs this host can check its credentials for the server."],
    // About this reference, which a fresh one may not share.
    [404, FRESH_REFERENCE], [410, FRESH_REFERENCE],
  ];
  for (const [status, remedy] of expect) {
    const out = await f.fetch(makeRecord(reg, `${ORIGIN}/status/${status}`));
    assert.equal(out.error, `the "srv" server answered HTTP ${status}`, String(status));
    assert.equal(out.remedy, remedy, String(status));
  }
  // A success with no body at all.
  const empty = await f.fetch(makeRecord(reg, `${ORIGIN}/status/204`));
  assert.equal(empty.error, 'the "srv" server answered without any content');
  assert.equal(empty.remedy, FRESH_REFERENCE);
});

test('a fetch that meets no listener says the request failed, with its cause, and that a later try may work', async (t) => {
  const reg = new ReferenceRegistry();
  // A port just freed refuses: fetch's "fetch failed" carries the refusal as its cause.
  const freed = createServer();
  await new Promise<void>((r) => freed.listen(0, '127.0.0.1', r));
  const deadPort = (freed.address() as { port: number }).port;
  await new Promise<void>((r) => freed.close(() => r()));
  const f = makeFetcher({ dead: { url: `ws://127.0.0.1:${deadPort}` } });
  const out = await f.fetch(makeRecord(reg, `http://127.0.0.1:${deadPort}/x`, {}, 'dead'));
  assert.equal(out.error, `the request to the "dead" server failed: connect ECONNREFUSED 127.0.0.1:${deadPort}`);
  assert.equal(out.remedy, REQUEST_FAILED);
  // A host with several addresses is refused at each, and its cause, an
  // AggregateError, has no words of its own: each attempt's stand in.
  t.mock.method(globalThis, 'fetch', async () => {
    const attempts = [new Error('connect ECONNREFUSED ::1:4321'), new Error('connect ECONNREFUSED 127.0.0.1:4321')];
    throw new TypeError('fetch failed', { cause: Object.assign(new AggregateError(attempts), { code: 'ECONNREFUSED' }) });
  });
  const both = await makeFetcher({ dual: { url: 'ws://dual.example.invalid:4321' } })
    .fetch(makeRecord(reg, 'http://dual.example.invalid:4321/x', {}, 'dual'));
  assert.equal(both.error, 'the request to the "dual" server failed: connect ECONNREFUSED ::1:4321; connect ECONNREFUSED 127.0.0.1:4321');
  assert.equal(both.remedy, REQUEST_FAILED);
});

test("a save that throws is the workspace's failure, logged for whoever runs the host, not the fetch's", async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const reg = new ReferenceRegistry();
  // Its words take one line of the log, bounded as the agent's text would be.
  const f = new ReferenceFetcher(() => ({ url: ORIGIN }), async () => { throw new Error(`disk on fire\n${'x'.repeat(300)}`); });
  const rec = makeRecord(reg, `${ORIGIN}/ok?save-throws`);
  const out = await f.fetch(rec);
  assert.equal(out.error, "it was fetched, but this host couldn't store it in its workspace, so nothing was kept");
  assert.equal(out.remedy, 'Calling again is likely to fail the same way; whoever runs this host can see why in its log.');
  assert.deepEqual(errors.mock.calls.map((c) => String(c.arguments[0])), [`[refs] couldn't store ${rec.refId}.wav: disk on fire?${'x'.repeat(187)}…`]);
  assert.equal(rec.fetchedPath, undefined);
});

test("a payload fetched but not stored says so, and the host's log says why: no workspace, no writable mount, or the write's error", async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  type Answer = { result: { success: boolean; error?: string } };
  const cases: Array<[string, Record<string, unknown>, (file: string) => string]> = [
    ['no workspace', { getWorkspaceModule: () => undefined }, (file) => `[refs] couldn't store ${file}: this host has no workspace`],
    ['no writable mount', { getWorkspaceModule: () => ({}), firstWritableMountName: () => null },
      (file) => `[refs] couldn't store ${file}: no workspace mount is writable`],
    ['a failed write', {
      getWorkspaceModule: () => ({ writeBinary: async () => ({ success: false, error: 'EROFS: read-only file system' }) }),
      firstWritableMountName: () => 'scratch',
    }, (file) => `[refs] couldn't store scratch/refs/${file}: EROFS: read-only file system`],
  ];
  for (const [what, workspace, logLine] of cases) {
    // The framework's own fetcher and save hook, with this file's server as an MCPL server's address.
    const framework = Object.create(AgentFramework.prototype) as {
      pushEvent(event: unknown): void;
      dispatchFetchReferenceToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
    };
    Object.assign(framework, {
      mcplServerConfigs: new Map([['srv', { id: 'srv', url: `ws://127.0.0.1:${port}` }]]),
      emitTrace: () => {},
      ...workspace,
    });
    // Bytes no sniffer knows, with no type, so the file is saved as .bin.
    const record = makeRecord(referenceRegistry, `${ORIGIN}/untyped?unstored=${encodeURIComponent(what)}`);
    const answered = new Promise<Answer>((resolve) => { framework.pushEvent = (event) => resolve(event as Answer); });
    framework.dispatchFetchReferenceToolCall('prime', { id: `call_${what}`, name: 'fetch_reference', input: { ref_id: record.refId } });
    const { result } = await answered;
    assert.equal(result.error, `fetch_reference couldn't fetch "${record.refId}": it was fetched, but this host couldn't store it in its workspace, `
      + 'so nothing was kept. Calling again is likely to fail the same way; whoever runs this host can see why in its log.', what);
    const logged = errors.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(logged.includes(logLine(`${record.refId}.bin`)), `${what}: ${logged.join('\n')}`);
  }
});

test("an address that doesn't parse is refused before anything is dialed: the reference's, or the server's, each saying which", async () => {
  const reg = new ReferenceRegistry();
  const bad = await makeFetcher({ srv: { url: ORIGIN } }).fetch(makeRecord(reg, 'not a url at all'));
  assert.equal(bad.error, "its address doesn't parse as a URL");
  assert.equal(bad.remedy, NOTHING_TO_DO);
  const misconfigured = await makeFetcher({ srv: { url: 'not a url either' } }).fetch(makeRecord(reg, `${ORIGIN}/ok?misconfigured`));
  assert.equal(misconfigured.error, "the \"srv\" server's address doesn't parse as a URL, so there's nowhere to fetch it from");
  assert.equal(misconfigured.remedy, "Calling again won't change that unless whoever runs this host corrects the server's address.");
  assert.equal(hits.get('/ok?misconfigured') ?? 0, 0, 'nothing dialed');
});

test("past what's left of the server's budget, a download stopped at max_bytes is told the budget is the limit", async () => {
  const reg = new ReferenceRegistry();
  const f = makeFetcher({ srv: { url: ORIGIN, autofetch: { maxTotalBytes: 1500 } } });
  // 1200 bytes arrive before the pause: past max_bytes, within the budget,
  // which then has less left than what's known of the payload.
  const out = await f.fetch(makeRecord(reg, `${ORIGIN}/drip?first=1200&rest=5000&wait=10000`), { maxBytes: 1000 });
  const [, received] = /^the download had reached (\d+) bytes, past the 1000 bytes this call allows, so it was stopped and nothing was kept$/.exec(out.error!) ?? [];
  assert.ok(received, out.error);
  assert.ok(Number(received) > 1000 && Number(received) <= 1200, received);
  assert.equal(out.remedy,
    `It's at least ${received} bytes, more than the ${1500 - Number(received)} bytes left of this host's fetch budget for the "srv" server. ${BUDGET}`);
});
