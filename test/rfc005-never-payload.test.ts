import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, WorkspaceModule } from '../src/index.js';
import type { ToolCall, ToolResult } from '../src/index.js';
import { convertBlock } from '../src/mcpl/convert-block.js';
import { ReferenceFetcher } from '../src/mcpl/reference-fetcher.js';
import * as references from '../src/mcpl/references.js';
import {
  ReferenceRegistry, buildReferenceStub, classifyBlock, contentClaims, referenceBlockForScript,
  referenceRegistry, shownLinkUri, unfetchableReason,
} from '../src/mcpl/references.js';
import type { ReferenceRecord, ReferenceTestimony } from '../src/mcpl/references.js';
import type { McplContentBlock } from '../src/mcpl/types.js';
import { scriptViewClaims } from '../src/tool-result-history.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const PAYLOAD = Buffer.from('RIFF-zz-never-payload-'.repeat(20));

let served = 0;
const held: Array<{ more(): void; end(): void; closed: Promise<void> }> = [];
let heard: (() => void) | undefined;
const server = createServer((req, res) => {
  served++;
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/ok') {
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.end(PAYLOAD);
  } else if (url.pathname === '/hold' || url.pathname === '/trickle') {
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.write(url.pathname === '/hold' ? PAYLOAD : PAYLOAD.subarray(0, 16));
    const closed = new Promise<void>((resolve) => res.on('close', () => resolve()));
    held.push({ more: () => res.write(PAYLOAD.subarray(16, 32)), end: () => res.end(), closed });
    heard?.();
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const ORIGIN = `http://127.0.0.1:${port}`;
const BINDING = { url: `ws://127.0.0.1:${port}` };
after(() => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
}));

