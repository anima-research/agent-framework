import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, WorkspaceModule } from '../src/index.js';
import type { ToolCall, ToolResult } from '../src/index.js';
import { convertBlock, convertBlocks } from '../src/mcpl/convert-block.js';
import { ReferenceFetcher } from '../src/mcpl/reference-fetcher.js';
import * as references from '../src/mcpl/references.js';
import {
  ReferenceRegistry, buildReferenceStub, classifyBlock, contentClaims, referenceBlockForScript,
  referenceRegistry, shownLinkUri, unfetchableReason,
} from '../src/mcpl/references.js';
import type { ReferenceRecord, ReferenceTestimony } from '../src/mcpl/references.js';
import type { McplContentBlock } from '../src/mcpl/types.js';
import { scriptViewClaims, toolResultDataToHistoryString } from '../src/tool-result-history.js';
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
    assert.equal(marked.logged, `[refs] the "one" server marked ${record.refId}'s payload never (RFC-005); the record is bound to "one". It was saved before: its copy stays at scratch/refs/d.wav, where the agent's workspace tools can still find it; no stub, script object or fetch names it from here on`);
    record.fetchedPath = 'scratch/refs/d-again.wav';
    const again = await quietly(() => {
      reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'one');
      reg.markNevers(contentClaims([inlineNever(uri)]), 'one');
    });
    assert.deepEqual([record.fetchedPath, again.logged], ['scratch/refs/d-again.wav', '']);
    const bare = await quietly(() => reg.register(testimonyOf({ type: 'resource', uri: uniq('e.wav'), disposition: 'never' }), 'one'));
    assert.deepEqual([bare.value.payloadNever, bare.logged], [true, `[refs] the "one" server marked ${bare.value.refId}'s payload never (RFC-005); the record is bound to "one"`]);
  });

  it("is made by the result's claims for a plain reference, inline data's `never` before it included", () => {
    const reg = new ReferenceRegistry();
    const uri = uniq('g.png');
    const blocks = [inlineNever(uri), { type: 'resource', uri, name: 'g.png' }];
    assert.equal(reg.register(testimonyOf(blocks[1]!), 'one', contentClaims(blocks)).payloadNever, true);
    assert.equal(reg.register(testimonyOf({ type: 'resource', uri: uniq('h.png') }), 'one', contentClaims(blocks)).payloadNever, undefined);
  });

  it("isn't made by classifying a block: inline data's `never` and an embedded resource's leave the record their uri has as it was", () => {
    const uri = uniq('j.png');
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri }), 'one');
    classifyBlock(inlineNever(uri));
    classifyBlock({ type: 'audio', uri, data: 'aGk=', mimeType: 'audio/wav', disposition: 'never' });
    assert.equal(classifyBlock({ type: 'resource', disposition: 'never', resource: { uri, text: 'the payload', mimeType: 'text/plain' } }).kind, 'embedded');
    assert.equal(record.payloadNever, undefined);
  });

  it("isn't made by a `never` nested in a tool result's data that the history reads, or by a registration that knows no server", async () => {
    const uri = uniq('relayed.png');
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri }), 'one');
    const { logged } = await quietly(() => {
      toolResultDataToHistoryString({ nested: inlineNever(uri) });
      toolResultDataToHistoryString({ nested: { type: 'resource', uri, disposition: 'never' } });
      referenceRegistry.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }));
    });
    assert.deepEqual([record.payloadNever, logged], [undefined, '']);
  });

  it("is made by a server's inline data or embedded resource on a push, channel or injection lane, for the record its uri already has, and makes no record", () => {
    for (const [name, block] of [
      ['image', (uri: string) => inlineNever(uri)],
      ['audio', (uri: string) => ({ type: 'audio', uri, data: 'aGk=', mimeType: 'audio/wav', disposition: 'never' })],
      ['embedded', (uri: string) => ({ type: 'resource', disposition: 'never', resource: { uri, text: 'the payload', mimeType: 'text/plain' } })],
    ] as const) {
      const uri = uniq(`lane-${name}`);
      const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri }), 'one');
      convertBlock(block(uri) as McplContentBlock, 'attachment on push event', 'zz-never-dialed');
      assert.equal(record.payloadNever, true, name);
      const absent = uniq(`lane-${name}-absent`);
      convertBlock(block(absent) as McplContentBlock, 'attachment on push event', 'zz-never-dialed');
      assert.equal(referenceRegistry.findByUri(absent), undefined, name);
    }
    const plain = uniq('lane-plain.txt');
    const unmarked = referenceRegistry.register(testimonyOf({ type: 'resource', uri: plain }), 'one');
    convertBlock({ type: 'resource', disposition: 'ref', resource: { uri: plain, text: 'the payload' } } as unknown as McplContentBlock, 'attachment on push event', 'zz-never-dialed');
    assert.equal(unmarked.payloadNever, undefined);
  });

  it("governs every block of a push, channel or injection message, whatever their order: an image by uri before a `never` for its uri is its stub, and the record the message makes or has is marked", async () => {
    await quietly(() => {
      const known = uniq('order-known.png');
      const existing = referenceRegistry.register(testimonyOf({ type: 'resource', uri: known }), 'zz-never-dialed');
      const shown = convertBlocks([{ type: 'image', uri: known }, { type: 'resource', uri: known, disposition: 'never' }] as McplContentBlock[], 'attachment on push event', 'zz-never-dialed');
      assert.deepEqual([shown[0], existing.payloadNever], [{ type: 'text', text: `[${existing.refId}] attachment on push event — ${NEVER_TEXT}` }, true]);
      const fresh = uniq('order-fresh.png');
      const out = convertBlocks([{ type: 'image', uri: fresh }, { type: 'resource', uri: fresh, disposition: 'never' }] as McplContentBlock[], 'attachment on push event', 'zz-never-dialed');
      const made = referenceRegistry.findByUri(fresh)!;
      assert.deepEqual([out[0], made.payloadNever, made.serverIds], [{ type: 'text', text: `[${made.refId}] attachment on push event — ${NEVER_TEXT}` }, true, ['zz-never-dialed']]);
      const inline = uniq('order-inline.png');
      convertBlocks([inlineNever(inline), { type: 'resource', uri: inline }] as McplContentBlock[], 'attachment on push event', 'zz-never-dialed');
      assert.equal(referenceRegistry.findByUri(inline)?.payloadNever, true, "inline data's `never` before the reference that makes the record");
    });
  });

  it("withholds an embedded resource's contents, text or blob, where its uri is `never`, beside a `never` for it in either order, by its own `never`, or by a server's earlier mark: on the lanes, in history and to a script", async () => {
    const NOTICE = '[Resource not shown: a server asked that its content never reach you or your tools.]';
    const notice = { type: 'text', text: NOTICE };
    const contents = {
      text: (uri: string) => ({ type: 'resource', resource: { uri, text: 'secret contents', mimeType: 'text/plain' } }),
      blob: (uri: string) => ({ type: 'resource', resource: { uri, blob: 'aGk=', mimeType: 'application/pdf' } }),
    };
    const neverRef = (uri: string) => ({ type: 'resource', uri, disposition: 'never' });
    await quietly(() => {
      for (const [kind, embedded] of Object.entries(contents)) {
        for (const order of ['embedded-first', 'never-first'] as const) {
          const unit = (uri: string) => order === 'embedded-first' ? [embedded(uri), neverRef(uri)] : [neverRef(uri), embedded(uri)];
          const at = order === 'embedded-first' ? 0 : 1;
          const label = `${kind}, ${order}`;
          const lane = uniq(`lane-${kind}-${order}`);
          assert.deepEqual(convertBlocks(unit(lane) as McplContentBlock[], 'attachment on push event', 'zz-never-dialed')[at], notice, `lane, ${label}`);
          // A tool result's own claims, with no server's mark: its history registers without a server.
          const history = uniq(`history-${kind}-${order}`);
          const shown = toolResultDataToHistoryString(unit(history));
          assert.ok(!shown.includes('secret contents') && shown.includes(NOTICE), `history, ${label}: ${shown}`);
          assert.equal(referenceRegistry.findByUri(history)?.payloadNever, undefined, `history, ${label}: no mark`);
          const script = uniq(`script-${kind}-${order}`);
          assert.deepEqual(referenceBlockForScript(unit(script)[at], undefined, contentClaims(unit(script))), notice, `script, ${label}`);
          assert.equal(referenceRegistry.findByUri(script), undefined, `script, ${label}: no record`);
        }
        const own = uniq(`own-${kind}`);
        const ownNever = { ...embedded(own), disposition: 'never' };
        assert.deepEqual(convertBlocks([ownNever] as McplContentBlock[], 'attachment on push event', 'zz-never-dialed')[0], notice, `lane, ${kind}, its own never`);
        const ownShown = toolResultDataToHistoryString([ownNever]);
        assert.ok(ownShown.includes(NOTICE) && !ownShown.includes('secret contents'), `history, ${kind}, its own never: ${ownShown}`);
        assert.deepEqual(referenceBlockForScript(ownNever), notice, `script, ${kind}, its own never, without claims`);
        assert.deepEqual(referenceBlockForScript(ownNever, undefined, contentClaims([ownNever])), notice, `script, ${kind}, its own never`);
        const marked = uniq(`marked-${kind}`);
        referenceRegistry.register(testimonyOf(neverRef(marked)), 'zz-never-dialed');
        assert.deepEqual(convertBlock(embedded(marked) as McplContentBlock, 'attachment on push event', 'zz-other'), notice, `lane, ${kind}, after a mark`);
        const markedShown = toolResultDataToHistoryString([embedded(marked)]);
        assert.ok(markedShown.includes(NOTICE) && !markedShown.includes('secret contents'), `history, ${kind}, after a mark: ${markedShown}`);
        assert.deepEqual(referenceBlockForScript(embedded(marked), 'zz-other', contentClaims([embedded(marked)])), notice, `script, ${kind}, after a mark`);
      }
      const plain = uniq('plain.txt');
      assert.deepEqual(convertBlock(contents.text(plain) as McplContentBlock, 'attachment on push event', 'zz-other'), { type: 'text', text: 'secret contents' }, 'a uri nothing calls `never` shows its contents');
    });
  });

  it("leaves each reference's own expiry on a lane message without a `never`, where two name one uri", async () => {
    const uri = uniq('two-expiries.csv');
    const blocks = [{ type: 'resource', uri, name: 'a.csv', expiresAt: '2001-01-01T00:00:00Z' }, { type: 'resource', uri, name: 'b.csv' }];
    const [first, second] = (await quietly(() => convertBlocks(blocks as McplContentBlock[], 'attachment on push event', 'zz-never-dialed'))).value as Array<{ text: string }>;
    assert.match(first!.text, /expired/, first!.text);
    assert.doesNotMatch(second!.text, /expired/, second!.text);
  });

  it("is replaced by the first server's word for a record only a module had named, a link included, so a module's `never` or digest doesn't follow the uri once a server speaks for it", () => {
    const uri = uniq('module-first.pdf');
    referenceRegistry.register(testimonyOf({ type: 'resource', uri, disposition: 'never', digest: `sha256:${'D'.repeat(43)}` }));
    const record = referenceRegistry.register(testimonyOf({ type: 'resource_link', uri, name: 'module-first.pdf' }), 'zz-never-dialed');
    assert.deepEqual([record.payloadNever, record.testimony.disposition, record.testimony.digest, record.serverIds], [undefined, undefined, undefined, ['zz-never-dialed']]);
    assert.notEqual(unfetchableReason(record), NEVER_TEXT, "a fetch isn't refused on the module's word");
    const line = toolResultDataToHistoryString([{ type: 'resource_link', uri, name: 'module-first.pdf' }]);
    assert.ok(!line.includes(NEVER_TEXT), `a later link-only result isn't withheld on the module's word: ${line}`);
    referenceRegistry.register(testimonyOf({ type: 'resource_link', uri, name: 'later.pdf' }), 'zz-other');
    assert.equal(record.testimony.name, 'module-first.pdf', "a later server's link leaves a server's testimony as it was");
  });

  it('is logged once, at its first mark, naming the server whose content made it and the servers the record is bound to', async () => {
    const reg = new ReferenceRegistry();
    const uri = uniq('logged.bin');
    const record = reg.register(testimonyOf({ type: 'resource', uri }), 'one');
    const first = await quietly(() => reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'two'));
    assert.equal(first.logged, `[refs] the "two" server marked ${record.refId}'s payload never (RFC-005); the record is bound to "one", "two"`);
    const again = await quietly(() => {
      reg.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'three');
      reg.markNevers(contentClaims([inlineNever(uri)]), 'three');
    });
    assert.equal(again.logged, '');
    const made = await quietly(() => reg.register(testimonyOf({ type: 'resource', uri: uniq('made.bin'), disposition: 'never' }), 'one'));
    assert.equal(made.logged, `[refs] the "one" server marked ${made.value.refId}'s payload never (RFC-005); the record is bound to "one"`);
  });

  it("is made by a `never` its claims hold for a record a uri already has, for a result nothing else reads, and by no other claim (markNevers)", () => {
    const reg = new ReferenceRegistry();
    const uri = uniq('jb.pdf');
    const record = reg.register(testimonyOf({ type: 'resource', uri }), 'one');
    const claimed = contentClaims([{ type: 'resource', uri, expiresAt: '2000-01-01T00:00:00Z' }]);
    assert.ok(claimed.has(uri), 'the result claims something for the uri');
    reg.markNevers(claimed, 'one');
    assert.equal(record.payloadNever, undefined);
    reg.markNevers(contentClaims([{ type: 'resource', uri, disposition: 'never' }]), 'one');
    assert.equal(record.payloadNever, true);
    const absent = uniq('i.png');
    reg.markNevers(contentClaims([{ type: 'resource', uri: absent, disposition: 'never' }]), 'one');
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

  it("a stub and a script's object given the reason by their result's claims, inline data's `never` before the reference included, a server's claims marking the record and others' marking nothing", async () => {
    for (const serverId of [undefined, 'zz-never-dialed']) {
      const [stubbed, scripted] = [uniq('v.wav'), uniq('w.wav')];
      const stub = buildReferenceStub(testimonyOf({ type: 'resource', uri: stubbed, name: 'v.wav' }), 'from tool result', serverId,
        { claims: contentClaims([inlineNever(stubbed), { type: 'resource', uri: stubbed }]) });
      const record = referenceRegistry.findByUri(stubbed)!;
      const marked = serverId === undefined ? undefined : true;
      assert.deepEqual([record.payloadNever, stub], [marked, `[${record.refId}] v.wav — from tool result — ${NEVER_TEXT}`], String(serverId));
      const saved = referenceRegistry.register(testimonyOf({ type: 'resource', uri: scripted, name: 'w.wav' }), 'zz-never-dialed');
      saved.fetchedPath = `scratch/refs/${saved.refId}.wav`;
      const object = (await quietly(() => referenceBlockForScript({ type: 'resource', uri: scripted, name: 'w.wav' }, serverId,
        contentClaims([inlineNever(scripted), { type: 'resource', uri: scripted }])))).value as Record<string, unknown>;
      assert.deepEqual([saved.payloadNever, object.unfetchable, object.savedTo], [marked, NEVER_TEXT, null], String(serverId));
      assert.equal(saved.fetchedPath, serverId === undefined ? `scratch/refs/${saved.refId}.wav` : undefined, 'only a mark forgets the path; a result\'s own never only withholds it');
    }
  });

  it("a script's object: no saved path and no uri, and why", () => {
    const uri = uniq('o.pdf');
    referenceRegistry.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'zz-never-dialed').fetchedPath = 'scratch/refs/o.pdf';
    const object = referenceBlockForScript({ type: 'resource', uri, name: 'o.pdf' }, 'zz-never-dialed') as Record<string, unknown>;
    assert.deepEqual([object.savedTo, object.unfetchable, 'uri' in object], [null, NEVER_TEXT, false]);
    const link = referenceBlockForScript({ type: 'resource_link', uri, name: 'o.pdf' }) as Record<string, unknown>;
    assert.deepEqual([link.savedTo, link.unfetchable, 'uri' in link], [null, NEVER_TEXT, false]);
  });

  it("a script's link: no uri where another lane marked its payload after the script lane began, though the line's record, as it stood, shows it", async () => {
    const uri = uniq('x.txt');
    const link = { type: 'resource_link', uri, name: 'x.txt' };
    referenceRegistry.register(testimonyOf(link));
    const journal = referenceRegistry.openJournal();
    try {
      await quietly(() => referenceRegistry.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'zz-never-dialed'));
      referenceRegistry.register(testimonyOf({ type: 'resource', uri }));
      const claims = contentClaims([link]);
      assert.equal(shownLinkUri(testimonyOf(link), journal.before(uri)!, Date.now(), claims), uri, "the line's record shows the uri");
      const object = referenceBlockForScript(link, undefined, claims, { claims, recordBefore: journal.before }) as Record<string, unknown>;
      assert.deepEqual(['uri' in object, object.unfetchable], [false, NEVER_TEXT]);
    } finally {
      journal.close();
    }
  });

  it("a script's link where inline data marked its payload after the script lane began: the journal keeps the record as it stood, and the object reads the mark", async () => {
    const uri = uniq('y.txt');
    const link = { type: 'resource_link', uri, name: 'y.txt' };
    const record = referenceRegistry.register(testimonyOf(link));
    const saved = `scratch/refs/${record.refId}.txt`;
    record.fetchedPath = saved;
    const journal = referenceRegistry.openJournal();
    try {
      await quietly(() => referenceRegistry.markNevers(contentClaims([inlineNever(uri)]), 'zz-never-dialed'));
      assert.equal(record.payloadNever, true);
      assert.deepEqual([journal.before(uri)?.payloadNever, journal.before(uri)?.fetchedPath], [undefined, saved], "the line's record as it stood");
      const claims = contentClaims([link]);
      const object = referenceBlockForScript(link, undefined, claims, { claims, recordBefore: journal.before }) as Record<string, unknown>;
      assert.deepEqual(['uri' in object, object.savedTo, object.unfetchable], [false, null, NEVER_TEXT]);
    } finally {
      journal.close();
    }
  });

  it("a link: no uri, whatever a later server's plain testimony says, where an unmarked link the host can't fetch shows it", async () => {
    const shown = uniq('p.txt');
    const plainLink = testimonyOf({ type: 'resource_link', uri: shown, name: 'p.txt' });
    assert.equal(shownLinkUri(plainLink, referenceRegistry.register(plainLink)), shown);
    const marked = uniq('q.txt');
    await quietly(() => referenceRegistry.register(testimonyOf({ type: 'resource', uri: marked, disposition: 'never' }), 'zz-never-dialed'));
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri: marked }), 'zz-other');
    assert.equal(record.testimony.disposition, undefined, "the later server's plain testimony replaced the record's");
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

  it("saves nothing and names no path for a fetch whose record is evicted and its uri delivered again as `never` while it runs", async () => {
    const saved: string[] = [];
    const removed: string[] = [];
    const f = fetcher({ saved, removed });
    const uri = `${ORIGIN}/hold?evicted-${randomUUID()}`;
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri }), 'srv');
    const arrived = new Promise<void>((resolve) => { heard = resolve; });
    const running = f.fetch(record);
    await within('the request reaching the server', arrived);
    const response = held.shift()!;
    try {
      for (let i = 0; i < 2000; i++) referenceRegistry.register(testimonyOf({ type: 'resource', uri: `https://zz-never.example/evict/${randomUUID()}` }), 'srv');
      assert.equal(referenceRegistry.findByUri(uri), undefined, 'the record is evicted');
      const again = (await quietly(() => referenceRegistry.register(testimonyOf({ type: 'resource', uri, disposition: 'never' }), 'srv'))).value;
      assert.equal(again.payloadNever, true);
    } finally {
      response.end();
    }
    assert.deepEqual(await within('the evicted download', running), NEVER_FAILURE);
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

    it(`pass over a payload a module's result calls \`never\`, for that result, with the blocks ${order}`, async () => {
      const fetched: string[] = [];
      const { uris, existing, blocks } = result(reversed);
      await framework(fetched).scriptResultAnswer({ success: true, data: blocks, dataIsContent: true }, 'zz_tool', false);
      assert.deepEqual(fetched, [uris.plain]);
      assert.equal(existing.payloadNever, undefined, "a module's `never` marks no record");
    });
  }

  for (const pass of ['the script demand', "a module's demand loop"] as const) {
    const verdict = pass === 'the script demand'
      ? 'mark the record a `never` reference names before awaiting any fetch, in the script demand, so a fetch of it meanwhile is refused'
      : "pass over, in a module's demand loop, a reference its result calls `never`, and leave its record unmarked, so another fetch of it meanwhile isn't refused";
    it(verdict, async () => {
      const fw = Object.create(AgentFramework.prototype) as Fw;
      const [slow, vetoed] = [uniq('slow.bin'), uniq('vetoed.bin')];
      const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri: vetoed }), 'zz-never-dialed');
      record.fetchedPath = `scratch/refs/${record.refId}.bin`;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let downloading!: () => void;
      const started = new Promise<void>((resolve) => { downloading = resolve; });
      const asked: string[] = [];
      const fetch = async (r: ReferenceRecord) => {
        asked.push(r.testimony.uri);
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
        const meanwhile = (await quietly(() => real.fetch(record))).value;
        if (pass === 'the script demand') assert.deepEqual(meanwhile, NEVER_FAILURE);
        else assert.deepEqual([meanwhile.ok, record.payloadNever], [true, undefined]);
      } finally {
        release();
        await answering;
      }
      assert.ok(!asked.includes(vetoed), `the ${pass} doesn't fetch it: ${asked.join(', ')}`);
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

    it(`fetch nothing, in ${mode} mode, for a result whose blocks can't be read for a nested \`never\`, and say so`, async () => {
      const fetched: string[] = [];
      const uri = uniq('unreadable-veto.bin');
      const content = [{ type: 'resource', uri }, { type: 'text', text: 'one attachment', attachment: { type: 'resource', uri, disposition: 'never' }, count: BigInt(1) }];
      assert.throws(() => scriptViewClaims(content, true));
      const { logged } = await quietly(() => framework(fetched).autoFetchReferences(content, 'zz-never-dialed', mode));
      assert.deepEqual(fetched, []);
      assert.equal(logged, "[rfc005] fetched nothing for a result from zz-never-dialed: its blocks couldn't be read for a nested `never`");
      const unreferenced = [{ type: 'text', text: 'no reference', count: BigInt(1) }];
      assert.throws(() => scriptViewClaims(unreferenced, true));
      assert.equal((await quietly(() => framework(fetched).autoFetchReferences(unreferenced, 'zz-never-dialed', mode))).logged, '', 'nothing to withhold, nothing logged');
    });
  }

  it("register a server's `never` reference nested in its result, bound to that server and marked, and no plain nested one, whatever the call's mode", async () => {
    for (const mode of ['register', 'model', 'script'] as const) {
      const fetched: string[] = [];
      const [nested, plain] = [uniq('nested-never.bin'), uniq('nested-plain.bin')];
      const content = [
        { type: 'text', text: 'one attachment', attachment: { type: 'resource', uri: nested, disposition: 'never' } },
        { type: 'text', text: 'another', attachment: { type: 'resource', uri: plain } },
      ];
      await quietly(() => framework(fetched).autoFetchReferences(content, 'zz-never-dialed', mode));
      const record = referenceRegistry.findByUri(nested);
      assert.deepEqual([record?.payloadNever, record?.serverIds, referenceRegistry.findByUri(plain), fetched], [true, ['zz-never-dialed'], undefined, []], mode);
    }
  });

  it('log no failure for a record a `never` marks while they run', async () => {
    const fw = Object.create(AgentFramework.prototype) as Fw;
    const fetch = async (record: ReferenceRecord) => {
      referenceRegistry.markNevers(contentClaims([inlineNever(record.testimony.uri)]), 'srv');
      return NEVER_FAILURE;
    };
    fw.getReferenceFetcher = () => ({ isEagerEligible: () => true, fetch, fetchEager: fetch });
    const [eager, module] = [uniq('mid-eager.bin'), uniq('mid-module.bin')];
    const { logged } = await quietly(async () => {
      await fw.autoFetchReferences([{ type: 'resource', uri: eager }], 'zz-never-dialed', 'script');
      await fw.scriptResultAnswer({ success: true, data: [{ type: 'resource', uri: module }], dataIsContent: true }, 'zz_tool', false);
    });
    const [eagerRecord, moduleRecord] = [eager, module].map((u) => referenceRegistry.findByUri(u)!);
    assert.deepEqual([eagerRecord.payloadNever, moduleRecord.payloadNever], [true, true]);
    assert.equal(logged, [
      `[refs] the "srv" server marked ${eagerRecord.refId}'s payload never (RFC-005); the record is bound to "zz-never-dialed"`,
      `[refs] the "srv" server marked ${moduleRecord.refId}'s payload never (RFC-005); the record is bound to no server`,
    ].join('\n'), 'the marks, and no failure');
  });

  it("answer fetch_reference for a marked record with the reason, and fetch nothing", async () => {
    const fw = Object.create(AgentFramework.prototype) as {
      pushEvent(event: unknown): void;
      dispatchFetchReferenceToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
      setMcplServerConfig(config: unknown): void;
    };
    Object.assign(fw, {
      mcplServerConfigs: new Map(),
      getWorkspaceModule: () => ({ writeBinary: async () => ({ success: true }) }),
      firstWritableMountName: () => 'scratch',
      emitTrace: () => {},
    });
    fw.setMcplServerConfig({ id: 'zz-never-dispatch', url: BINDING.url });
    try {
      const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri: `${ORIGIN}/ok?dispatch-${randomUUID()}`, disposition: 'never' }), 'zz-never-dispatch');
      const before = served;
      const answered = new Promise<{ result: { success: boolean; error?: string } }>((resolve) => { fw.pushEvent = (event) => resolve(event as never); });
      fw.dispatchFetchReferenceToolCall('prime', { id: `call_${record.refId}`, name: 'fetch_reference', input: { ref_id: record.refId } });
      const { result } = await within('fetch_reference answering', answered);
      assert.deepEqual([result.success, result.error], [false, `fetch_reference couldn't fetch "${record.refId}": ${NEVER_TEXT}. Calling again won't change that.`]);
      assert.equal(served, before);
    } finally {
      referenceRegistry.forgetServerAddress('zz-never-dispatch', fw);
    }
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
      const marked = `[refs] the "zz-never-copies" server marked ${record.refId}'s payload never (RFC-005); the record is bound to "zz-never-copies"`;
      return { path: `board/refs/${record.refId}.wav`, logged, marked };
    };
    const fetched = [await fetchOne(), await fetchOne(), await fetchOne()];
    assert.deepEqual(calls, fetched.map(({ path }) => ['delete', { path }]));
    assert.deepEqual(fetched.map(({ logged }) => logged), [
      fetched[0]!.marked,
      `${fetched[1]!.marked}\n[refs] ${failure(fetched[1]!.path, 'zz-delete-refused')}`,
      `${fetched[2]!.marked}\n[refs] ${failure(fetched[2]!.path, 'zz-delete-threw')}`,
    ]);
    afterSave = () => { fw.getWorkspaceModule = () => undefined; };
    const none = await fetchOne();
    assert.equal(none.logged, `${none.marked}\n[refs] ${failure(none.path, 'this host has no workspace')}`);
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