function testimonyOf(block: Record<string, unknown>): ReferenceTestimony {
  const c = classifyBlock(block);
  assert.equal(c.kind, 'reference', JSON.stringify(block));
  return (c as { testimony: ReferenceTestimony }).testimony;
}
const uniq = (name: string) => `https://zz-never.example/${randomUUID()}/${name}`;
const inlineNever = (uri: string) => ({ type: 'image', uri, data: 'aGk=', mimeType: 'image/png', disposition: 'never' });
const NEVER_TEXT = 'a server asked that its content never reach you or your tools';
const NEVER_FAILURE = { ok: false, error: NEVER_TEXT, remedy: "Calling again won't change that." };
const NEVER_REFUSAL = { error: NEVER_FAILURE.error, remedy: NEVER_FAILURE.remedy };
const within = <T>(what: string, promise: Promise<T>, ms = 5_000): Promise<T> => Promise.race([
  promise,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: not settled within ${ms} ms`)), ms).unref()),
]);
const quietly = async <T>(fn: () => T | Promise<T>): Promise<{ value: T; logged: string }> => {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), logged: lines.join('\n') };
  } finally {
    console.error = error;
  }
};

it('says why a marked payload is kept from the agent, in the words the fetch, the stub and the script share', () => {
  assert.deepEqual({ ...(references as Record<string, unknown>).PAYLOAD_NEVER as object }, NEVER_REFUSAL);
});

describe('the payload mark', () => {
  it('is made by a `never` and kept through a later plain delivery from another server, whose testimony the record then holds', () => {
    const reg = new ReferenceRegistry();
    const uri = uniq('a.bin');
    const record = reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'one');
    assert.equal(record.payloadNever, true);
    assert.equal(reg.register(testimonyOf({ type: 'resource', uri, name: 'plain' }), 'two'), record);
    assert.equal(record.payloadNever, true);
    assert.deepEqual([record.testimony.name, record.testimony.disposition], ['plain', undefined]);
    assert.equal(reg.register(testimonyOf({ type: 'resource', uri: uniq('b.bin'), disposition: 'ref' }), 'one').payloadNever, undefined);
    assert.equal(reg.register(testimonyOf({ type: 'resource', uri: uniq('c.bin') }), 'one').payloadNever, undefined);
  });

  it('clears a copy saved before it, once, naming in the log where the copy stays, and refreshes the testimony', async () => {
    const reg = new ReferenceRegistry();
    const uri = uniq('d.wav');
    const record = reg.register(testimonyOf({ type: 'resource', uri, name: 'first' }), 'one');
    Object.assign(record, { fetchedPath: 'scratch/refs/d.wav', verifiedBytes: 3, verifiedMimeType: 'audio/wav', digestVerified: true });
    const marked = await quietly(() => reg.register(testimonyOf({ type: 'resource', uri, name: 'second', disposition: 'never' }), 'one'));
    assert.deepEqual(
      [record.payloadNever, record.fetchedPath, record.verifiedBytes, record.verifiedMimeType, record.digestVerified],
      [true, undefined, undefined, undefined, undefined],
    );
    assert.deepEqual([record.testimony.name, record.testimony.disposition], ['second', 'never']);
    assert.equal(marked.logged, `[refs] a server marked ${record.refId}'s payload never (RFC-005) after it was saved: its copy stays at scratch/refs/d.wav, where the agent's workspace tools can still find it; no stub, script object or fetch names it from here on`);
    record.fetchedPath = 'scratch/refs/d-again.wav';
    const again = await quietly(() => {
      reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'one');
      reg.markNevers(contentClaims([inlineNever(uri)]));
    });
    assert.deepEqual([record.fetchedPath, again.logged], ['scratch/refs/d-again.wav', '']);
    const bare = await quietly(() => reg.register(testimonyOf({ type: 'resource', uri: uniq('e.wav'), disposition: 'never' }), 'one'));
    assert.deepEqual([bare.value.payloadNever, bare.logged], [true, '']);
  });

  it("is made by the result's claims for a plain reference, inline data's `never` before it included", () => {
    const reg = new ReferenceRegistry();
    const uri = uniq('g.png');
    const blocks = [inlineNever(uri), { type: 'resource', uri, name: 'g.png' }];
    assert.equal(reg.register(testimonyOf(blocks[1]!), 'one', contentClaims(blocks)).payloadNever, true);
    assert.equal(reg.register(testimonyOf({ type: 'resource', uri: uniq('h.png') }), 'one', contentClaims(blocks)).payloadNever, undefined);
  });

  it("is made by inline data's `never` for the record its uri has wherever the block is read, a later walk of an older result's block included, and makes no record", () => {
    const uri = uniq('j.png');
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri }), 'one');
    classifyBlock(inlineNever(uri));
    assert.equal(record.payloadNever, true);
    const later = uniq('ja.png');
    classifyBlock(inlineNever(later));
    assert.equal(referenceRegistry.findByUri(later), undefined);
    const made = referenceRegistry.register(testimonyOf({ type: 'resource', uri: later }), 'one');
    assert.equal(made.payloadNever, undefined);
    classifyBlock(inlineNever(later));
    assert.equal(made.payloadNever, true);
    const other = uniq('k.wav');
    const plain = referenceRegistry.register(testimonyOf({ type: 'resource', uri: other }), 'one');
    classifyBlock({ type: 'audio', uri: other, data: 'aGk=', mimeType: 'audio/wav', disposition: 'ref' });
    assert.equal(plain.payloadNever, undefined);
  });

  it("is made by an embedded resource's `never` for the record its resource's uri already has, wherever the block is read, and makes no record", () => {
    const uri = uniq('embedded.txt');
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri }), 'one');
    const embedded = { type: 'resource', disposition: 'never', resource: { uri, text: 'the payload', mimeType: 'text/plain' } };
    assert.equal(classifyBlock(embedded).kind, 'embedded');
    assert.equal(record.payloadNever, true);
    const other = uniq('embedded-plain.txt');
    const plain = referenceRegistry.register(testimonyOf({ type: 'resource', uri: other }), 'one');
    classifyBlock({ type: 'resource', resource: { uri: other, text: 'the payload' } });
    classifyBlock({ type: 'resource', disposition: 'ref', resource: { uri: other, text: 'the payload' } });
    const absent = uniq('embedded-absent.txt');
    classifyBlock({ type: 'resource', disposition: 'never', resource: { uri: absent, text: 'the payload' } });
    assert.deepEqual([plain.payloadNever, referenceRegistry.findByUri(absent)], [undefined, undefined]);
  });

  it("is made by a `never` its claims hold for a record a uri already has, for a result nothing else reads, and by no other claim (markNevers)", () => {
    const reg = new ReferenceRegistry();
    const uri = uniq('jb.pdf');
    const record = reg.register(testimonyOf({ type: 'resource', uri }), 'one');
    const claimed = contentClaims([{ type: 'resource', uri, expiresAt: '2000-01-01T00:00:00Z' }]);
    assert.ok(claimed.has(uri), 'the result claims something for the uri');
    reg.markNevers(claimed);
    assert.equal(record.payloadNever, undefined);
    reg.markNevers(contentClaims([{ type: 'resource', uri, disposition: 'never' }]));
    assert.equal(record.payloadNever, true);
    const absent = uniq('i.png');
    reg.markNevers(contentClaims([{ type: 'resource', uri: absent, disposition: 'never' }]));
    assert.equal(reg.findByUri(absent), undefined);
  });

  it('goes with its record when the record is evicted', () => {
    const reg = new ReferenceRegistry();
    const uri = uniq('l.bin');
    reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'one');
    for (let i = 0; i < 2000; i++) reg.register(testimonyOf({ type: 'resource', uri: `https://zz-never.example/fill/${i}` }));
    assert.equal(reg.findByUri(uri), undefined);
    assert.equal(reg.register(testimonyOf({ type: 'resource', uri }), 'one').payloadNever, undefined);
  });
});

describe('what a marked record shows', () => {
  const HOST = {};
  referenceRegistry.setServerAddress('zz-never-dialed', { url: 'wss://zz-never.example' }, HOST);

  it('a stub, for its `never` block and a plain one alike: no saved copy, no fetch hint, the reason', () => {
    const uri = uniq('m.wav');
    const first = buildReferenceStub(testimonyOf({ type: 'resource', uri, name: 'm.wav', disposition: 'never' }), 'from tool zz', 'zz-never-dialed');
    const record = referenceRegistry.findByUri(uri)!;
    record.fetchedPath = 'scratch/refs/m.wav';
    const later = buildReferenceStub(testimonyOf({ type: 'resource', uri, name: 'm.wav' }), 'from tool zz', 'zz-never-dialed');
    for (const stub of [first, later]) assert.equal(stub, `[${record.refId}] m.wav — from tool zz — ${NEVER_TEXT}`);
    assert.equal(unfetchableReason(record), NEVER_TEXT);
    const control = buildReferenceStub(testimonyOf({ type: 'resource', uri: uniq('n.wav'), name: 'n.wav' }), 'from tool zz', 'zz-never-dialed');
    assert.ok(control.endsWith('— from tool zz — fetch with fetch_reference'), control);
  });

  it("a stub and a script's object marked by their result's claims, inline data's `never` before the reference included", () => {
    const [stubbed, scripted] = [uniq('v.wav'), uniq('w.wav')];
    const stub = buildReferenceStub(testimonyOf({ type: 'resource', uri: stubbed, name: 'v.wav' }), 'from tool result', undefined,
      { claims: contentClaims([inlineNever(stubbed), { type: 'resource', uri: stubbed }]) });
    const record = referenceRegistry.findByUri(stubbed)!;
    assert.deepEqual([record.payloadNever, stub], [true, `[${record.refId}] v.wav — from tool result — ${NEVER_TEXT}`]);
    const object = referenceBlockForScript({ type: 'resource', uri: scripted, name: 'w.wav' }, undefined,
      contentClaims([inlineNever(scripted), { type: 'resource', uri: scripted }])) as Record<string, unknown>;
    assert.deepEqual([referenceRegistry.findByUri(scripted)?.payloadNever, object.unfetchable], [true, NEVER_TEXT]);
  });

  it("a script's object: no saved path and no uri, and why", () => {
    const uri = uniq('o.pdf');
    referenceRegistry.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'zz-never-dialed').fetchedPath = 'scratch/refs/o.pdf';
    const object = referenceBlockForScript({ type: 'resource', uri, name: 'o.pdf' }, 'zz-never-dialed') as Record<string, unknown>;
    assert.deepEqual([object.savedTo, object.unfetchable, 'uri' in object], [null, NEVER_TEXT, false]);
    const link = referenceBlockForScript({ type: 'resource_link', uri, name: 'o.pdf' }) as Record<string, unknown>;
    assert.deepEqual([link.savedTo, link.unfetchable, 'uri' in link], [null, NEVER_TEXT, false]);
  });

  it("a script's link: no uri where another lane marked its payload after the script lane began, though the line's record, as it stood, shows it", () => {
    const uri = uniq('x.txt');
    const link = { type: 'resource_link', uri, name: 'x.txt' };
    referenceRegistry.register(testimonyOf(link));
    const journal = referenceRegistry.openJournal();
    try {
      referenceRegistry.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }));
      referenceRegistry.register(testimonyOf({ type: 'resource', uri }));
      const claims = contentClaims([link]);
      assert.equal(shownLinkUri(testimonyOf(link), journal.before(uri)!, Date.now(), claims), uri, "the line's record shows the uri");
      const object = referenceBlockForScript(link, undefined, claims, { claims, recordBefore: journal.before }) as Record<string, unknown>;
      assert.deepEqual(['uri' in object, object.unfetchable], [false, NEVER_TEXT]);
    } finally {
      journal.close();
    }
  });

  it("a link: no uri, whatever later testimony says, where an unmarked link the host can't fetch shows it", () => {
    const shown = uniq('p.txt');
    const plainLink = testimonyOf({ type: 'resource_link', uri: shown, name: 'p.txt' });
    assert.equal(shownLinkUri(plainLink, referenceRegistry.register(plainLink)), shown);
    const marked = uniq('q.txt');
    referenceRegistry.register(testimonyOf({ type: 'resource', uri: marked, disposition: 'never' }));
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri: marked }));
    const markedLink = testimonyOf({ type: 'resource_link', uri: marked, name: 'q.txt' });
    assert.equal(referenceRegistry.register(markedLink), record);
    assert.equal(shownLinkUri(markedLink, record), null);
    const line = buildReferenceStub(markedLink, 'from tool result', undefined, { unfetchedLinkUri: true });
    assert.equal(line, `[${record.refId}] q.txt — from tool result — ${NEVER_TEXT}`);
  });

  it('on a push, channel or injection lane: an image by uri alone is its stub, not a uri for the provider to fetch, and inline data marks the record its uri has', () => {
    const marked = uniq('y.png');
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri: marked, disposition: 'never' }), 'zz-never-dialed');
    assert.deepEqual(convertBlock({ type: 'image', uri: marked } as McplContentBlock, 'attachment on push event', 'zz-never-dialed'),
      { type: 'text', text: `[${record.refId}] attachment on push event — ${NEVER_TEXT}` });
    const plain = uniq('z.png');
    assert.deepEqual(convertBlock({ type: 'image', uri: plain } as McplContentBlock, 'attachment on push event', 'zz-never-dialed'),
      { type: 'image', source: { type: 'url', url: plain } });
    for (const type of ['image', 'audio']) {
      const later = uniq(`za-${type}`);
      const existing = referenceRegistry.register(testimonyOf({ type: 'resource', uri: later }), 'zz-never-dialed');
      const shown = convertBlock({ type, uri: later, data: 'aGk=', mimeType: `${type}/x-zz`, disposition: 'never' } as McplContentBlock, 'attachment on push event', 'zz-never-dialed');
      assert.equal(shown.type, 'text', type);
      assert.equal(existing.payloadNever, true, type);
    }
  });
});

describe('a fetcher built to withhold', () => {
  const fetcher = (opts: { saved?: string[]; removed?: string[]; onSave?: () => void } = {}) => new ReferenceFetcher(
    () => BINDING,
    async (name) => { opts.onSave?.(); opts.saved?.push(name); return `scratch/refs/${name}`; },
    { remove: async (path) => { opts.removed?.push(path); } },
  );

  it('refuses a marked payload before anything else: no request, nothing saved, a saved copy neither served nor offered', async () => {
    const reg = new ReferenceRegistry();
    const saved: string[] = [];
    const removed: string[] = [];
    const f = fetcher({ saved, removed });
    const record = reg.register(testimonyOf({ type: 'resource', uri: `${ORIGIN}/ok?marked-${randomUUID()}`, sizeBytes: 10, disposition: 'never' }), 'srv');
    const before = served;
    assert.equal(f.isEagerEligible(record), false);
    assert.deepEqual(f.refusal(record), NEVER_REFUSAL);
    assert.deepEqual(await f.fetch(record), NEVER_FAILURE);
    record.fetchedPath = 'scratch/refs/kept.wav';
    assert.deepEqual(f.refusal(record), NEVER_REFUSAL);
    assert.deepEqual(await f.fetch(record), NEVER_FAILURE);
    assert.deepEqual([served, saved, removed], [before, [], []]);
    const plain = reg.register(testimonyOf({ type: 'resource', uri: `${ORIGIN}/ok?plain-${randomUUID()}`, sizeBytes: 10 }), 'srv');
    assert.deepEqual([f.isEagerEligible(plain), f.refusal(plain)], [true, null]);
    assert.equal((await f.fetch(plain)).ok, true);
    assert.equal(saved.length, 1);
  });

  it('is the one built with it: without it, a `never` reference is fetched and saved, as RFC-005 vector 03 expects', async () => {
    const reg = new ReferenceRegistry();
    const record = reg.register(testimonyOf({ type: 'resource', uri: `${ORIGIN}/ok?vector03-${randomUUID()}`, disposition: 'never' }), 'srv');
    const plain = new ReferenceFetcher(() => BINDING, async (name) => `scratch/refs/${name}`);
    assert.equal(record.payloadNever, true);
    assert.equal(plain.refusal(record), null);
    const out = await plain.fetch(record);
    assert.deepEqual([out.ok, out.bytes, record.fetchedPath], [true, PAYLOAD.length, out.path]);
  });

  it('stops a download a `never` marks partway, at its next part, and keeps nothing', async () => {
    const reg = new ReferenceRegistry();
    const saved: string[] = [];
    const f = fetcher({ saved });
    const uri = `${ORIGIN}/trickle?${randomUUID()}`;
    const record = reg.register(testimonyOf({ type: 'resource', uri }), 'srv');
    const arrived = new Promise<void>((resolve) => { heard = resolve; });
    const running = f.fetch(record);
    await within('the request reaching the server', arrived);
    const response = held.shift()!;
    try {
      reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'srv');
      response.more();
      assert.deepEqual(await within('the marked download', running), NEVER_FAILURE);
      assert.deepEqual([saved, record.fetchedPath], [[], undefined]);
      await within('the request closed by the fetcher', response.closed);
    } finally {
      response.end();
    }
  });

  it("saves nothing for a payload a `never` marks after its last part, and answers each caller's wait with the mark, whatever the flight's own ending", async () => {
    const reg = new ReferenceRegistry();
    const saved: string[] = [];
    const removed: string[] = [];
    const f = fetcher({ saved, removed });
    const uri = `${ORIGIN}/hold?${randomUUID()}`;
    const record = reg.register(testimonyOf({ type: 'resource', uri }), 'srv');
    const arrived = new Promise<void>((resolve) => { heard = resolve; });
    const running = f.fetch(record);
    await within('the request reaching the server', arrived);
    const response = held.shift()!;
    try {
      const charged = () => (f as unknown as { totals: Map<string, number> }).totals.get('srv') ?? 0;
      await within('the whole payload read', (async () => { while (charged() < PAYLOAD.length) await new Promise((resolve) => setTimeout(resolve, 5)); })());
      const joined = f.fetch(record, { timeoutMs: 50 });
      reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'srv');
      assert.deepEqual(f.refusal(record), NEVER_REFUSAL, 'refused while its fetch is under way');
      const asked = f.fetch(record);
      const first = await Promise.race([asked, new Promise((resolve) => setImmediate(() => resolve('still waiting')))]);
      assert.deepEqual(first, NEVER_FAILURE);
      assert.deepEqual(await within('the joined fetch', joined), NEVER_FAILURE);
    } finally {
      response.end();
    }
    assert.deepEqual(await within('the marked download', running), NEVER_FAILURE);
    assert.deepEqual([saved, removed, record.fetchedPath], [[], [], undefined]);
  });

  it('removes a copy whose payload a `never` marks while it is saved, and refuses', async () => {
    const reg = new ReferenceRegistry();
    const uri = `${ORIGIN}/ok?saving-${randomUUID()}`;
    const record = reg.register(testimonyOf({ type: 'resource', uri }), 'srv');
    const removed: string[] = [];
    const f = fetcher({ removed, onSave: () => reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'srv') });
    assert.deepEqual(await f.fetch(record), NEVER_FAILURE);
    assert.deepEqual([removed, record.fetchedPath], [[`scratch/refs/${record.refId}.wav`], undefined]);
  });

  it('refuses when removing a copy a `never` marked during its save fails, and the log says where the copy is', async () => {
    const reg = new ReferenceRegistry();
    const uri = `${ORIGIN}/ok?unremoved-${randomUUID()}`;
    const record = reg.register(testimonyOf({ type: 'resource', uri }), 'srv');
    const f = new ReferenceFetcher(
      () => BINDING,
      async (name) => { reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'srv'); return `scratch/refs/${name}`; },
      { remove: async () => { throw new Error('zz-remove-threw'); } },
    );
    const { value, logged } = await quietly(() => f.fetch(record));
    assert.deepEqual(value, NEVER_FAILURE);
    assert.equal(record.fetchedPath, undefined);
    assert.ok(logged.includes(`couldn't remove scratch/refs/${record.refId}.wav, the copy of ${record.refId}, whose payload a server marked never (RFC-005), `
      + "so the agent's tools may still open it until it's deleted: zz-remove-threw"), logged);
  });
});

describe("the framework's fetches", () => {
  type Fw = {
    autoFetchReferences(content: unknown[], serverId: string, mode: 'register' | 'model' | 'script', claims?: unknown): Promise<void>;
    scriptResultAnswer(result: ToolResult, toolName: string, toServer: boolean): Promise<unknown>;
    getReferenceFetcher(): unknown;
  };
  const framework = (fetched: string[]) => {
    const fw = Object.create(AgentFramework.prototype) as Fw;
    const fetch = async (record: ReferenceRecord) => {
      if (record.fetchedPath) return { ok: true, path: record.fetchedPath };
      fetched.push(record.testimony.uri);
      if (record.payloadNever) return NEVER_FAILURE;
      record.fetchedPath = `scratch/refs/${record.refId}.bin`;
      return { ok: true, path: record.fetchedPath };
    };
    fw.getReferenceFetcher = () => ({ isEagerEligible: () => true, fetch, fetchEager: fetch });
    return fw;
  };
  const result = (reversed: boolean) => {
    const [never, inline, earlier, plain] = [uniq('r.bin'), uniq('s.png'), uniq('sa.png'), uniq('t.bin')];
    const existing = referenceRegistry.register(testimonyOf({ type: 'resource', uri: earlier }), 'zz-never-dialed');
    const blocks = [
      { type: 'resource', uri: never, disposition: 'never' },
      inlineNever(inline),
      { type: 'resource', uri: inline },
      inlineNever(earlier),
      { type: 'resource', uri: plain },
    ];
    return { uris: { never, inline, plain }, existing, blocks: reversed ? blocks.reverse() : blocks };
  };

  for (const reversed of [false, true]) {
    const order = reversed ? 'reversed' : 'in order';
    for (const mode of ['model', 'script'] as const) {
      it(`pass over a marked payload in ${mode} mode, with the blocks ${order}`, async () => {
        const fetched: string[] = [];
        const { uris, existing, blocks } = result(reversed);
        await framework(fetched).autoFetchReferences(blocks, 'zz-never-dialed', mode);
        assert.deepEqual(fetched, [uris.plain]);
        assert.deepEqual([uris.never, uris.inline, uris.plain].map((u) => referenceRegistry.findByUri(u)?.payloadNever), [true, true, undefined]);
        assert.equal(existing.payloadNever, true);
      });
    }

    it(`pass over a marked payload in a module's result a script reads, with the blocks ${order}`, async () => {
      const fetched: string[] = [];
      const { uris, existing, blocks } = result(reversed);
      await framework(fetched).scriptResultAnswer({ success: true, data: blocks, dataIsContent: true }, 'zz_tool', false);
      assert.deepEqual(fetched, [uris.plain]);
      assert.equal(existing.payloadNever, true);
    });
  }

  for (const pass of ['the script demand', "a module's demand loop"] as const) {
    it(`mark the record a \`never\` reference names before awaiting any fetch, in ${pass}, so a fetch of it meanwhile is refused`, async () => {
      const fw = Object.create(AgentFramework.prototype) as Fw;
      const [slow, vetoed] = [uniq('slow.bin'), uniq('vetoed.bin')];
      const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri: vetoed }), 'zz-never-dialed');
      record.fetchedPath = `scratch/refs/${record.refId}.bin`;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let downloading!: () => void;
      const started = new Promise<void>((resolve) => { downloading = resolve; });
      const fetch = async (r: ReferenceRecord) => {
        if (r.testimony.uri !== slow) return r.payloadNever ? NEVER_FAILURE : { ok: true, path: r.fetchedPath };
        downloading();
        await gate;
        return { ok: true, path: 'scratch/refs/slow.bin' };
      };
      fw.getReferenceFetcher = () => ({ isEagerEligible: () => false, fetch, fetchEager: fetch });
      const real = new ReferenceFetcher(() => BINDING, async (name) => `scratch/refs/${name}`, { remove: async () => {} });
      let answering: Promise<unknown>;
      if (pass === 'the script demand') {
        const content = [{ type: 'resource', uri: slow }, { type: 'text', text: 'one attachment', attachment: { type: 'resource', uri: vetoed, disposition: 'never' } }];
        answering = fw.autoFetchReferences(content, 'zz-never-dialed', 'script', scriptViewClaims(content, true));
      } else {
        answering = fw.scriptResultAnswer({ success: true, data: [{ type: 'resource', uri: slow }, { type: 'resource', uri: vetoed, disposition: 'never' }], dataIsContent: true }, 'zz_tool', false);
      }
      try {
        await within('the slow download starting', started);
        assert.deepEqual(await real.fetch(record), NEVER_FAILURE);
      } finally {
        release();
        await answering;
      }
    });
  }

  for (const mode of ['model', 'script'] as const) {
    it(`pass over a top-level reference a \`never\` nested in another block names, in ${mode} mode, as a script's view would`, async () => {
      const fetched: string[] = [];
      const uri = uniq('nested-veto.bin');
      const content = [{ type: 'resource', uri }, { type: 'text', text: 'one attachment', attachment: { type: 'resource', uri, disposition: 'never' } }];
      await framework(fetched).autoFetchReferences(content, 'zz-never-dialed', mode);
      assert.deepEqual([fetched, referenceRegistry.findByUri(uri)?.payloadNever], [[], true]);
    });
  }

  it('log no failure for a record a `never` marks while they run', async () => {
    const fw = Object.create(AgentFramework.prototype) as Fw;
    const fetch = async (record: ReferenceRecord) => {
      referenceRegistry.markNevers(contentClaims([inlineNever(record.testimony.uri)]));
      return NEVER_FAILURE;
    };
    fw.getReferenceFetcher = () => ({ isEagerEligible: () => true, fetch, fetchEager: fetch });
    const [eager, module] = [uniq('mid-eager.bin'), uniq('mid-module.bin')];
    const { logged } = await quietly(async () => {
      await fw.autoFetchReferences([{ type: 'resource', uri: eager }], 'zz-never-dialed', 'script');
      await fw.scriptResultAnswer({ success: true, data: [{ type: 'resource', uri: module }], dataIsContent: true }, 'zz_tool', false);
    });
    assert.deepEqual([eager, module].map((u) => referenceRegistry.findByUri(u)?.payloadNever), [true, true]);
    assert.equal(logged, '');
  });

  it('are made by a fetcher that withholds', () => {
    const fw = Object.create(AgentFramework.prototype) as {
      mcplServerConfigs: Map<string, unknown>;
      getReferenceFetcher(): ReferenceFetcher;
    };
    fw.mcplServerConfigs = new Map();
    const marked = referenceRegistry.register(testimonyOf({ type: 'resource', uri: uniq('u.bin'), disposition: 'never' }), 'zz-never-dialed');
    assert.deepEqual(fw.getReferenceFetcher().refusal(marked), NEVER_REFUSAL);
  });
});

describe("the framework's fetcher", () => {
  type Fw = {
    mcplServerConfigs: Map<string, unknown>;
    getWorkspaceModule(): unknown;
    firstWritableMountName(workspace: unknown): string | null;
    getReferenceFetcher(): ReferenceFetcher;
  };
  const failure = (path: string, why: string) =>
    `couldn't delete ${path} from the workspace, a copy whose payload a server marked never (RFC-005), so the agent's tools can still open it there: ${why}`;

  it('removes a copy a `never` marks during its own save, as a workspace delete removes a file, each failure to the log, with where the copy is', async () => {
    const fw = Object.create(AgentFramework.prototype) as Fw;
    fw.mcplServerConfigs = new Map([['zz-never-copies', { id: 'zz-never-copies', url: BINDING.url }]]);
    fw.firstWritableMountName = () => 'board';
    const reg = new ReferenceRegistry();
    let saving = '';
    let afterSave: () => void = () => {};
    const calls: unknown[] = [];
    const answers: Array<() => ToolResult> = [
      () => ({ success: true }),
      () => ({ success: false, isError: true, error: 'zz-delete-refused' }),
      () => { throw new Error('zz-delete-threw'); },
    ];
    const workspace = {
      writeBinary: async () => {
        reg.register(testimonyOf({ type: 'resource', uri: saving, disposition: 'never' }), 'zz-never-copies');
        afterSave();
        return { success: true };
      },
      handleToolCall: async (call: ToolCall) => { calls.push([call.name, call.input]); return answers.shift()!(); },
    };
    fw.getWorkspaceModule = () => workspace;
    const fetcher = fw.getReferenceFetcher();
    const fetchOne = async () => {
      saving = `${ORIGIN}/ok?copies-${randomUUID()}`;
      const record = reg.register(testimonyOf({ type: 'resource', uri: saving }), 'zz-never-copies');
      const { value, logged } = await quietly(() => fetcher.fetch(record));
      assert.deepEqual([value, record.fetchedPath], [NEVER_FAILURE, undefined]);
      return { path: `board/refs/${record.refId}.wav`, logged };
    };
    const fetched = [await fetchOne(), await fetchOne(), await fetchOne()];
    assert.deepEqual(calls, fetched.map(({ path }) => ['delete', { path }]));
    assert.deepEqual(fetched.map(({ logged }) => logged), [
      '',
      `[refs] ${failure(fetched[1]!.path, 'zz-delete-refused')}`,
      `[refs] ${failure(fetched[2]!.path, 'zz-delete-threw')}`,
    ]);
    afterSave = () => { fw.getWorkspaceModule = () => undefined; };
    const none = await fetchOne();
    assert.equal(none.logged, `[refs] ${failure(none.path, 'this host has no workspace')}`);
    assert.equal(calls.length, 3);
  });
});

it("a copy the framework's fetcher saved stays in its workspace when a `never` marks it, unnamed and unserved, and nothing is fetched again; one marked during the framework's own write of it is deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rfc005-never-payload-'));
  const board = join(dir, 'board');
  mkdirSync(board);
  const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: board, mode: 'read-write', watch: 'never' }] });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }], modules: [workspace],
  });
  workspace.initStore(framework.getStore());
  const internals = framework as unknown as {
    setMcplServerConfig(config: unknown): void;
    getReferenceFetcher(): ReferenceFetcher;
  };
  internals.setMcplServerConfig({ id: 'zz-never-files', url: BINDING.url });
  const asked: unknown[] = [];
  const handle = workspace.handleToolCall.bind(workspace);
  workspace.handleToolCall = async (call: ToolCall) => {
    if (call.name === 'delete') asked.push((call.input as { path?: unknown }).path);
    return handle(call);
  };
  framework.start();
  try {
    const fetcher = internals.getReferenceFetcher();
    const uri = `${ORIGIN}/ok?saved-${randomUUID()}`;
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri }), 'zz-never-files');
    const out = await fetcher.fetch(record);
    assert.equal(out.ok, true, out.error);
    const { logged } = await quietly(() => referenceRegistry.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'zz-never-files'));
    assert.equal(record.fetchedPath, undefined);
    assert.ok(logged.includes(`its copy stays at ${out.path}`), logged);
    assert.ok('data' in await workspace.readBinary(out.path!), 'the copy stays in the workspace');
    const before = served;
    assert.deepEqual(await fetcher.fetch(record), NEVER_FAILURE);
    assert.equal(served, before);
    assert.equal(buildReferenceStub(record.testimony, 'from tool zz'), `[${record.refId}] from tool zz — ${NEVER_TEXT}`);
    const object = referenceBlockForScript({ type: 'resource', uri }, 'zz-never-files') as Record<string, unknown>;
    assert.deepEqual([object.savedTo, object.unfetchable], [null, NEVER_TEXT]);

    const racing = `${ORIGIN}/ok?racing-${randomUUID()}`;
    const racer = referenceRegistry.register(testimonyOf({ type: 'resource', uri: racing }), 'zz-never-files');
    const write = workspace.writeBinary.bind(workspace);
    workspace.writeBinary = async (path, data, mimeType, options) => {
      const result = await write(path, data, mimeType, options);
      referenceRegistry.register(testimonyOf({ type: 'resource', uri: racing, disposition: 'never' }), 'zz-never-files');
      return result;
    };
    const raced = await fetcher.fetch(racer);
    workspace.writeBinary = write;
    assert.deepEqual(raced, NEVER_FAILURE);
    const racedPath = `board/refs/${racer.refId}.wav`;
    assert.deepEqual(asked, [racedPath]);
    assert.ok('error' in await workspace.readBinary(racedPath), 'the raced copy is gone from the workspace');
  } finally {
    await framework.stop();
    referenceRegistry.forgetServerAddress('zz-never-files', framework);
    rmSync(dir, { recursive: true, force: true });
  }
});
