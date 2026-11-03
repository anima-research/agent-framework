/**
 * A tool result's content array reaches the agent block by block, on both of
 * its copies, the stored text history keeps and the live copy the model reads
 * when the result is answered: each block as itself, as a reference's stub,
 * or as a marker saying what kind of block it was and why it isn't shown,
 * never as the array's JSON, which would carry inline data's base64 and a
 * link's uri. A protocol result's content is content whatever its blocks'
 * types (ToolResult.dataIsContent, which an MCPL tool's result carries). Any
 * other array is content only when every element is a block of one of MCP's
 * types, so a list of records of other types stays data, written as JSON.
 *
 * Run: node --import tsx --test test/tool-result-blocks.test.ts
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/index.js';
import * as referencesModule from '../src/mcpl/references.js';
import { keptWhenWithheld } from '../src/tool-result-guard.js';
import type { Module, ModuleContext, ToolCall, ToolResult, ToolDefinition } from '../src/types/index.js';
import {
  AUDIO_NO_DATA_TEXT,
  AUDIO_NO_MEDIA_TYPE_TEXT,
  EXPIRY_REASON,
  IMAGE_NO_DATA_TEXT,
  IMAGE_NO_MEDIA_TYPE_TEXT,
  INLINE_WITHHELD_TEXT,
  REFERENCE_LIMITS,
  REFERENCE_LINK_TOO_LONG_TEXT,
  REFERENCE_NO_LINK_TEXT,
  buildReferenceStub,
  classifyBlock,
  noAddressReason,
  referenceBlockForScript,
  referenceRegistry,
  referenceStubOrNull,
  sanitizeLabel,
  unknownBlockText,
  type BlockClassification,
} from '../src/mcpl/references.js';
import { convertBlock } from '../src/mcpl/convert-block.js';
import { CoalesceError, validateCoalescedContent } from '../src/mcpl/push-coalescer.js';
import { ReferenceFetcher } from '../src/mcpl/reference-fetcher.js';
import { checkedToolResult } from '../src/module-registry.js';
import { isVisiblyEmptyContent } from '../src/mcpl/visible-content.js';
import { parseImagePlaceholders } from '../src/tool-image-ledger.js';
import { UNCHECKED_RESULT_TEXT, nonErrorResultText, scriptViewClaims, shownToScript, toolResultDataToHistoryString, truncateForHistory } from '../src/tool-result-history.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { fixture } from './helpers/coalescing-fixture.js';

/** What a script's call answers (ToolAnswer, the isolate runner's), as these tests read it. */
interface ScriptAnswer { ok: boolean; json: string; isError?: boolean }

/** The text a script reads for a result with no structured content: its one text block. */
const answerText = (answer: ScriptAnswer): string => (JSON.parse(answer.json) as { content: Array<{ text: string }> }).content[0]!.text;

const SECRET = 'zz-secret-signature';
/** 3,000 bytes of audio or image data, base64. */
const BASE64 = Buffer.alloc(3000, 7).toString('base64');
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const TEXT = { type: 'text', text: 'zz-text' };
const IMAGE = { type: 'image', data: PNG, mimeType: 'image/png' };
const AUDIO = { type: 'audio', data: BASE64, mimeType: 'audio/wav' };
const AUDIO_TEXT = "[Audio not shown: this host's tool results carry only text and images (audio/wav, ~3KB).]";
const VIDEO = { type: 'video', uri: `https://zz-files.example/clip.mp4?sig=${SECRET}` };
const LINK_URI = `https://zz-files.example/report.csv?sig=${SECRET}`;
const LINK = {
  type: 'resource_link', uri: LINK_URI, name: 'report.csv', mimeType: 'text/csv', size: 1234,
  title: 'zz-title', description: 'zz-description', annotations: { audience: ['user'] },
};
const STUB = /\[ref_[^\]]+\] report\.csv — text\/csv, ~1KB claimed — from tool result — /;
/** LINK's stub where the host can't fetch it, as where no server delivered it: its uri may carry a credential (sig). */
const LINK_STUB = new RegExp(`${STUB.source}it's not tied to any server, so there's nowhere to fetch it from$`);
/** A link whose uri can't carry a credential. */
const PLAIN_URI = 'https://zz-files.example/report.csv';
const PLAIN_LINK = { ...LINK, uri: PLAIN_URI };
/** What PLAIN_LINK shows in a tool result where the host can't fetch it, as where no server delivered it. */
const PLAIN_LINK_TEXT = `[resource link "report.csv": ${PLAIN_URI}, text/csv; not fetched]`;
/** A content array's claims, by the module's own contentClaims, read off the
 *  module's namespace so the file still loads against main's src, which
 *  lacks it, for red-first. */
const contentClaimsOf = (blocks: unknown[]) =>
  (referencesModule as unknown as { contentClaims(blocks: unknown[]): referencesModule.ResultClaims }).contentClaims(blocks);
/** Record a server dialed on the links' origin, as the framework records a server it configures. Each
 *  test that needs it asks, so the file loads against a registry that keeps no addresses. */
const servingFiles = () => referenceRegistry.setServerAddress('zz-files', { url: 'wss://zz-files.example' }, TEST_HOST);
/** The framework these tests record servers' addresses for, as one does. */
const TEST_HOST = {};

/** Each block the lane can't show as itself, and the marker that stands in its place. */
const MARKED: Array<[string, unknown, string]> = [
  ['inline audio', AUDIO, AUDIO_TEXT],
  ['audio data with no media type', { type: 'audio', data: BASE64 }, AUDIO_NO_MEDIA_TYPE_TEXT],
  ['image data with no media type', { type: 'image', data: BASE64 }, IMAGE_NO_MEDIA_TYPE_TEXT],
  ['image data with an empty media type', { type: 'image', data: BASE64, mimeType: '' }, IMAGE_NO_MEDIA_TYPE_TEXT],
  ['an image whose data is empty', { type: 'image', data: '', mimeType: 'image/png' }, IMAGE_NO_DATA_TEXT],
  ['audio whose data is empty', { type: 'audio', data: '', mimeType: 'audio/wav' }, AUDIO_NO_DATA_TEXT],
  ['an image with neither data nor a link', { type: 'image' }, IMAGE_NO_DATA_TEXT],
  ['a block of a type the host can\'t show', VIDEO, unknownBlockText(VIDEO)],
  ['an element that isn\'t a block', 42, unknownBlockText(42)],
  ['null', null, unknownBlockText(null)],
];

type Live = { content: unknown; isError: boolean };
const framework = () => Object.create(AgentFramework.prototype) as {
  toMembraneToolResult(callId: string, result: ToolResult, maxChars?: number): Live;
};
/** Both copies of a result: the stored text, and the content the model is sent. */
function copies(result: ToolResult, maxChars?: number): { stored: string; live: unknown } {
  return { stored: nonErrorResultText(result, maxChars), live: framework().toMembraneToolResult('zz-call', result, maxChars).content };
}

describe("a protocol result's content (dataIsContent)", () => {
  it('shows each block the lane can\'t show as its marker on both copies, never as JSON', () => {
    for (const [what, block, marker] of MARKED) {
      const { stored, live } = copies({ success: true, data: [TEXT, block], dataIsContent: true });
      assert.equal(stored, `zz-text\n${marker}`, what);
      // With no image, the live copy is the stored text.
      assert.equal(live, stored, what);
    }
    const all = copies({ success: true, data: [TEXT, ...MARKED.map(([, block]) => block)], dataIsContent: true }).stored;
    assert.ok(!all.includes(BASE64.slice(0, 64)) && !all.includes(SECRET), all);
  });

  it('keeps an image native in the live copy beside them, and its placeholder in the stored text', () => {
    for (const [what, block, marker] of MARKED) {
      const { stored, live } = copies({ success: true, data: [IMAGE, TEXT, block], dataIsContent: true });
      assert.equal(stored, `[image: image/png, 9B]\nzz-text\n${marker}`, what);
      assert.deepEqual(live, [
        { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } },
        { type: 'text', text: 'zz-text' },
        { type: 'text', text: marker },
      ], what);
    }
  });

  it('shows a reference as its stub, and inline data claiming a link as withheld, as before', () => {
    const { stored, live } = copies({
      success: true,
      data: [IMAGE, { type: 'resource', uri: `https://zz-files.example/a.pdf?sig=${SECRET}`, name: 'a.pdf' }, { ...AUDIO, uri: 'https://zz-files.example/a.wav' }],
      dataIsContent: true,
    });
    assert.match(stored, /^\[image: image\/png, 9B\]\n\[ref_[^\]]+\] a\.pdf — from tool result — [^\n]+\n/);
    assert.ok(stored.endsWith(`\n${INLINE_WITHHELD_TEXT}`), stored);
    assert.ok(!stored.includes(SECRET), stored);
    assert.deepEqual((live as Array<{ type: string; text?: string }>).map((b) => b.text ?? b.type), stored.split('\n').map((line, i) => (i === 0 ? 'image' : line)));
  });

  it('cuts a text block at the cap in the live copy, and shows each marker whole', () => {
    const long = { type: 'text', text: 'z'.repeat(500) };
    const { live } = copies({ success: true, data: [IMAGE, long, AUDIO], dataIsContent: true }, 100);
    const [, text, marker] = live as Array<{ type: string; text: string }>;
    assert.match(text.text, /^z{100}\n\n\[truncated — original was 500 chars\]$/);
    assert.equal(marker.text, AUDIO_TEXT);
  });

  it('sends the stored text, cut at the cap, once its links pass the cap together', () => {
    // Each link line carries its uri whole. Together past the cap, the live
    // copy is the stored text cut at the cap, as main sent a result holding a
    // link, so no number of them carries the result past it.
    const links = Array.from({ length: 6 }, (_, i) =>
      ({ type: 'resource_link', uri: `https://zz-files.example/${'p'.repeat(1000)}/${i}.csv`, name: `${i}.csv` }));
    const { stored, live } = copies({ success: true, data: [IMAGE, TEXT, ...links], dataIsContent: true }, 2000);
    assert.equal(live, stored);
    assert.match(stored, /^\[image: image\/png, 9B\]\nzz-text\n\[resource link "0\.csv": /);
    assert.match(stored, /\[truncated — original was \d+ chars\]$/);
    assert.ok(stored.length < 2100, String(stored.length));
    // Within the cap, they go beside the image as before.
    const few = copies({ success: true, data: [IMAGE, TEXT, links[0]], dataIsContent: true }, 2000).live;
    assert.ok(Array.isArray(few) && (few as Array<{ type: string }>)[0]!.type === 'image', JSON.stringify(few).slice(0, 200));
  });

  it('counts markers toward that budget too', () => {
    const { stored, live } = copies({ success: true, data: [IMAGE, ...Array.from({ length: 30 }, () => AUDIO)], dataIsContent: true }, 1000);
    assert.ok(AUDIO_TEXT.length * 30 > 1000);
    assert.equal(live, stored);
    assert.match(stored, /\[truncated — original was \d+ chars\]$/);
    const few = copies({ success: true, data: [IMAGE, AUDIO, AUDIO], dataIsContent: true }, 1000).live as Array<{ type: string; text?: string }>;
    assert.deepEqual(few.map((b) => b.text ?? b.type), ['image', AUDIO_TEXT, AUDIO_TEXT]);
  });

  it("sends references' stubs and withheld lines whole beside an image, whatever their length together, as before", () => {
    const refs = Array.from({ length: 20 }, (_, i) => ({ type: 'resource', uri: `https://zz-files.example/r${i}.pdf`, name: `r${i}.pdf` }));
    const withheld = { ...AUDIO, uri: 'https://zz-files.example/a.wav' };
    for (const data of [[IMAGE, ...refs], [IMAGE, ...refs.slice(0, 5), ...Array.from({ length: 12 }, () => withheld)]]) {
      const result: ToolResult = { success: true, data, dataIsContent: true };
      // The stored text before its cut: each block a line of it.
      const whole = nonErrorResultText(result);
      assert.ok(whole.length > 1000, String(whole.length));
      const blocks = copies(result, 1000).live as Array<{ type: string; text?: string }>;
      assert.ok(Array.isArray(blocks), String(blocks).slice(0, 200));
      assert.deepEqual(blocks.map((b) => b.text ?? b.type), whole.split('\n').map((line, i) => (i === 0 ? 'image' : line)));
      assert.match(blocks[1]!.text!, /^\[ref_[^\]]+\] r0\.pdf — from tool result — /);
      if (data.includes(withheld)) assert.equal(blocks.at(-1)!.text, INLINE_WITHHELD_TEXT);
    }
    // At a cap shorter than one stub, the live copy shows the stub whole too:
    // it cuts only text blocks (#403).
    const stub = nonErrorResultText({ data: [IMAGE, refs[0]], dataIsContent: true }).split('\n')[1]!;
    assert.ok(stub.length > 40, stub);
    const tiny = copies({ success: true, data: [IMAGE, refs[0]], dataIsContent: true }, 40).live as Array<{ type: string; text?: string }>;
    assert.deepEqual(tiny.map((b) => b.text ?? b.type), ['image', stub]);
  });
});

describe('an array without dataIsContent', () => {
  it('is content when every element is a block of one of MCP\'s types, each block the lane can\'t show as its marker', () => {
    assert.equal(toolResultDataToHistoryString([TEXT, AUDIO]), `zz-text\n${AUDIO_TEXT}`);
    assert.equal(toolResultDataToHistoryString([TEXT, PLAIN_LINK]), `zz-text\n${PLAIN_LINK_TEXT}`);
    assert.equal(toolResultDataToHistoryString([]), '');
    // A list of records that all carry MCP's type names is read as content
    // too: this one, with its url, shows a marker where JSON showed it.
    assert.equal(toolResultDataToHistoryString([{ type: 'image', url: 'https://zz-images.example/a.png' }]), IMAGE_NO_DATA_TEXT);
  });

  it('is data, written as JSON, when any element is of another type or isn\'t a record', () => {
    for (const data of [
      [TEXT, VIDEO],
      [TEXT, { type: 'user', id: 1 }],
      [{ name: 'a' }, { name: 'b' }],
      ['a', 'b'],
      [TEXT, 42],
      [TEXT, null],
      [TEXT, { type: 42 }],
    ]) {
      assert.equal(toolResultDataToHistoryString(data), JSON.stringify(data));
    }
    // So is data that isn't an array, whatever it holds.
    assert.equal(toolResultDataToHistoryString({ content: [TEXT] }), JSON.stringify({ content: [TEXT] }));
  });

  it('is content whatever its elements when the result says it is, and only then', () => {
    assert.equal(toolResultDataToHistoryString([TEXT, VIDEO], undefined, { dataIsContent: true }), `zz-text\n${unknownBlockText(VIDEO)}`);
    assert.equal(nonErrorResultText({ data: [TEXT, VIDEO], dataIsContent: true }), `zz-text\n${unknownBlockText(VIDEO)}`);
    assert.equal(nonErrorResultText({ data: [TEXT, VIDEO], dataIsContent: false }), JSON.stringify([TEXT, VIDEO]));
    // Data that isn't an array is data, whatever the result says.
    assert.equal(nonErrorResultText({ data: { a: 1 }, dataIsContent: true }), '{"a":1}');
    // The flag is read for its truth, as a result's other flags are, on both copies.
    const loose = { success: true, data: [IMAGE, TEXT, VIDEO], dataIsContent: 1 as never };
    const { stored, live } = copies(loose);
    assert.equal(stored, `[image: image/png, 9B]\nzz-text\n${unknownBlockText(VIDEO)}`);
    assert.equal((live as unknown[]).length, 3);
  });
});

/** A block's reference testimony, as classifyBlock reads it. */
function testimonyOf(block: unknown) {
  const c = classifyBlock(block);
  assert.equal(c.kind, 'reference');
  return (c as Extract<BlockClassification, { kind: 'reference' }>).testimony;
}

describe("MCP's resource_link, a reference (RFC-005 §8.1)", () => {
  it("reads its size from MCP's size, and from sizeBytes only where size is absent or null, a size of 0 included", () => {
    const sized = (fields: Record<string, unknown>) => testimonyOf({ type: 'resource_link', uri: PLAIN_URI, name: 'report.csv', ...fields }).sizeBytes;
    assert.equal(sized({ size: 10, sizeBytes: 20 }), 10, 'size decides where both are named');
    assert.equal(sized({ size: 0, sizeBytes: 20 }), 0, 'a size of 0 is a size');
    assert.equal(sized({ sizeBytes: 2048 }), 2048);
    assert.equal(sized({ size: null, sizeBytes: 2048 }), 2048);
  });

  it('maps onto the reference record field for field, its size as sizeBytes, with no disposition', () => {
    const t = testimonyOf({ ...LINK, disposition: 'never', digest: `sha256:${'A'.repeat(43)}`, expiresAt: '2020-01-01T00:00:00Z' });
    assert.deepEqual([t.uri, t.name, t.mimeType, t.sizeBytes], [LINK_URI, 'report.csv', 'text/csv', 1234]);
    assert.deepEqual([t.disposition, t.digest, t.expiresAt], [undefined, undefined, undefined]);
    assert.deepEqual(t.rejectedFields, []);
    // A size that isn't a byte count is dropped as a field, as a sizeBytes is.
    const bad = testimonyOf({ ...LINK, size: -1 });
    assert.equal(bad.sizeBytes, undefined);
    assert.deepEqual(bad.rejectedFields, ['sizeBytes']);
    assert.deepEqual(classifyBlock({ type: 'resource_link', name: 'zz' }), { kind: 'invalid', shown: REFERENCE_NO_LINK_TEXT });
    assert.deepEqual(classifyBlock({ type: 'resource_link', uri: 'u'.repeat(REFERENCE_LIMITS.uri + 1) }), { kind: 'invalid', shown: REFERENCE_LINK_TOO_LONG_TEXT });
  });

  it('shows as a stub where the host can fetch it, never its uri, in a content array and at any depth in data', () => {
    const uri = `https://zz-files.example/fetchable.csv?sig=${SECRET}`;
    const fetchable = { ...LINK, uri };
    servingFiles();
    referenceRegistry.register(testimonyOf(fetchable), 'zz-files');
    const { stored, live } = copies({ success: true, data: [TEXT, fetchable], dataIsContent: true });
    assert.match(stored, new RegExp(`^zz-text\\n${STUB.source}fetch with fetch_reference$`));
    assert.equal(live, stored);
    const nested = toolResultDataToHistoryString({ found: [fetchable], page: 2 });
    assert.ok(!nested.includes(SECRET), nested);
    assert.match((JSON.parse(nested) as { found: string[] }).found[0]!, STUB);
  });

  it("in a tool result, shows its name, uri and type where the host can't fetch it and the uri can't carry a credential", () => {
    // PLAIN_LINK has no server, as a module's link hasn't.
    const { stored, live } = copies({ success: true, data: [TEXT, PLAIN_LINK], dataIsContent: true });
    assert.equal(stored, `zz-text\n${PLAIN_LINK_TEXT}`);
    assert.equal(live, stored);
    assert.deepEqual(JSON.parse(toolResultDataToHistoryString({ found: [PLAIN_LINK], page: 2 })), { found: [PLAIN_LINK_TEXT], page: 2 });
    assert.equal(toolResultDataToHistoryString(PLAIN_LINK), PLAIN_LINK_TEXT);
    // So too where a server delivered it, with a scheme the fetcher doesn't
    // fetch or off its server's origin. A resource there gets the stub that
    // says why, with no uri, as a resource always has.
    servingFiles();
    for (const [uri, why] of [
      ['file:///zz/report.csv', 'scheme not allowed: this host fetches only http and https uris'],
      ['zz-server://reports/report.csv', 'scheme not allowed: this host fetches only http and https uris'],
      ['https://zz-elsewhere.example/watch?v=zz', "third-party origin: it isn't on its server's own address, so this host doesn't fetch it"],
      ['https://zz-elsewhere.example/d/zz/edit?usp=sharing#heading=h.zz', "third-party origin: it isn't on its server's own address, so this host doesn't fetch it"],
      ['https://zz-elsewhere.example/cb?token_type=bearer&key_id=zz', "third-party origin: it isn't on its server's own address, so this host doesn't fetch it"],
      // A credential's name with no value, such as an anchor, carries nothing.
      ...['#token', '#policy', '#access_token=', '?token', '?token=&page=2'].map((tail) =>
        [`https://zz-elsewhere.example/docs/auth${tail}`, "third-party origin: it isn't on its server's own address, so this host doesn't fetch it"]),
      // A relative one is read as a relative reference is.
      ['zz-reports/report.csv?page=2', "its address doesn't parse as a URL"],
    ]) {
      const link = { type: 'resource_link', uri, name: 'report.csv' };
      referenceRegistry.register(testimonyOf(link), 'zz-files');
      assert.equal(toolResultDataToHistoryString([TEXT, link]), `zz-text\n[resource link "report.csv": ${uri}; not fetched]`);
      const resource = { type: 'resource', uri, name: 'report.csv' };
      const stub = toolResultDataToHistoryString([TEXT, resource]);
      assert.ok(stub.endsWith(`report.csv — from tool result — ${why}`) && !stub.includes(uri), stub);
    }
  });

  it("gives a script's object the uri a tool result's line shows for the same link, and none where the line shows none", () => {
    // One decision for both lanes (shownLinkUri): a script's output comes
    // back to the model, so it holds what the model's own line holds.
    servingFiles();
    const withheldUri = 'https://zz-elsewhere.example/withheld-for-script.csv';
    referenceRegistry.register(testimonyOf({ type: 'resource', uri: withheldUri, name: 'withheld.csv', disposition: 'never' }));
    const thirdParty = "third-party origin: it isn't on its server's own address, so this host doesn't fetch it";
    for (const [what, link, shows, refused] of [
      ["off its server's origin, with no credential", { type: 'resource_link', uri: 'https://zz-elsewhere.example/script-plain.csv', name: 'a.csv' }, true, thirdParty],
      ['with a scheme the fetcher refuses', { type: 'resource_link', uri: 'file:///zz/script-plain.csv', name: 'a.csv' }, true, 'scheme not allowed: this host fetches only http and https uris'],
      ['that may carry a credential', { type: 'resource_link', uri: `https://zz-elsewhere.example/script-signed.csv?sig=${SECRET}`, name: 'a.csv' }, false, thirdParty],
      ['withheld by a reference with disposition never', { type: 'resource_link', uri: withheldUri, name: 'a.csv' }, false, thirdParty],
      ['the host can fetch', { type: 'resource_link', uri: 'https://zz-files.example/script-fetchable.csv', name: 'a.csv' }, false, undefined],
    ] as const) {
      // Delivered by the zz-files server, as a script's MCPL call registers it.
      const object = referenceBlockForScript(link, 'zz-files') as { uri?: string; refId: string; unfetchable?: string };
      const line = toolResultDataToHistoryString([TEXT, link], undefined, { dataIsContent: true }).split('\n')[1]!;
      assert.equal(line.startsWith('[resource link '), shows, `${what}: ${line}`);
      assert.equal(object.uri, shows ? link.uri : undefined, what);
      // The object says why a fetch_reference with its refId would be
      // refused: where the line is a stub, the reason it gives in place of advising
      // fetch_reference, in the same words, and where the line shows the
      // uri, which it does only for a link the host can't fetch, the reason
      // that fetch is refused, which the line, having no id, doesn't give.
      if (!shows) {
        const ending = line.slice(line.lastIndexOf(' — ') + 3);
        assert.equal(ending, refused ?? 'fetch with fetch_reference', what);
      }
      assert.equal(object.unfetchable, refused, what);
      if (!shows) assert.ok(!line.includes(link.uri) && !JSON.stringify(object).includes(link.uri), what);
      assert.match(object.refId, /^ref_/, what);
    }
  });

  it("reads a uri in a parameter's value as it reads the link's own, four levels deep, and withholds one nested deeper", () => {
    const presigned = `https://zz-bucket.s3.amazonaws.com/k.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=zz&X-Amz-Signature=${SECRET}`;
    const line = (uri: string) => toolResultDataToHistoryString([TEXT, { type: 'resource_link', uri, name: 'report.csv' }]).split('\n')[1]!;
    const stub = /^\[ref_[^\]]+\] report\.csv — from tool result — it's not tied to any server, so there's nowhere to fetch it from$/;
    // An image proxy's shape: the signed URL percent-encoded as one
    // parameter's value, one decode level down, and two.
    const once = `https://zz-site.example/_next/image?url=${encodeURIComponent(presigned)}&w=640`;
    const twice = `https://zz-camo.example/?u=${encodeURIComponent(once)}`;
    // Userinfo in a nested uri, and a credential in a nested uri's fragment.
    const userinfo = `https://zz-site.example/go?to=${encodeURIComponent('https://zz-user:zz-pass@zz-elsewhere.example/r.csv')}`;
    const fragment = `https://zz-site.example/go#next=${encodeURIComponent(`https://zz-elsewhere.example/cb#access_token=${SECRET}`)}`;
    for (const uri of [once, twice, userinfo, fragment]) assert.match(line(uri), stub, uri);
    // An ordinary nested uri shows, four levels down too; a fifth level is
    // past the bound, and withheld whatever it holds.
    const nest = (levels: number) => {
      let uri = 'https://zz-files.example/page?v=1';
      for (let i = 0; i < levels; i += 1) uri = `https://zz-site${i}.example/r?next=${encodeURIComponent(uri)}`;
      return uri;
    };
    for (const levels of [1, 4]) {
      const uri = nest(levels);
      assert.equal(line(uri), `[resource link "report.csv": ${uri}; not fetched]`, String(levels));
    }
    assert.match(line(nest(5)), stub);
    // A value that isn't an absolute uri is a value, though it reads as a
    // path: the relative reading's fail-closed answer never meets it.
    const plain = 'https://zz-files.example/search?q=zz%20elsewhere%20report&page=zz-reports/2';
    assert.equal(line(plain), `[resource link "report.csv": ${plain}; not fetched]`);
  });

  it("reads a relative uri in a parameter's value, and one encoded again inside it, each read and decode a level", () => {
    const presigned = `https://zz-bucket.s3.amazonaws.com/k.png?X-Amz-Signature=${SECRET}`;
    const line = (uri: string) => toolResultDataToHistoryString([TEXT, { type: 'resource_link', uri, name: 'report.csv' }]).split('\n')[1]!;
    const stub = /^\[ref_[^\]]+\] report\.csv — from tool result — it's not tied to any server, so there's nowhere to fetch it from$/;
    const twice = (value: string) => encodeURIComponent(encodeURIComponent(value));
    for (const uri of [
      // A relative one with a query, and a protocol-relative one with userinfo.
      `https://zz-app.example/login?next=${encodeURIComponent(`/reset?token=${SECRET}`)}`,
      `https://zz-proxy.example/img?url=${encodeURIComponent('//zz-user:zz-pass@zz-bucket.example/k')}`,
      // Encoded twice inside one parameter, as a redirector leaves it: an
      // absolute one, and a protocol-relative one read once decoded.
      `https://zz-r.example/go?u=${twice(presigned)}`,
      `https://zz-r.example/go?u=${twice('//zz-user:zz-pass@zz-bucket.example/k')}`,
      // Decoded leniently, as the parameter itself was: a stray `%` doesn't
      // stop the reading, and an `&` the first decode made stays in the value.
      `https://zz-r.example/go?u=${twice('//zz-user:zz-pass@zz-bucket.example/k')}%`,
      `https://zz-r.example/go?u=${encodeURIComponent(`%2Fpath&x%3Ftoken%3D${SECRET}`)}`,
      // A relative value that doesn't resolve can't be read, so it may carry
      // one, as a uri that doesn't parse may: here its authority holds a `%`.
      `https://zz-r.example/go?u=${twice('//zz-user:zz-pass@zz-host%')}`,
      // The backslash form a special scheme reads as `//`.
      `https://zz-r.example/go?u=${encodeURIComponent('\\\\zz-user:zz-pass@zz-bucket.example\\k')}`,
      // Its form read as the URL parser reads it: led by a tab, a space or a
      // C0 control, a protocol-relative value is still one, and one whose
      // authority doesn't parse is withheld through its failed resolve.
      ...['\t', ' ', '\u0001'].map((lead) => `https://zz-r.example/go?u=${encodeURIComponent(`${lead}//zz-user:zz-pass@zz-bucket.example/k`)}`),
      `https://zz-r.example/go?u=${encodeURIComponent('\t//zz-user:zz-pass@zz-host%?x')}`,
      // Read against a fixed base, so a uri with no path to resolve against,
      // such as a mailto:, still has its parameters' relative values read.
      `mailto:zz-help@zz-files.example?body=${encodeURIComponent(`?token=${SECRET}`)}`,
    ]) assert.match(line(uri), stub, uri);
    // A decode is a level: three nestings below one value encoded twice put
    // the fourth at level five, past the bound, where encoded once it's read.
    const nest = (levels: number) => {
      let uri = 'https://zz-files.example/page?v=1';
      for (let i = 0; i < levels; i += 1) uri = `https://zz-site${i}.example/r?next=${encodeURIComponent(uri)}`;
      return uri;
    };
    const once = `https://zz-r.example/go?u=${encodeURIComponent(nest(3))}`;
    assert.equal(line(once), `[resource link "report.csv": ${once}; not fetched]`);
    assert.match(line(`https://zz-r.example/go?u=${twice(nest(3))}`), stub);
    // A value percent-encoded past the bound is withheld, uri or not, so the
    // check's work stops where its reading does; one level less shows.
    let encoded = 'zz plain words';
    for (let i = 0; i < 5; i += 1) encoded = encodeURIComponent(encoded);
    const four = `https://zz-files.example/x?q=${encoded}`;
    assert.equal(line(four), `[resource link "report.csv": ${four}; not fetched]`);
    assert.match(line(`https://zz-files.example/x?q=${encodeURIComponent(encoded)}`), stub);
    // Ordinary values still show: a path, values with a colon, a value with
    // a space, and a colour, a fragment alone with no parameter in it.
    for (const uri of [
      'https://zz-files.example/x?next=/home',
      'https://zz-files.example/x?lang=en:US&tag=type:image',
      'https://zz-files.example/x?q=zz%20elsewhere%20report',
      'https://zz-files.example/x?q=100%25%20off%',
      `https://zz-files.example/x?q=${encodeURIComponent('/a b?c d#e f')}`,
      // A relative value with an empty query carries nothing, in a mailto:
      // as anywhere.
      'mailto:zz-help@zz-files.example?subject=Question%3F',
      'https://zz-files.example/badge?color=%23ff0000&label=%23zz',
    ]) assert.equal(line(uri), `[resource link "report.csv": ${uri}; not fetched]`, uri);
  });

  it("never shows a data: link's uri, which holds its content rather than naming where it lies", () => {
    const payload = 'iVBORw0KGgo'.repeat(40);
    for (const uri of [`data:image/png;base64,${payload}`, `DATA:text/plain,${payload}`]) {
      const link = { type: 'resource_link', uri, name: 'inline.png' };
      const shown = toolResultDataToHistoryString([TEXT, link]);
      assert.match(shown, /^zz-text\n\[ref_[^\]]+\] inline\.png — from tool result — it's not tied to any server, so there's nowhere to fetch it from$/, uri.slice(0, 20));
      assert.ok(!shown.includes(payload), shown.slice(0, 200));
      // A script's object for it carries no uri either, as the line shows none.
      const object = referenceBlockForScript(link, undefined) as { uri?: string };
      assert.equal(object.uri, undefined);
    }
    // From a server, the stub says why the fetch is refused, without the scheme.
    servingFiles();
    const link = { type: 'resource_link', uri: `data:image/png;base64,${payload}`, name: 'inline.png' };
    referenceRegistry.register(testimonyOf(link), 'zz-files');
    const shown = toolResultDataToHistoryString([TEXT, link]);
    assert.ok(shown.endsWith('inline.png — from tool result — scheme not allowed: this host fetches only http and https uris') && !shown.includes(payload), shown.slice(0, 200));
  });

  it("in a tool result, shows the stub that says why where the host can't fetch it and the uri may carry a credential", () => {
    const carriers = [
      // userinfo, whatever the scheme
      'postgres://zz-user:zz-pass@zz-db.example/zz',
      'https://zz-user@zz-elsewhere.example/report.csv',
      // AWS's and Google's signed URLs, names compared without letter case
      'https://zz-bucket.s3.amazonaws.com/report.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=zz&X-Amz-Signature=zz',
      'https://zz-bucket.s3.amazonaws.com/report.csv?x-amz-security-token=zz',
      'https://storage.googleapis.com/zz-bucket/report.csv?X-Goog-Credential=zz&X-Goog-Signature=zz',
      // Azure's shared access signature, CloudFront's, Discord's CDN, B2's
      'https://zz.blob.core.windows.net/c/report.csv?sv=2024-01-01&se=2030-01-01&sp=r&sig=zz',
      'https://zz.cloudfront.net/report.csv?Expires=1&Signature=zz&Key-Pair-Id=zz',
      'https://zz.cloudfront.net/report.csv?Policy=zz',
      'https://cdn.discordapp.com/attachments/1/2/report.csv?ex=1&is=2&hm=zz',
      'https://f000.backblazeb2.com/file/zz/report.csv?Authorization=zz',
      // OAuth's, in a fragment or a query, and the generic names
      'https://zz-elsewhere.example/cb#access_token=zz&token_type=bearer',
      'https://zz-elsewhere.example/cb#id_token=zz',
      'https://zz-elsewhere.example/#/reset?token=zz',
      'https://zz-elsewhere.example/cb?v=1;sig=zz',
      'https://zz-elsewhere.example/cb?v=1&amp;token=zz',
      // a value that opens with a character read as a separator
      'https://zz-elsewhere.example/cb?token=;zz',
      'https://zz-elsewhere.example/cb#access_token=?zz',
      // names compared by their letters and digits alone, without case, and OAuth 1.0a's
      ...['accessToken', 'access-token', 'Api-Key', 'x-api-key', 'private-token', 'oauth_token', 'oauth_signature', 'token[]', 'api.key']
        .map((name) => `https://zz-elsewhere.example/cb?${name}=zz`),
      // userinfo after a scheme with no slashes, read as an absolute uri
      'http:zz-user:zz-pass@zz-elsewhere.example/report.csv',
      // a credential's name, or a scheme before userinfo, split by a
      // character the line doesn't show: the check reads the uri as shown
      'https://zz-elsewhere.example/cb?to\u0000ken=zz',
      'ht\u0000tps://zz-user:zz-pass@zz-elsewhere.example/report.csv',
      'https://zz-elsewhere.example/cb?refresh_token=zz',
      'https://zz-elsewhere.example/cb?client_secret=zz',
      ...['token', 'auth', 'key', 'apikey', 'api_key', 'secret', 'password', 'signature'].map((name) => `zz-server://reports/report.csv?${name}=zz`),
      // a relative one, read as a relative reference is, and one that doesn't
      // parse even so, whose parts can't be read
      'zz-reports/report.csv?token=zz',
      'https://zz elsewhere.example/report.csv',
    ];
    for (const uri of carriers) {
      const link = { type: 'resource_link', uri, name: 'report.csv' };
      const shown = toolResultDataToHistoryString([TEXT, link]);
      assert.match(shown, /^zz-text\n\[ref_[^\]]+\] report\.csv — from tool result — it's not tied to any server, so there's nowhere to fetch it from$/, uri);
      assert.ok(!shown.includes(uri), shown);
    }
    const { stored, live } = copies({ success: true, data: [TEXT, LINK], dataIsContent: true });
    assert.match(stored, new RegExp(`^zz-text\\n${LINK_STUB.source}`));
    assert.equal(live, stored);
    assert.ok(!stored.includes(SECRET), stored);
    // So too where a server delivered it and the origin or the scheme refuses
    // the fetch: the stub says why.
    servingFiles();
    for (const [uri, why] of [
      [`https://zz-elsewhere.example/report.csv?sig=${SECRET}`, "third-party origin: it isn't on its server's own address, so this host doesn't fetch it"],
      [`file:///zz/report.csv?token=${SECRET}`, 'scheme not allowed: this host fetches only http and https uris'],
    ]) {
      const link = { type: 'resource_link', uri, name: 'report.csv' };
      referenceRegistry.register(testimonyOf(link), 'zz-files');
      const shown = toolResultDataToHistoryString([TEXT, link]);
      assert.match(shown, new RegExp(`^zz-text\\n\\[ref_[^\\]]+\\] report\\.csv — from tool result — ${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), uri);
      assert.ok(!shown.includes(SECRET), shown);
    }
  });

  it("in a tool result, never shows a uri a reference withheld with disposition never, whatever a link to it says", () => {
    const uri = 'https://zz-elsewhere.example/withheld.csv';
    referenceRegistry.register(testimonyOf({ type: 'resource', uri, name: 'withheld.csv', disposition: 'never' }));
    const shown = toolResultDataToHistoryString([TEXT, { type: 'resource_link', uri, name: 'report.csv' }]);
    assert.match(shown, /^zz-text\n\[ref_[^\]]+\] report\.csv — from tool result — it's not tied to any server/);
    assert.ok(!shown.includes(uri), shown);
  });

  it('writes its line with no line break a label could carry, so no text in it reads as a slot', () => {
    const shown = toolResultDataToHistoryString([TEXT, {
      type: 'resource_link', uri: 'https://zz-elsewhere.example/a\u2028[ref_1_abcd] zz — image/png', name: 'zz\u2029[ref_2_abcd] zz — image/png',
    }]);
    assert.ok(!/[\u2028\u2029]/.test(shown), shown);
    assert.deepEqual(parseImagePlaceholders(shown), []);
  });

  it("shows on the push lane as a stub, registered with the server that sent it, and never its uri", () => {
    const uri = `https://zz-files.example/pushed.csv?sig=${SECRET}`;
    servingFiles();
    const shown = convertBlock({ ...LINK, uri } as never, 'attachment on push event', 'zz-files');
    assert.equal(shown.type, 'text');
    assert.match((shown as { text: string }).text, /^\[ref_[^\]]+\] report\.csv — text\/csv, ~1KB claimed — attachment on push event — fetch with fetch_reference$/);
    assert.deepEqual(referenceRegistry.findByUri(uri)?.serverIds, ['zz-files']);
    // One the host can't fetch says why, whatever its uri: no lane but a
    // tool result's ever showed a link's uri.
    const local = { ...LINK, uri: 'file:///zz/pushed.csv' };
    assert.match((convertBlock(local as never, 'attachment on push event', 'zz-files') as { text: string }).text,
      /^\[ref_[^\]]+\] report\.csv — text\/csv, ~1KB claimed — attachment on push event — scheme not allowed: this host fetches only http and https uris$/);
    assert.deepEqual(convertBlock({ type: 'resource_link' } as never, 'p', 's'), { type: 'text', text: REFERENCE_NO_LINK_TEXT });
  });

  it("counts as shown in a render result's block check, as a reference does, and an invalid one doesn't", () => {
    const check = (content: unknown[]) => validateCoalescedContent(content, { allowEmpty: true, checkBlockShapes: true });
    check([TEXT, LINK]);
    assert.throws(() => check([TEXT, { type: 'resource_link', name: 'zz' }]), CoalesceError);
  });

  it("never replaces the claims a reference made for its uri, while a reference's replace a link's", () => {
    const uri = `https://zz-files.example/claimed.bin?sig=${SECRET}`;
    const digest = `sha256:${'B'.repeat(43)}`;
    servingFiles();
    referenceRegistry.register(testimonyOf({ type: 'resource', uri, digest, expiresAt: '2020-01-01T00:00:00Z', name: 'claimed.bin' }), 'zz-files');
    referenceRegistry.register(testimonyOf({ type: 'resource_link', uri, name: 'linked.bin' }), 'zz-files');
    const kept = referenceRegistry.findByUri(uri)!.testimony;
    assert.deepEqual([kept.digest, kept.expiresAt, kept.name, kept.fromLink], [digest, '2020-01-01T00:00:00Z', 'claimed.bin', undefined]);
    // A link's stub reads its record, so it says what the reference's expiry makes of it.
    assert.match((convertBlock({ type: 'resource_link', uri, name: 'linked.bin' } as never, 'p', 'zz-files') as { text: string }).text, /^\[ref_[^\]]+\] linked\.bin — p — the reference is expired$/);
    const later = 'https://zz-files.example/linked-first.bin';
    referenceRegistry.register(testimonyOf({ type: 'resource_link', uri: later, name: 'first' }), 'zz-files');
    referenceRegistry.register(testimonyOf({ type: 'resource', uri: later, digest, name: 'second' }), 'zz-files');
    const replaced = referenceRegistry.findByUri(later)!.testimony;
    assert.deepEqual([replaced.digest, replaced.name, replaced.fromLink], [digest, 'second', undefined]);
  });

  it('is registered with its server and never fetched eagerly, unless another block names its uri', async () => {
    const fw = Object.create(AgentFramework.prototype) as {
      autoFetchReferences(content: unknown[], serverId: string, eager: boolean): Promise<void>;
      getReferenceFetcher(): unknown;
    };
    const fetched: string[] = [];
    const fetchFake = async (record: { testimony: { uri: string } }) => { fetched.push(record.testimony.uri); return { ok: true }; };
    fw.getReferenceFetcher = () => ({ isEagerEligible: () => true, fetch: fetchFake, fetchEager: fetchFake });
    const u = (name: string) => `https://zz-files.example/eager/${name}`;
    await fw.autoFetchReferences([
      { type: 'resource_link', uri: u('linked') },
      { type: 'resource_link', uri: u('linked-then-referenced') },
      { type: 'resource', uri: u('linked-then-referenced') },
      { type: 'resource', uri: u('referenced-then-linked') },
      { type: 'resource_link', uri: u('referenced-then-linked') },
      { type: 'resource', uri: u('referenced') },
    ], 'zz-eager-server', true);
    assert.deepEqual(fetched.sort(), [u('linked-then-referenced'), u('referenced'), u('referenced-then-linked')].sort());
    assert.deepEqual(referenceRegistry.findByUri(u('linked'))?.serverIds, ['zz-eager-server']);
  });

  it("isn't fetched for a script on demand, where a reference is", async () => {
    const fw = Object.create(AgentFramework.prototype) as {
      getReferenceFetcher(): unknown;
      scriptResultAnswer(result: ToolResult, toolName: string, toServer: boolean): Promise<ScriptAnswer>;
    };
    const reference = {
      type: 'resource', uri: `https://zz-files.example/wanted.pdf?sig=${SECRET}`, name: 'wanted.pdf',
      digest: `sha256:${'C'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z',
    };
    // A link to the same uri came first, so its record holds the link's
    // claims until the reference's replace them.
    referenceRegistry.register(testimonyOf({ type: 'resource_link', uri: reference.uri, name: 'linked.pdf' }), 'zz-files');
    const fetched: string[] = [];
    const claims: unknown[] = [];
    fw.getReferenceFetcher = () => ({
      fetch: async (record: { testimony: { uri: string; name?: string; digest?: string; expiresAt?: string } }) => {
        fetched.push(record.testimony.uri);
        claims.push([record.testimony.name, record.testimony.digest, record.testimony.expiresAt]);
        return { ok: false, error: 'zz-refused' };
      },
    });
    const error = console.error;
    console.error = () => {};
    let result: ScriptAnswer;
    try {
      // A module's result: no dispatch sent the call to a server.
      result = await fw.scriptResultAnswer({ success: true, data: [TEXT, LINK, reference, VIDEO], dataIsContent: true }, 'zz_tool', false);
    } finally {
      console.error = error;
    }
    assert.equal(result.isError, false);
    const text = answerText(result);
    assert.deepEqual(fetched, [reference.uri]);
    assert.deepEqual(claims, [['wanted.pdf', reference.digest, reference.expiresAt]]);
    // The script reads the text history stores for a protocol result's
    // content: the link, which no server delivered, as the stub that says so.
    assert.match(text, new RegExp(`^zz-text\\n${LINK_STUB.source.slice(0, -1)}\\n\\[ref_[^\\]]+\\] wanted\\.pdf — from tool result[^\\n]+\\n`));
    assert.ok(text.endsWith(`\n${unknownBlockText(VIDEO)}`), text);
    assert.ok(!text.includes(SECRET), text);
  });
});

describe('what a stub says of a fetch, which the fetch then does', () => {
  // Servers as a framework records them: one dialed on the references'
  // origin, one with no address, as a stdio server; zz-gone is unknown.
  const serving = () => {
    referenceRegistry.setServerAddress('zz-dialed', { url: 'wss://zz-refs.example' }, TEST_HOST);
    referenceRegistry.setServerAddress('zz-stdio', 'no-address', TEST_HOST);
  };
  /** The fetcher of a framework configured as `serving` records it. */
  const servedFetcher = () => new ReferenceFetcher(
    (serverId) => (serverId === 'zz-dialed' ? { url: 'wss://zz-refs.example' } : serverId === 'zz-stdio' ? 'no-address' : undefined),
    async () => null,
  );
  const record = (name: string, serverIds: string[], extra: Record<string, unknown> = {}) => {
    const t = testimonyOf({ type: 'resource', uri: `https://zz-refs.example/${name}?sig=${SECRET}`, name, ...extra });
    let r = referenceRegistry.register(t);
    for (const id of serverIds) r = referenceRegistry.register(t, id);
    return r;
  };
  // Made when a test first asks, so the file loads against a registry that
  // keeps no addresses.
  let made: Array<[string, ReturnType<typeof record>, string | null]> | undefined;
  const cases = () => made ??= (serving(), [
    ['dialed on its origin', record('dialed.bin', ['zz-dialed']), null],
    ['from no server', record('unbound.bin', []), "it's not tied to any server, so there's nowhere to fetch it from"],
    ['from an unknown server', record('gone.bin', ['zz-gone']), 'this host no longer has the "zz-gone" server it came from'],
    ['from a server with no address', record('stdio.bin', ['zz-stdio']), noAddressReason('zz-stdio')],
    ['from a server with no address, and one dialed on its origin', record('both.bin', ['zz-stdio', 'zz-dialed']), null],
    ['dialed on its origin, but expired', record('expired.bin', ['zz-dialed'], { expiresAt: '2020-01-01T00:00:00Z' }), 'the reference is expired'],
  ]);

  it("ends a resource's stub with why a fetch would be refused, or the fetch it offers", () => {
    for (const [what, r, why] of cases()) {
      const stub = buildReferenceStub(r.testimony, 'zz');
      assert.ok(stub.endsWith(`— zz — ${why ?? 'fetch with fetch_reference'}`) && !stub.includes(SECRET), `${what}: ${stub}`);
    }
  });

  it("agrees with the fetcher's own check, which reads its framework's configs", () => {
    const fetcher = servedFetcher();
    for (const [what, r, why] of cases()) {
      const refusal = fetcher.refusal(r);
      assert.equal(refusal === null, why === null, `${what}: ${refusal?.error}`);
      if (refusal && why) assert.equal(refusal.error, why, what);
    }
  });

  it("is the framework's fetcher's check too, and the framework records each server's address for the stub", () => {
    const fw = Object.create(AgentFramework.prototype) as {
      mcplServerConfigs: Map<string, unknown>;
      setMcplServerConfig(config: unknown): void;
      getReferenceFetcher(): ReferenceFetcher;
    };
    fw.mcplServerConfigs = new Map();
    fw.setMcplServerConfig({ id: 'zz-wired', url: 'wss://zz-refs.example' });
    assert.deepEqual(referenceRegistry.serverAddress('zz-wired'), { url: 'wss://zz-refs.example' });
    // A server the host spawns has no address, whatever url its config holds.
    fw.setMcplServerConfig({ id: 'zz-spawned', command: 'zz-server', url: 'wss://zz-refs.example' });
    assert.equal(referenceRegistry.serverAddress('zz-spawned'), 'no-address');
    const wired = record('wired.bin', ['zz-wired']);
    const spawned = record('spawned.bin', ['zz-spawned']);
    const fetcher = fw.getReferenceFetcher();
    assert.equal(fetcher.refusal(wired), null);
    assert.ok(buildReferenceStub(wired.testimony, 'zz').endsWith('— zz — fetch with fetch_reference'));
    assert.equal(fetcher.refusal(spawned)?.error, noAddressReason('zz-spawned'));
    assert.ok(buildReferenceStub(spawned.testimony, 'zz').endsWith(`— zz — ${noAddressReason('zz-spawned')}`));
  });

  it("never sends a framework's token to another framework's origin for one id, and a removal takes back only its own address", () => {
    const framework = () => {
      const fw = Object.create(AgentFramework.prototype) as {
        mcplServerConfigs: Map<string, unknown>;
        setMcplServerConfig(config: unknown): void;
        getReferenceFetcher(): ReferenceFetcher;
      };
      fw.mcplServerConfigs = new Map();
      return fw;
    };
    const earlier = framework();
    const later = framework();
    earlier.setMcplServerConfig({ id: 'zz-shared', url: 'wss://zz-earlier.example', token: 'zz-earlier-token' });
    later.setMcplServerConfig({ id: 'zz-shared', url: 'wss://zz-later.example', token: 'zz-later-token' });
    // The later framework's entry is in force for the stub.
    assert.deepEqual(referenceRegistry.serverAddress('zz-shared'), { url: 'wss://zz-later.example' });
    const onLater = referenceRegistry.register(testimonyOf({ type: 'resource', uri: 'https://zz-later.example/shared.bin', name: 'shared.bin' }), 'zz-shared');
    const onEarlier = referenceRegistry.register(testimonyOf({ type: 'resource', uri: 'https://zz-earlier.example/shared.bin', name: 'shared.bin' }), 'zz-shared');
    // Each fetcher checks a uri against its own config's address, whose token
    // it carries: the earlier framework's never dials the later one's origin.
    assert.equal(earlier.getReferenceFetcher().refusal(onLater)!.error,
      'it points to https://zz-later.example, not to the "zz-shared" server\'s own address (wss://zz-earlier.example), and this host fetches only from the server itself');
    assert.equal(earlier.getReferenceFetcher().refusal(onEarlier), null);
    assert.equal(later.getReferenceFetcher().refusal(onLater), null);
    assert.match(later.getReferenceFetcher().refusal(onEarlier)!.error, /^it points to https:\/\/zz-earlier\.example, not to the "zz-shared" server's own address \(wss:\/\/zz-later\.example\)/);
    // The later framework's removal takes back only its own entry, and the
    // earlier one's is in force again.
    referenceRegistry.forgetServerAddress('zz-shared', later);
    assert.deepEqual(referenceRegistry.serverAddress('zz-shared'), { url: 'wss://zz-earlier.example' });
    assert.ok(buildReferenceStub(onEarlier.testimony, 'zz').endsWith('— zz — fetch with fetch_reference'));
    referenceRegistry.forgetServerAddress('zz-shared', earlier);
    assert.equal(referenceRegistry.serverAddress('zz-shared'), undefined);
  });

  it("carries each framework's own token to its own server's origin, and to no other, when it fetches", async (t) => {
    const heard: Array<[string, string | undefined]> = [];
    const serve = async (name: string) => {
      const server = createServer((req, res) => {
        heard.push([name, req.headers.authorization]);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from('zz-bytes'));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
      return `127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const [hostA, hostB] = [await serve('a'), await serve('b')];
    const framework = (url: string, token: string) => {
      const fw = Object.create(AgentFramework.prototype) as {
        setMcplServerConfig(config: unknown): void;
        getReferenceFetcher(): ReferenceFetcher;
      };
      Object.assign(fw, {
        mcplServerConfigs: new Map(),
        getWorkspaceModule: () => ({ writeBinary: async () => ({ success: true }) }),
        firstWritableMountName: () => 'scratch',
        emitTrace: () => {},
      });
      fw.setMcplServerConfig({ id: 'zz-shared-fetch', url, token });
      return fw;
    };
    const a = framework(`ws://${hostA}`, 'zz-token-a');
    const b = framework(`ws://${hostB}`, 'zz-token-b');
    const onA = referenceRegistry.register(testimonyOf({ type: 'resource', uri: `http://${hostA}/a.bin`, name: 'a.bin' }), 'zz-shared-fetch');
    const onB = referenceRegistry.register(testimonyOf({ type: 'resource', uri: `http://${hostB}/b.bin`, name: 'b.bin' }), 'zz-shared-fetch');
    // Each framework refuses the other's origin without dialing it, and
    // dials its own with its own token.
    assert.equal((await b.getReferenceFetcher().fetch(onA)).ok, false);
    assert.equal((await a.getReferenceFetcher().fetch(onB)).ok, false);
    assert.equal((await a.getReferenceFetcher().fetch(onA)).ok, true);
    assert.equal((await b.getReferenceFetcher().fetch(onB)).ok, true);
    assert.deepEqual(heard, [['a', 'Bearer zz-token-a'], ['b', 'Bearer zz-token-b']]);
    referenceRegistry.forgetServerAddress('zz-shared-fetch', a);
    referenceRegistry.forgetServerAddress('zz-shared-fetch', b);
  });

  it("words a server's id as a label in a stub, and a third-party origin and a refused scheme without the uri's parts", () => {
    serving();
    const weird = `zz-\u202E${'x'.repeat(300)}`;
    const r = record('weird.bin', [weird]);
    const stub = buildReferenceStub(r.testimony, 'zz');
    assert.ok(stub.includes('this host no longer has the "zz-xxx') && !stub.includes('\u202E') && stub.length < 400, stub);
    referenceRegistry.setServerAddress('zz-other', { url: 'wss://zz-other.example' }, TEST_HOST);
    const offOrigin = record('elsewhere.bin', ['zz-other']);
    assert.ok(buildReferenceStub(offOrigin.testimony, 'zz').endsWith("— zz — third-party origin: it isn't on its server's own address, so this host doesn't fetch it"));
    const fetcher = new ReferenceFetcher(() => ({ url: 'wss://zz-other.example' }), async () => null);
    assert.equal(fetcher.refusal(offOrigin)!.error,
      'it points to https://zz-refs.example, not to the "zz-other" server\'s own address (wss://zz-other.example), and this host fetches only from the server itself');
    // A scheme the fetcher doesn't fetch: the stub doesn't name it, and the
    // fetch's refusal names it bounded as a label is.
    const scheme = `zz${'s'.repeat(300)}`;
    const t = testimonyOf({ type: 'resource', uri: `${scheme}://zz-refs.example/long.bin`, name: 'long.bin' });
    const long = referenceRegistry.register(t, 'zz-dialed');
    assert.ok(buildReferenceStub(t, 'zz').endsWith('— zz — scheme not allowed: this host fetches only http and https uris'));
    assert.equal(new ReferenceFetcher(() => ({ url: 'wss://zz-refs.example' }), async () => null).refusal(long)?.error,
      `its address uses ${sanitizeLabel(`${scheme}:`, 120)}, and this host fetches only http: and https: addresses`);
  });

  it('refuses a reference through a server whose url does not parse, saying so', () => {
    referenceRegistry.setServerAddress('zz-garbled', { url: 'zz not a url' }, TEST_HOST);
    const garbled = referenceRegistry.register(testimonyOf({ type: 'resource', uri: 'https://zz-refs.example/garbled.bin', name: 'garbled.bin' }), 'zz-garbled');
    assert.ok(buildReferenceStub(garbled.testimony, 'zz').endsWith('— zz — the "zz-garbled" server\'s address doesn\'t parse as a URL, so there\'s nowhere to fetch it from'));
  });
});

describe('an empty link beside inline data is no link', () => {
  const image = { ...IMAGE, uri: '' };
  const audio = { ...AUDIO, uri: '' };

  it('so the data is shown as any inline data is, on the push lane and the tool-result lane', () => {
    assert.deepEqual(convertBlock(image as never, 'p', 's'), { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } });
    assert.deepEqual(convertBlock(audio as never, 'p', 's'), { type: 'audio', source: { type: 'base64', data: BASE64, mediaType: 'audio/wav' } });
    const { stored, live } = copies({ success: true, data: [image, audio], dataIsContent: true });
    assert.equal(stored, `[image: image/png, 9B]\n${AUDIO_TEXT}`);
    assert.deepEqual(live, [{ type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } }, { type: 'text', text: AUDIO_TEXT }]);
  });

  it('while a link that isn\'t empty still withholds it, on both lanes', () => {
    const linked = { ...AUDIO, uri: 'https://zz-files.example/a.wav' };
    assert.deepEqual(convertBlock(linked as never, 'p', 's'), { type: 'text', text: INLINE_WITHHELD_TEXT });
    assert.equal(nonErrorResultText({ data: [TEXT, linked], dataIsContent: true }), `zz-text\n${INLINE_WITHHELD_TEXT}`);
  });
});

describe("MCP's embedded resource, an ordinary inline block (RFC-005 §8.1)", () => {
  const EMBEDDED_URI = `https://zz-files.example/embedded.txt?sig=${SECRET}`;
  const embedded = (resource: Record<string, unknown>, beside: Record<string, unknown> = {}) =>
    ({ type: 'resource', resource: { uri: EMBEDDED_URI, ...resource }, ...beside });
  const TEXT_FILE = embedded({ mimeType: 'text/plain', text: 'zz-embedded-text' });
  const IMAGE_FILE = embedded({ mimeType: 'image/png', blob: PNG });
  const AUDIO_FILE = embedded({ mimeType: 'audio/wav', blob: BASE64 });
  const NATIVE_PNG = { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } };
  /** Each embedded resource whose contents no lane shows as themselves, and the line in their place. */
  const UNSHOWN: Array<[string, unknown, string]> = [
    ['a blob of a type no lane shows', embedded({ mimeType: 'application/pdf', blob: BASE64 }),
      "[Resource not shown: this host can't display its data (application/pdf, ~3KB).]"],
    ['a blob with no media type', embedded({ blob: BASE64 }), '[Resource not shown: its data arrived without a media type.]'],
    // A media type with no subtype is no image or audio type.
    ['a blob of a bare image type', embedded({ mimeType: 'image', blob: BASE64 }),
      "[Resource not shown: this host can't display its data (image, ~3KB).]"],
    ['a blob of an image type with an empty subtype', embedded({ mimeType: 'image/', blob: BASE64 }),
      "[Resource not shown: this host can't display its data (image/, ~3KB).]"],
    // An image blob that's empty reads as an inline image with no data does.
    ['an empty image blob', embedded({ mimeType: 'image/png', blob: '' }), IMAGE_NO_DATA_TEXT],
    ['both text and a blob', embedded({ text: 'zz', blob: BASE64 }),
      '[Resource not shown: its contents arrived as neither text nor data, or as both.]'],
    ['neither text nor a blob', embedded({ mimeType: 'text/plain' }),
      '[Resource not shown: its contents arrived as neither text nor data, or as both.]'],
    // Inline content claiming bulk disposition, RFC-005's vector 2.
    ['a disposition', embedded({ text: 'zz' }, { disposition: 'ref' }), INLINE_WITHHELD_TEXT],
  ];

  it('is told by its own fields, and a resource with a uri of its own stays a reference', () => {
    // What the push lane shows the agent for each.
    const shown = (block: unknown) => convertBlock(block as never, 'p', 's');
    assert.deepEqual(shown(TEXT_FILE), { type: 'text', text: 'zz-embedded-text' });
    assert.deepEqual(shown(IMAGE_FILE), NATIVE_PNG);
    const reference = shown({ ...TEXT_FILE, uri: EMBEDDED_URI }) as { type: string; text?: string };
    assert.ok(reference.type === 'text' && reference.text?.startsWith('[ref_') && !reference.text.includes(SECRET), JSON.stringify(reference));
    // A record under resource with no string uri isn't one, as before.
    for (const resource of [{ text: 'zz' }, { uri: 7, text: 'zz' }, 'zz']) {
      assert.deepEqual(shown({ type: 'resource', resource }), { type: 'text', text: REFERENCE_NO_LINK_TEXT });
    }
    // A top-level uri that's null or empty is none of its own.
    for (const uri of [null, '']) {
      assert.deepEqual(shown({ ...TEXT_FILE, uri }), shown(TEXT_FILE), String(uri));
    }
    // Any disposition withholds it, a falsy one included, as for inline data.
    for (const disposition of [null, false, 0, '']) {
      assert.deepEqual(shown({ ...TEXT_FILE, disposition }), { type: 'text', text: INLINE_WITHHELD_TEXT }, String(disposition));
    }
    // A media type's family is read whatever its case, and kept as sent.
    assert.deepEqual(shown(embedded({ mimeType: 'Image/PNG', blob: PNG })),
      { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'Image/PNG' } });
    assert.deepEqual(shown(embedded({ mimeType: 'AUDIO/WAV', blob: BASE64 })),
      { type: 'audio', source: { type: 'base64', data: BASE64, mediaType: 'AUDIO/WAV' } });
  });

  it('shows its text as text in both copies of a tool result, on the push lane and at any depth, never its uri', () => {
    const { stored, live } = copies({ success: true, data: [TEXT, TEXT_FILE], dataIsContent: true });
    assert.equal(stored, 'zz-text\nzz-embedded-text');
    assert.equal(live, stored);
    assert.equal(toolResultDataToHistoryString([TEXT, TEXT_FILE]), 'zz-text\nzz-embedded-text');
    assert.deepEqual(convertBlock(TEXT_FILE as never, 'attachment on push event', 'zz-files'), { type: 'text', text: 'zz-embedded-text' });
    assert.deepEqual(JSON.parse(toolResultDataToHistoryString({ found: [TEXT_FILE], page: 2 })), { found: ['zz-embedded-text'], page: 2 });
    assert.equal(toolResultDataToHistoryString(TEXT_FILE), 'zz-embedded-text');
    // An empty uri under resource is still a string uri, at the top and at
    // any depth alike.
    const emptyUri = { type: 'resource', resource: { uri: '', text: 'zz-empty-uri' } };
    assert.equal(toolResultDataToHistoryString([TEXT, emptyUri]), 'zz-text\nzz-empty-uri');
    assert.deepEqual(JSON.parse(toolResultDataToHistoryString({ found: [emptyUri, { ...IMAGE_FILE, resource: { ...IMAGE_FILE.resource, uri: '' } }] })),
      { found: ['zz-empty-uri', '[image: image/png, 9B]'] });
  });

  it('shows a blob of an image type as an image, native in the live copy and on the push lane', () => {
    const { stored, live } = copies({ success: true, data: [TEXT, IMAGE_FILE], dataIsContent: true });
    assert.equal(stored, 'zz-text\n[image: image/png, 9B]');
    assert.deepEqual(live, [{ type: 'text', text: 'zz-text' }, NATIVE_PNG]);
    assert.deepEqual(convertBlock(IMAGE_FILE as never, 'attachment on push event', 'zz-files'), NATIVE_PNG);
    assert.deepEqual(JSON.parse(toolResultDataToHistoryString({ found: [IMAGE_FILE] })), { found: ['[image: image/png, 9B]'] });
  });

  it("is an image the ledger retains, through a model's round", async () => {
    const { wire, stored } = await answerModelCall({ success: true, data: [IMAGE_FILE, TEXT], dataIsContent: true });
    // The placeholder carries the ref the ledger retained the image under.
    assert.equal(stored.replace(/ref img_[A-Za-z0-9]+_\d+/, 'ref IMG'), JSON.stringify(['[image: image/png, 9B, ref IMG]\nzz-text']));
    assert.equal(wire, JSON.stringify([[NATIVE_PNG, { type: 'text', text: 'zz-text' }]]));
  });

  it("shows a blob of an audio type as a tool result's audio marker, and as audio on the push lane", () => {
    const { stored, live } = copies({ success: true, data: [TEXT, AUDIO_FILE], dataIsContent: true });
    assert.equal(stored, `zz-text\n${AUDIO_TEXT}`);
    assert.equal(live, stored);
    assert.deepEqual(convertBlock(AUDIO_FILE as never, 'attachment on push event', 'zz-files'),
      { type: 'audio', source: { type: 'base64', data: BASE64, mediaType: 'audio/wav' } });
    assert.deepEqual(JSON.parse(toolResultDataToHistoryString({ found: [AUDIO_FILE] })), { found: [AUDIO_TEXT] });
  });

  it("shows contents no lane shows as themselves as their marker, or withheld, on every lane", () => {
    for (const [what, block, line] of UNSHOWN) {
      const { stored, live } = copies({ success: true, data: [TEXT, block], dataIsContent: true });
      assert.equal(stored, `zz-text\n${line}`, what);
      assert.equal(live, stored, what);
      assert.deepEqual(convertBlock(block as never, 'attachment on push event', 'zz-files'), { type: 'text', text: line }, what);
      assert.deepEqual(JSON.parse(toolResultDataToHistoryString({ found: [block] })), { found: [line] }, what);
    }
    const all = [
      toolResultDataToHistoryString([TEXT, TEXT_FILE, IMAGE_FILE, AUDIO_FILE, ...UNSHOWN.map(([, block]) => block)]),
      toolResultDataToHistoryString({ found: [TEXT_FILE, IMAGE_FILE, AUDIO_FILE, ...UNSHOWN.map(([, block]) => block)] }),
    ].join('\n');
    assert.ok(!all.includes(SECRET) && !all.includes('embedded.txt') && !all.includes(BASE64.slice(0, 64)), all);
  });

  it("counts toward the live copy's cap as the block it shows as: a marker as a marker, its text as text", () => {
    // One audio blob's marker fits a cap of 100 beside an image; two pass it,
    // so the live copy is the stored text, as for inline audio.
    const one = copies({ success: true, data: [IMAGE, AUDIO_FILE], dataIsContent: true }, 100).live as Array<{ type: string; text?: string }>;
    assert.deepEqual(one.map((b) => b.text ?? b.type), ['image', AUDIO_TEXT]);
    const two = copies({ success: true, data: [IMAGE, AUDIO_FILE, AUDIO_FILE], dataIsContent: true }, 100);
    assert.equal(two.live, two.stored);
    // So for a type no lane shows, whose marker is its own.
    const pdf = embedded({ mimeType: 'application/pdf', blob: BASE64 });
    assert.ok(Array.isArray(copies({ success: true, data: [IMAGE, pdf], dataIsContent: true }, 100).live));
    const pdfs = copies({ success: true, data: [IMAGE, pdf, pdf], dataIsContent: true }, 100);
    assert.equal(pdfs.live, pdfs.stored);
    // An embedded text, however long, is a text block, cut at the cap on its
    // own beside the image.
    const long = embedded({ mimeType: 'text/plain', text: 'z'.repeat(500) });
    const cut = copies({ success: true, data: [IMAGE, long], dataIsContent: true }, 100).live as Array<{ type: string; text?: string }>;
    assert.equal(cut[0]!.type, 'image');
    assert.match(cut[1]!.text!, /^z{100}\n\n\[truncated — original was 500 chars\]$/);
  });

  it("counts as shown in a render result's block check where its contents are, and not where they aren't", () => {
    const check = (content: unknown[]) => validateCoalescedContent(content, { allowEmpty: true, checkBlockShapes: true });
    check([TEXT_FILE, IMAGE_FILE, AUDIO_FILE]);
    for (const [what, block] of UNSHOWN) assert.throws(() => check([block]), CoalesceError, what);
  });

  it("reaches a script as the block its contents make, as the model's lanes show it, never its uri", () => {
    // Ada-1017, room-203 #206688: main gave a script the no-link notice.
    assert.deepEqual(referenceBlockForScript(TEXT_FILE), { type: 'text', text: 'zz-embedded-text' });
    assert.deepEqual(referenceBlockForScript(IMAGE_FILE, 'zz-files'), { type: 'image', data: PNG, mimeType: 'image/png' });
    assert.deepEqual(referenceBlockForScript(AUDIO_FILE), { type: 'audio', data: BASE64, mimeType: 'audio/wav' });
    for (const [what, block, line] of UNSHOWN) {
      const expected = what === 'an empty image blob'
        // Inline data that claims nothing reaches a script as sent, an
        // empty image's among it, where the model's lanes show its marker.
        ? { type: 'image', data: '', mimeType: 'image/png' }
        : { type: 'text', text: line };
      assert.deepEqual(referenceBlockForScript(block), expected, what);
    }
    // At any depth, as history's rules apply there, and given again, each is
    // as it was.
    const view = JSON.parse(JSON.stringify({ found: [TEXT_FILE, IMAGE_FILE, AUDIO_FILE, ...UNSHOWN.map(([, block]) => block)] },
      (_key, value: unknown) => shownToScript(value))) as { found: unknown[] };
    assert.deepEqual(view.found.slice(0, 3), [
      { type: 'text', text: 'zz-embedded-text' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
      { type: 'audio', data: BASE64, mimeType: 'audio/wav' },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(view, (_key, value: unknown) => shownToScript(value))), view);
    assert.ok(!JSON.stringify(view).includes(SECRET) && !JSON.stringify(view).includes('embedded.txt'), JSON.stringify(view));
  });

  it("withholds its uri, where it claims never, from a link of the same result, as inline data's never does; only its never counts", () => {
    const SEALED_URI = 'https://zz-docs.example/sealed.txt';
    const link = { ...PLAIN_LINK, uri: SEALED_URI };
    const linkLine = `[resource link "report.csv": ${SEALED_URI}, text/csv; not fetched]`;
    const sealed = { type: 'resource', disposition: 'never', resource: { uri: SEALED_URI, mimeType: 'text/plain', text: 'zz-sealed' } };
    // Without it, the link's line shows its uri.
    assert.equal(toolResultDataToHistoryString([TEXT, link]), `zz-text\n${linkLine}`);
    // Ada-1017, room-203 #206688: its never counts in the result's claims,
    // on the model's line as a content array and at depth.
    const line = toolResultDataToHistoryString([sealed, link]);
    assert.ok(line.startsWith(`${INLINE_WITHHELD_TEXT}\n`) && !line.includes(SEALED_URI), line);
    const nested = toolResultDataToHistoryString({ a: sealed, b: link });
    assert.ok(!nested.includes(SEALED_URI), nested);
    assert.equal(contentClaimsOf([sealed]).get(SEALED_URI)?.never, true);
    // A script's view reads the same claims, so the link's object carries no uri.
    const claims = scriptViewClaims([sealed, link], false);
    assert.equal(claims.get(SEALED_URI)?.never, true);
    assert.equal('uri' in (referenceBlockForScript(link, undefined, claims) as object), false);
    assert.equal((referenceBlockForScript(link, undefined, scriptViewClaims([link], false)) as { uri?: string }).uri, SEALED_URI);
    // Another disposition withholds the embedded resource and claims nothing
    // of its uri.
    assert.equal(toolResultDataToHistoryString([{ ...sealed, disposition: 'ref' }, link]), `${INLINE_WITHHELD_TEXT}\n${linkLine}`);
    // An empty uri names nothing, so it marks nothing (#200094).
    assert.equal(contentClaimsOf([{ ...sealed, resource: { ...sealed.resource, uri: '' } }]).size, 0);
  });

  it('makes its marker well formed on the push lane and in a tool result, as a stub is (#695)', () => {
    const odd = embedded({ mimeType: 'application/zz\uD800', blob: BASE64 });
    const pushed = convertBlock(odd as never, 'attachment on push event', 'zz-files') as { type: string; text: string };
    assert.equal(pushed.type, 'text');
    assert.ok(pushed.text.startsWith('[Resource not shown') && pushed.text.isWellFormed(), JSON.stringify(pushed.text));
    assert.ok(copies({ success: true, data: [TEXT, odd], dataIsContent: true }).stored.isWellFormed());
    // Where it's made, so a script's view and the whole text of one alone
    // carry the same well-formed marker.
    const scripted = referenceBlockForScript(odd) as { type: string; text: string };
    assert.deepEqual(scripted, { type: 'text', text: pushed.text });
    assert.equal(toolResultDataToHistoryString(odd), pushed.text);
  });

  it('makes its text well formed as the whole result, as a content array makes its texts', () => {
    const lone = embedded({ mimeType: 'text/plain', text: 'zz-\uD800-text' });
    const { stored, live } = copies({ success: true, data: lone });
    assert.equal(stored, 'zz-\uFFFD-text');
    assert.deepEqual(live, stored);
    assert.equal(toolResultDataToHistoryString(lone), 'zz-\uFFFD-text');
  });

  it("is read by history's walk as the text it shows, never through its fields", () => {
    // A never in its _meta, which nothing shows, doesn't count: the link
    // beside it keeps its line, at depth and in a script's view.
    const URI = 'https://zz-docs.example/beside.txt';
    const link = { ...PLAIN_LINK, uri: URI };
    const meta = { ...TEXT_FILE, _meta: { note: { type: 'resource', uri: URI, name: 'beside.txt', disposition: 'never' } } };
    const shown = toolResultDataToHistoryString({ a: meta, b: link });
    assert.equal(shown, JSON.stringify({ a: 'zz-embedded-text', b: `[resource link "report.csv": ${URI}, text/csv; not fetched]` }));
    assert.equal(scriptViewClaims([{ type: 'text', text: 'zz', nested: meta }], false).has(URI), false);
  });

  it('keeps nothing when withheld, where it is the whole of the data', () => {
    // Ada-1017, room-203 #207161: its text is the withheld body, and a field
    // picked out of it is data that shows its uri.
    assert.equal(keptWhenWithheld({ success: true, data: TEXT_FILE, keepWhenWithheld: ['resource', 'type'] }, undefined), undefined);
    // A record that isn't one keeps its fields, as before.
    assert.equal(keptWhenWithheld({ success: true, data: { type: 'note', name: 'zz-kept' }, keepWhenWithheld: ['name'] }, undefined), '{"name":"zz-kept"}');
  });

  it('counts as nothing to see where its contents are blank text, and as something where they are anything else', () => {
    // Ada-1017, room-203 #207161: the coalescer's render, a push and a
    // channel message judge it as the block its contents make.
    assert.equal(isVisiblyEmptyContent([embedded({ mimeType: 'text/plain', text: ' \n ' })]), true);
    assert.equal(isVisiblyEmptyContent([embedded({ mimeType: 'text/plain', text: 'zz' })]), false);
    for (const block of [IMAGE_FILE, AUDIO_FILE, ...UNSHOWN.map(([, b]) => b)]) {
      assert.equal(isVisiblyEmptyContent([block]), false, JSON.stringify(block).slice(0, 80));
    }
  });
});

describe('dataIsContent travels with the result', () => {
  it('is kept as its truth when a module\'s result is checked, read once', () => {
    const call = { id: 'zz', name: 'zz_tool', input: {} };
    assert.equal(checkedToolResult(call, { success: true, data: [TEXT], dataIsContent: 1 }).result.dataIsContent, true);
    assert.equal(checkedToolResult(call, { success: true, data: [TEXT], dataIsContent: 0 }).result.dataIsContent, false);
    assert.equal('dataIsContent' in checkedToolResult(call, { success: true, data: [TEXT] }).result, false);
    let reads = 0;
    class Answer {
      success = true;
      data = [TEXT, VIDEO];
      get dataIsContent() { reads += 1; return true; }
    }
    assert.equal(checkedToolResult(call, new Answer()).result.dataIsContent, true);
    assert.equal(reads, 1);
  });

  it("through a model's round, an image past the stored copy's cut keeps no slot there when the live copy is the stored text", async () => {
    // With the links before the image passing the cap, the model reads the
    // stored text, cut before the image's placeholder: no slot of it is kept
    // past the cut, since the model never saw it.
    const links = Array.from({ length: 30 }, (_, i) =>
      ({ type: 'resource_link', uri: `https://zz-files.example/${'p'.repeat(1000)}/${i}.csv`, name: `${i}.csv` }));
    const { wire, stored } = await answerModelCall({ success: true, data: [TEXT, ...links, IMAGE], dataIsContent: true });
    assert.equal(wire, stored);
    const [text] = JSON.parse(stored) as string[];
    assert.ok(!text!.includes('fell past the cut'), text!.slice(-400));
    assert.ok(!/\[image: image\/png/.test(text!), text!.slice(-400));
  });

  it("through a model's round, sends the stored copy when its links pass the cap together", async () => {
    const links = Array.from({ length: 30 }, (_, i) =>
      ({ type: 'resource_link', uri: `https://zz-files.example/${'p'.repeat(1000)}/${i}.csv`, name: `${i}.csv` }));
    const { wire, stored } = await answerModelCall({ success: true, data: [IMAGE, TEXT, ...links], dataIsContent: true });
    assert.equal(wire, stored);
    const [text] = JSON.parse(stored) as string[];
    // The image's placeholder keeps its ledger ref, and the text is cut at the cap.
    assert.match(text!, /^\[image: image\/png, 9B, ref img_[a-z0-9]+_\d+\]\nzz-text\n/);
    assert.ok(text!.length < 24_000 + 500, String(text!.length));
  });

  it("through a model's round, from a module's result: both copies show its blocks", async () => {
    for (const dataIsContent of [true, undefined]) {
      const { wire, stored } = await answerModelCall({ success: true, data: [IMAGE, TEXT, AUDIO, VIDEO], ...(dataIsContent ? { dataIsContent } : {}) });
      if (dataIsContent) {
        // The image's placeholder carries the ref the ledger retained it under.
        assert.equal(stored.replace(/ref img_[A-Za-z0-9]+_\d+/, 'ref IMG'), JSON.stringify([`[image: image/png, 9B, ref IMG]\nzz-text\n${AUDIO_TEXT}\n${unknownBlockText(VIDEO)}`]));
        assert.equal(wire, JSON.stringify([[
          { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } },
          { type: 'text', text: 'zz-text' },
          { type: 'text', text: AUDIO_TEXT },
          { type: 'text', text: unknownBlockText(VIDEO) },
        ]]));
      } else {
        // Without it, the block of a type MCP doesn't define makes the array data.
        assert.equal(stored, JSON.stringify([JSON.stringify([IMAGE, TEXT, AUDIO, VIDEO])]));
        assert.equal(wire, stored);
      }
    }
  });

  test("an MCPL tool's result carries it, to the model's call, an in-process caller and the puppet's stored pair", { timeout: 30_000 }, async (t) => {
    // The fixture's server is dialed at ws://127.0.0.1:<port>, so a link on
    // that origin can be fetched, and one elsewhere can't.
    let BLOCKS: unknown[] = [];
    const f = await fixture({
      tools: [{ name: 'lookup', description: 'Look something up.', inputSchema: { type: 'object' } }],
      toolsCall: (params) => ((params.arguments as { case: string }).case === 'text'
        ? { content: [TEXT, { type: 'text', text: 'zz-more' }] }
        : { content: BLOCKS }),
    });
    t.after(f.close);
    const elsewhere = `https://zz-files.example/mcpl.csv?sig=${SECRET}`;
    const plain = 'https://zz-files.example/mcpl.csv';
    const own = `http://127.0.0.1:${f.port}/mcpl.csv?sig=${SECRET}`;
    BLOCKS = [TEXT, VIDEO, AUDIO, { ...LINK, uri: own }, { ...LINK, uri: elsewhere, name: 'elsewhere.csv' }, { ...LINK, uri: plain, name: 'plain.csv' }];
    assert.deepEqual(referenceRegistry.serverAddress('editor'), { url: `ws://127.0.0.1:${f.port}` });
    const internals = f.framework as unknown as { pushEvent(event: unknown): void; dispatchToolCall(agent: string, call: unknown): void };
    const viaModel = (id: string, c: string) => new Promise<ToolResult>((resolve) => {
      const original = internals.pushEvent;
      internals.pushEvent = (event: unknown) => {
        const e = event as { type: string; callId?: string; result?: ToolResult };
        if (e.type === 'tool-result' && e.callId === id) { internals.pushEvent = original; resolve(e.result!); }
        else original.call(internals, event);
      };
      internals.dispatchToolCall('agent', { id, name: 'mcpl--editor--lookup', input: { case: c } });
    });
    // The puppet stores the pair from a checked copy of the in-process
    // result. It runs first, while the agent is idle.
    const { toolUseId } = await f.framework.puppetToolCall('agent', 'mcpl--editor--lookup', { case: 'blocks' });
    const stored = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content as unknown as Array<Record<string, unknown>>)
      .find((b) => b.type === 'tool_result' && b.toolUseId === toolUseId);
    const model = await viaModel('zz-model', 'blocks');
    assert.equal(model.dataIsContent, true);
    assert.deepEqual(model.data, BLOCKS);
    const expected = nonErrorResultText(model);
    // The server's own link fetches. Another origin's, which may carry a
    // credential, says why it can't be fetched, and the plain one shows its uri.
    assert.match(expected, new RegExp(
      `^zz-text\\n\\[Content not shown: this host can't display "video" content\\.\\]\\n\\[Audio not shown: [^\\n]+\\n${STUB.source}fetch with fetch_reference\\n`
      + `\\[ref_[^\\]]+\\] elsewhere\\.csv — text/csv, ~1KB claimed — from tool result — third-party origin: it isn't on its server's own address, so this host doesn't fetch it\\n`
      + `\\[resource link "plain\\.csv": https://zz-files\\.example/mcpl\\.csv, text/csv; not fetched\\]$`));
    assert.ok(!expected.includes(SECRET), expected);
    assert.deepEqual(referenceRegistry.findByUri(own)?.serverIds, ['editor']);
    // The puppet's stored pair holds what a model's call stores.
    assert.equal(stored?.content, expected);
    // A text-only result is still its joined text, and carries nothing more.
    const text = await viaModel('zz-text', 'text');
    assert.deepEqual([text.data, text.dataIsContent], ['zz-text\nzz-more', undefined]);
    const inProcess = await f.framework.executeToolCall({ id: 'zz-x', name: 'mcpl--editor--lookup', input: { case: 'blocks' } });
    assert.deepEqual([inProcess.data, inProcess.dataIsContent], [BLOCKS, true]);
    // A server the framework removes is forgotten, and a link of its then
    // can't be fetched.
    await f.framework.disconnectMcplServer('editor');
    assert.equal(referenceRegistry.serverAddress('editor'), undefined);
    assert.match(nonErrorResultText(model), new RegExp(`\\n${STUB.source}this host no longer has the "editor" server it came from\\n`));
  });
});

test("a framework's stop takes its servers' addresses out of the registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-result-blocks-lifecycle-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  const framework = await AgentFramework.create({
    store,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', allowedTools: 'all' }],
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  try {
    (framework as unknown as { setMcplServerConfig(config: unknown): void })
      .setMcplServerConfig({ id: 'zz-lifecycle', url: 'wss://zz-lifecycle.example' });
    framework.start();
    assert.deepEqual(referenceRegistry.serverAddress('zz-lifecycle'), { url: 'wss://zz-lifecycle.example' });
    await framework.stop();
    assert.equal(referenceRegistry.serverAddress('zz-lifecycle'), undefined);
  } finally {
    await framework.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a framework's start() puts its servers' addresses in force over another framework's for the same id", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-result-blocks-precedence-'));
  const stores: JsStore[] = [];
  const frameworks: AgentFramework[] = [];
  const create = async (name: string, url: string) => {
    const store = JsStore.openOrCreate({ path: join(dir, name) });
    stores.push(store);
    const framework = await AgentFramework.create({
      store,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', allowedTools: 'all' }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    frameworks.push(framework);
    (framework as unknown as { setMcplServerConfig(config: unknown): void })
      .setMcplServerConfig({ id: 'zz-precedence', url });
    return framework;
  };
  try {
    const first = await create('first', 'wss://zz-first.example');
    await create('second', 'wss://zz-second.example');
    assert.deepEqual(referenceRegistry.serverAddress('zz-precedence'), { url: 'wss://zz-second.example' }, 'the one configured last is in force');
    first.start();
    assert.deepEqual(referenceRegistry.serverAddress('zz-precedence'), { url: 'wss://zz-first.example' }, "the first's start puts its own in force");
  } finally {
    for (const framework of frameworks) await framework.stop();
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A module whose one tool answers with the result it was given. */
class AnswerModule implements Module {
  readonly name = 'content';
  constructor(private readonly answer: ToolResult) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'get', description: 'Answer with content.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return this.answer;
  }
  async onProcess(): Promise<Record<string, never>> {
    return {};
  }
}

/** The content of the tool result the model received for one call, and of what the agent's history stored. */
async function answerModelCall(answer: ToolResult): Promise<{ wire: string; stored: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'tool-result-blocks-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', allowedTools: 'all' }],
    modules: [new AnswerModule(answer)],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  try {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'zz-call', name: 'content--get', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-done' }]));
    framework.start();
    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'agent', reason: 'external-message', source: 'test', timestamp: Date.now(),
    });
    const stream = () => membrane.lastStream as unknown as { receivedToolResults: unknown[][] } | undefined;
    const deadline = Date.now() + 5_000;
    while ((stream()?.receivedToolResults.length ?? 0) < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const received = stream()?.receivedToolResults[0];
    assert.ok(received, 'the model was answered');
    const stored = framework.getAgent('agent')!.getContextManager().getAllMessages()
      .flatMap((message) => message.content)
      .filter((block) => (block as { type?: string }).type === 'tool_result');
    assert.equal(stored.length, 1, 'the history holds the tool result');
    const contentOf = (results: unknown[]) => JSON.stringify(results.map((r) => (r as { content?: unknown }).content));
    return { wire: contentOf(received), stored: contentOf(stored) };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('one answer for every block of a result', () => {
  it("withholds a link's uri wherever a reference in the same result marks it never, whatever the blocks' order", () => {
    const uri = 'https://zz-elsewhere.example/order-never.csv';
    const link = { type: 'resource_link', uri, name: 'order.csv' };
    const never = { type: 'resource', uri, name: 'order.csv', disposition: 'never' };
    const plain = { type: 'resource', uri, name: 'order.csv' };
    const STUB = /^\[ref_[^\]]+\] order\.csv — from tool result — /;
    for (const order of [[link, never, plain], [never, link, plain], [never, plain, link], [plain, never, link], [plain, link, never]]) {
      const what = order.map((b) => (b === link ? 'link' : b === never ? 'never' : 'plain')).join(', ');
      const lines = toolResultDataToHistoryString([TEXT, ...order]).split('\n');
      // Each block is there, the link as a stub with no uri.
      assert.equal(lines.length, 4, `${what}: ${lines.join('\n')}`);
      assert.ok(lines.slice(1).every((line) => STUB.test(line)), `${what}: ${lines.join('\n')}`);
      // At any depth in data too.
      const deep = JSON.parse(toolResultDataToHistoryString({ first: order.slice(0, 1), then: { rest: order.slice(1) } })) as
        { first: string[]; then: { rest: string[] } };
      assert.ok([...deep.first, ...deep.then.rest].every((stub) => STUB.test(stub)), `${what}: ${JSON.stringify(deep)}`);
      // And in a script's object, with the array's claims.
      const claims = contentClaimsOf(order);
      for (const block of order) {
        const object = referenceBlockForScript(block, 'zz-files', claims) as { type: string; uri?: string; refId?: string };
        assert.equal(object.type, block.type, what);
        assert.match(String(object.refId), /^ref_/, what);
        assert.equal(object.uri, undefined, what);
      }
    }
  });

  it("reads an expiry any reference in the same result gives a uri for every block that names it, whatever their order", () => {
    servingFiles();
    const uri = 'https://zz-files.example/order-expired.csv';
    const link = { type: 'resource_link', uri, name: 'order.csv' };
    const expired = { type: 'resource', uri, name: 'order.csv', expiresAt: '2001-01-01T00:00:00Z' };
    const fresh = { type: 'resource', uri, name: 'order.csv', expiresAt: '2099-01-01T00:00:00Z' };
    referenceRegistry.register(testimonyOf(link), 'zz-files');
    const texts = new Set<string>();
    for (const order of [[fresh, link, expired], [expired, link, fresh], [link, fresh, expired]]) {
      const lines = toolResultDataToHistoryString(order).split('\n');
      // The link, which the expiry makes unfetchable, shows its line, and
      // each reference's stub says the reference is expired.
      assert.equal(lines.filter((line) => line === `[resource link "order.csv": ${uri}; not fetched]`).length, 1, lines.join('\n'));
      assert.equal(lines.filter((line) => line.endsWith('— the reference is expired')).length, 2, lines.join('\n'));
      texts.add([...lines].sort().join('\n').replace(/ref_[^\]]+/g, 'ref'));
      // And a script's object for each reference, with the array's claims.
      const claims = contentClaimsOf(order);
      for (const block of [fresh, expired]) {
        const object = referenceBlockForScript(block, 'zz-files', claims) as { expired?: string; unfetchable?: string };
        assert.equal(object.expired, EXPIRY_REASON.passed);
        assert.equal(object.unfetchable, `the reference is ${EXPIRY_REASON.passed}`);
      }
    }
    assert.equal(texts.size, 1);
    // At any depth in data too.
    const deep = JSON.parse(toolResultDataToHistoryString({ first: [link], then: { ref: expired } })) as { first: string[]; then: { ref: string } };
    assert.deepEqual(deep.first, [`[resource link "order.csv": ${uri}; not fetched]`]);
    assert.ok(deep.then.ref.endsWith('— the reference is expired'), deep.then.ref);
  });

  it("words competing expiries in a result by EXPIRY_REASON's order, whatever the order of its blocks", () => {
    servingFiles();
    const permutations = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
      : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
    const cases: Array<[string, Array<keyof typeof EXPIRY_REASON>]> = [
      ['competing-all.csv', ['passed', 'unparseable', 'rejected']],
      ['competing-unread.csv', ['unparseable', 'rejected']],
    ];
    for (const [name, kinds] of cases) {
      const uri = `https://zz-files.example/${name}`;
      const expiresAt = { passed: '2001-01-01T00:00:00Z', unparseable: 'zz-not-a-time', rejected: 'x'.repeat(REFERENCE_LIMITS.expiresAt + 1) };
      const blocks = kinds.map((kind) => ({ type: 'resource', uri, name, expiresAt: expiresAt[kind] }));
      referenceRegistry.register(testimonyOf(blocks[0]), 'zz-files');
      // The first of EXPIRY_REASON's cases the blocks give.
      for (const order of permutations(blocks)) {
        const lines = toolResultDataToHistoryString(order).split('\n');
        assert.ok(lines.every((line) => line.endsWith(`— the reference is ${EXPIRY_REASON[kinds[0]!]}`)), lines.join('\n'));
      }
    }
  });

  it("reads the result's own references for a uri before what an earlier result left in the registry, whatever the order", () => {
    servingFiles();
    const uri = 'https://zz-files.example/earlier-expired.csv';
    const link = { type: 'resource_link', uri, name: 'earlier.csv' };
    referenceRegistry.register(testimonyOf(link), 'zz-files');
    // An earlier result left the uri expired.
    toolResultDataToHistoryString([{ type: 'resource', uri, name: 'earlier.csv', expiresAt: '2001-01-01T00:00:00Z' }]);
    const fresh = { type: 'resource', uri, name: 'earlier.csv', expiresAt: '2099-01-01T00:00:00Z' };
    const before = toolResultDataToHistoryString([link, fresh]).split('\n')[0];
    const after = toolResultDataToHistoryString([fresh, link]).split('\n')[1];
    // This result's fresh reference decides: the link is a stub that fetches.
    assert.match(before!, /^\[ref_[^\]]+\] earlier\.csv — from tool result — fetch with fetch_reference$/);
    assert.equal(after, before);
  });

  it("lets a later result's plain reference to a uri lift an earlier result's never, whatever the order of its link and reference", () => {
    const orders: Array<[string, (link: unknown, plain: unknown) => unknown[]]> = [
      ['link-first', (link, plain) => [link, plain]],
      ['reference-first', (link, plain) => [plain, link]],
    ];
    for (const [order, blocks] of orders) {
      const uri = `https://zz-elsewhere.example/lifted-${order}.csv`;
      // An earlier result marks the uri never.
      toolResultDataToHistoryString([{ type: 'resource', uri, name: 'lifted.csv', disposition: 'never' }]);
      // The later result's reference is its server's latest word on the
      // uri, so the link shows it, as if no never had been given.
      const lines = toolResultDataToHistoryString(blocks(
        { type: 'resource_link', uri, name: 'lifted.csv' }, { type: 'resource', uri, name: 'lifted.csv' })).split('\n');
      assert.ok(lines.includes(`[resource link "lifted.csv": ${uri}; not fetched]`), `${order}: ${lines.join('\n')}`);
    }
    // A result naming the uri only in a link leaves the earlier never in force.
    const uri = 'https://zz-elsewhere.example/lifted-link-only.csv';
    toolResultDataToHistoryString([{ type: 'resource', uri, name: 'kept.csv', disposition: 'never' }]);
    assert.match(toolResultDataToHistoryString([{ type: 'resource_link', uri, name: 'kept.csv' }]), /^\[ref_[^\]]+\] kept\.csv — from tool result — /);
  });

  it("finds a never inside inline data's other fields, which showing it descends into, before any block is shown", () => {
    const uri = 'https://zz-elsewhere.example/meta-never.csv';
    const data = {
      items: [
        { type: 'resource_link', uri, name: 'meta.csv' },
        { type: 'image', data: PNG, mimeType: 'image/png', _meta: { ref: { type: 'resource', uri, name: 'meta.csv', disposition: 'never' } } },
      ],
    };
    const shown = JSON.parse(toolResultDataToHistoryString(data)) as { items: [string, { _meta: { ref: string } }] };
    assert.match(shown.items[0], /^\[ref_[^\]]+\] meta\.csv — from tool result — /);
    assert.match(shown.items[1]._meta.ref, /^\[ref_[^\]]+\] meta\.csv — from tool result — /);
    // A content array shows an image, not its fields, so there a reference
    // inside them doesn't count, and the link shows its uri.
    const shownUri = 'https://zz-elsewhere.example/meta-in-array.csv';
    const array = toolResultDataToHistoryString([
      { type: 'resource_link', uri: shownUri, name: 'meta.csv' },
      { type: 'image', data: PNG, mimeType: 'image/png', _meta: { ref: { type: 'resource', uri: shownUri, name: 'meta.csv', disposition: 'never' } } },
    ], undefined, { dataIsContent: true });
    assert.equal(array.split('\n')[0], `[resource link "meta.csv": ${shownUri}; not fetched]`);
  });

  it("keeps a never for its result when more references than the registry holds come between it and the link", () => {
    const uri = 'https://zz-elsewhere.example/evicted-never.csv';
    const many = Array.from({ length: 2001 }, (_, i) => ({ type: 'resource', uri: `https://zz-elsewhere.example/many/${i}.bin`, name: `${i}.bin` }));
    const lines = toolResultDataToHistoryString([
      { type: 'resource', uri, name: 'evicted.csv', disposition: 'never' }, ...many, { type: 'resource_link', uri, name: 'evicted.csv' },
    ]).split('\n');
    assert.equal(lines.length, 2003);
    assert.match(lines[2002]!, /^\[ref_[^\]]+\] evicted\.csv — from tool result — /);
  });

  it("reads claims through toJSON, as serialization does, so a never toJSON gives counts and a getter it leaves out isn't read", () => {
    const uri = 'https://zz-elsewhere.example/to-json-never.csv';
    let reads = 0;
    const value = {
      toJSON: () => ({ ref: { type: 'resource', uri, name: 'to-json.csv', disposition: 'never' } }),
      get unread(): string { reads += 1; return 'zz-unread'; },
    };
    const shown = JSON.parse(toolResultDataToHistoryString({ link: { type: 'resource_link', uri, name: 'to-json.csv' }, value })) as
      { link: string; value: { ref: string } };
    assert.match(shown.link, /^\[ref_[^\]]+\] to-json\.csv — from tool result — /);
    assert.match(shown.value.ref, /^\[ref_[^\]]+\] to-json\.csv — from tool result — /);
    assert.equal(reads, 0);
  });

  it("registers nothing a result's serialization never reaches, such as what lies past a cycle, which shows as the unchecked notice", () => {
    const uri = 'https://zz-elsewhere.example/past-cycle.csv';
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    // The claims walk meets the cycle before the render does, so the result
    // is the notice where main's serializer threw (Ada-1017, room-203
    // #200374), and nothing past the cycle is registered either way.
    const data = { loop, later: { type: 'resource', uri, name: 'past.csv', disposition: 'never' } };
    const error = console.error;
    console.error = () => {};
    try {
      assert.equal(nonErrorResultText({ data }), UNCHECKED_RESULT_TEXT);
    } finally {
      console.error = error;
    }
    // A script's routes take the serializer's own answer: it throws.
    assert.throws(() => toolResultDataToHistoryString(data), TypeError);
    assert.equal(referenceRegistry.findByUri(uri), undefined);
  });

  it("keeps a withheld result's fields as the whole result claims them, so a never elsewhere withholds a kept link's uri", () => {
    const uri = 'https://zz-elsewhere.example/kept-never.csv';
    const kept = keptWhenWithheld({
      success: true,
      data: { files: [{ type: 'resource_link', uri, name: 'kept.csv' }], other: { type: 'resource', uri, name: 'kept.csv', disposition: 'never' } },
      keepWhenWithheld: ['files'],
    }, undefined);
    assert.ok(kept !== undefined && /^\{"files":\["\[ref_[^\]]+\] kept\.csv — from tool result — /.test(kept), kept);
  });

  it("keeps nothing of a withheld result whose claims a value stops the walk of, since what the rest claims is unknown", () => {
    const uri = 'https://zz-elsewhere.example/kept-unread.csv';
    // A getter on the prototype, which the audit's JSON doesn't read, and
    // the claims walk does.
    class Status { get type(): string { throw new Error('zz-unreadable'); } }
    const result = {
      success: true,
      data: { status: new Status(), withheld: { type: 'resource', uri, name: 'kept.csv', disposition: 'never' }, files: [{ type: 'resource_link', uri, name: 'kept.csv' }] },
      keepWhenWithheld: ['files'],
    };
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.equal(keptWhenWithheld(result, undefined), undefined);
  });

  it("reads a result's data once without a stored copy, and sends what that one reading made", () => {
    // Natively, beside an image, and as text, with none.
    for (const [data, expected] of [
      [[IMAGE, TEXT], ['image', 'text']],
      [[TEXT, AUDIO], `zz-text\n${AUDIO_TEXT}`],
    ] as const) {
      let reads = 0;
      const result = { success: true, dataIsContent: true, get data() { reads += 1; return data; } } as unknown as ToolResult;
      const live = framework().toMembraneToolResult('zz-once', result, 1000).content;
      assert.deepEqual(Array.isArray(live) ? (live as Array<{ type: string }>).map((b) => b.type) : live, expected);
      assert.equal(reads, 1, JSON.stringify(expected));
    }
  });

  /** A module's result for a script, its data `data`: what the demand fetch
   *  tried, what it logged, and what the script got. */
  const demandFetch = async (data: unknown[], dataIsContent?: boolean) => {
    const fw = Object.create(AgentFramework.prototype) as {
      getReferenceFetcher(): unknown;
      scriptResultAnswer(result: ToolResult, toolName: string, toServer: boolean): Promise<ScriptAnswer>;
    };
    const fetched: string[] = [];
    fw.getReferenceFetcher = () => ({ fetch: async (record: { testimony: { uri: string } }) => { fetched.push(record.testimony.uri); return { ok: false, error: 'zz-refused' }; } });
    const logged: string[] = [];
    const error = console.error;
    console.error = (line: string) => { logged.push(line); };
    try {
      const answer = await fw.scriptResultAnswer({ success: true, data, ...(dataIsContent ? { dataIsContent } : {}) }, 'zz_tool', false);
      return { fetched, logged, result: { isError: answer.isError === true, text: answerText(answer) } };
    } finally {
      console.error = error;
    }
  };
  const NOT_MADE_EXPIRED = /script-demand fetch of ref_\S+ not made: by the result's claims, the reference is expired/;

  it("isn't fetched for a script on demand where a reference at depth in the module's data gives its uri an expiry, reading the claims as the text does", async () => {
    // Data, not content: its second element isn't a block, so its text reads
    // the result's claims at depth.
    const at = (uri: string, nestedExpiry: string) => [
      { type: 'resource', uri, name: 'deep.pdf', expiresAt: '2099-01-01T00:00:00Z' },
      { nested: { type: 'resource', uri, name: 'deep.pdf', expiresAt: nestedExpiry } },
    ];
    // Where the nested reference is fresh too, the top one is fetched.
    const control = 'https://zz-files.example/demand-deep-fresh.pdf';
    const fresh = await demandFetch(at(control, '2099-06-01T00:00:00Z'));
    assert.equal(fresh.result.isError, false);
    assert.deepEqual(fresh.fetched, [control]);
    // Where it has expired, it isn't, for the expiry only a reading at depth sees.
    const uri = 'https://zz-files.example/demand-deep-expired.pdf';
    const expired = await demandFetch(at(uri, '2001-01-01T00:00:00Z'));
    assert.equal(expired.result.isError, false);
    assert.deepEqual(expired.fetched, []);
    assert.ok(expired.logged.some((line) => NOT_MADE_EXPIRED.test(line)), expired.logged.join('\n'));
  });

  it("is fetched for a script on demand where only a content array's unshown block names its uri expired, as the text reads it", async () => {
    // Content from an MCPL call a module forwards: its elements are blocks,
    // and one the lane doesn't know is a marker, its fields unshown.
    const uri = 'https://zz-files.example/demand-content-flag.pdf';
    const { fetched, result } = await demandFetch([
      { type: 'resource', uri, name: 'flag.pdf', expiresAt: '2099-01-01T00:00:00Z' },
      { type: 'zz-unknown', inner: { type: 'resource', uri, name: 'flag.pdf', expiresAt: '2001-01-01T00:00:00Z' } },
    ], true);
    assert.equal(result.isError, false);
    assert.deepEqual(fetched, [uri]);
  });

  it("isn't fetched for a script on demand where any reference in the module's array gives its uri an expiry that counts", async () => {
    const uri = 'https://zz-files.example/demand-expired.pdf';
    const fresh = { type: 'resource', uri, name: 'demand.pdf', expiresAt: '2099-01-01T00:00:00Z' };
    const expired = { type: 'resource', uri, name: 'demand.pdf', expiresAt: '2001-01-01T00:00:00Z' };
    const { fetched, logged, result } = await demandFetch([fresh, expired], true);
    assert.equal(result.isError, false);
    assert.deepEqual(fetched, []);
    // The fetch not made is logged, as a refused one is.
    assert.ok(logged.some((line) => NOT_MADE_EXPIRED.test(line)), logged.join('\n'));
  });

  it('shows a link that names no uri at depth as its fields, which hold none, and the script lane leaves its own link object as it is', () => {
    // No uri to withhold, as for a reference's stub.
    const named = { type: 'resource_link', name: 'zz-no-uri', size: 10 };
    assert.deepEqual(JSON.parse(toolResultDataToHistoryString({ found: [named] })), { found: [named] });
    // The object a script gets for a link, given to the script lane again,
    // reads the same, its uri left out or shown, and its size kept.
    for (const uri of [LINK_URI, PLAIN_URI]) {
      const object = referenceBlockForScript({ type: 'resource_link', uri, name: 'report.csv', mimeType: 'text/csv', size: 1024 }) as Record<string, unknown>;
      assert.equal(object.sizeBytes, 1024, uri);
      const again = JSON.parse(JSON.stringify([object], (_key, value: unknown) => shownToScript(value))) as unknown[];
      assert.deepEqual(again, [object], uri);
    }
  });

  it('shows a link with no usable uri at any depth as its marker, never its fields', () => {
    for (const uri of ['', 42, null]) {
      const shown = JSON.parse(toolResultDataToHistoryString({ found: [{ type: 'resource_link', uri, name: 'x', description: 'zz-link-description' }] }));
      assert.equal(typeof shown.found[0], 'string', String(uri));
      assert.ok(!JSON.stringify(shown).includes('zz-link-description'), String(uri));
    }
  });

  it("builds the live copy from the stored pass's own blocks, never classifying them again", () => {
    const fw = framework() as unknown as {
      toMembraneToolResult(callId: string, result: ToolResult, maxChars: number | undefined, precomputed: unknown): Live;
    };
    const result: ToolResult = { success: true, data: [IMAGE, PLAIN_LINK], dataIsContent: true };
    // What the stored pass decided, whatever the registry says now.
    const live = fw.toMembraneToolResult('zz', result, 1000, {
      text: 'zz-stored', filePath: null,
      live: [{ kind: 'image', data: PNG, mimeType: 'image/png' }, { kind: 'link', text: 'zz-as-the-stored-pass-wrote-it' }],
    }).content as Array<{ type: string; text?: string }>;
    assert.deepEqual(live.map((b) => b.text ?? b.type), ['image', 'zz-as-the-stored-pass-wrote-it']);
    // And where it decided the stored text, that's the live copy.
    assert.equal(fw.toMembraneToolResult('zz', result, 1000, { text: 'zz-stored', filePath: null, live: null }).content, 'zz-stored');
  });

  it('goes natively with links and markers exactly at the cap, and as the stored text one character past it', () => {
    const cap = AUDIO_TEXT.length * 2;
    const at = copies({ success: true, data: [IMAGE, AUDIO, AUDIO], dataIsContent: true }, cap).live;
    assert.ok(Array.isArray(at), String(at));
    const past = copies({ success: true, data: [IMAGE, AUDIO, AUDIO], dataIsContent: true }, cap - 1);
    assert.equal(past.live, past.stored);
  });

  it("reads a result's own dataIsContent, whatever the options say", () => {
    const data = [TEXT, { type: 'zz-other' }];
    // The result says data, so the array is JSON, though the options say content.
    assert.equal(nonErrorResultText({ data, dataIsContent: false }, undefined, { dataIsContent: true }), JSON.stringify(data));
    // The result says content, so each block shows on its own.
    assert.equal(nonErrorResultText({ data, dataIsContent: true }, undefined, { dataIsContent: false }), `zz-text\n${unknownBlockText({ type: 'zz-other' })}`);
  });

  it('hides a link uri with any one credential parameter, each on its own', () => {
    for (const name of ['X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token', 'X-Goog-Signature', 'X-Goog-Credential',
      'sig', 'signature', 'Key-Pair-Id', 'Policy', 'hm', 'Authorization', 'access_token', 'id_token', 'refresh_token',
      'client_secret', 'oauth_token', 'oauth_signature', 'token', 'auth', 'auth_token', 'key', 'api_key', 'api_token',
      'x-api-key', 'private_token', 'secret', 'password', 'session_id', 'jsessionid']) {
      const uri = `https://zz-elsewhere.example/one-${name}.csv?v=1&${name}=zz`;
      const line = toolResultDataToHistoryString([TEXT, { type: 'resource_link', uri, name: 'one.csv' }]).split('\n')[1]!;
      assert.ok(!line.includes('zz-elsewhere.example'), `${name}: ${line}`);
    }
  });

  it("bounds an audio marker's type and strips its controls", () => {
    const type = `audio/\u202Ewav\u0007${'x'.repeat(300)}`;
    // The array's one block, so the text is its marker alone.
    const marker = toolResultDataToHistoryString([{ type: 'audio', data: BASE64, mimeType: type }], undefined, { dataIsContent: true });
    assert.match(marker, /^\[Audio not shown: /);
    assert.ok(!marker.includes('\u202E') && !marker.includes('\u0007'), marker);
    assert.ok(marker.length < 250, String(marker.length));
  });

  it("gives a script's object for a link whose line shows its uri why its refId would be refused, which the line, having no id, doesn't say", () => {
    // On its server's own origin, so the expiry is the one refusal.
    servingFiles();
    const uri = 'https://zz-files.example/expired-link.csv';
    referenceRegistry.register(testimonyOf({ type: 'resource', uri, name: 'expired.csv', expiresAt: '2001-01-01T00:00:00Z' }));
    const link = { type: 'resource_link', uri, name: 'expired.csv' };
    const object = referenceBlockForScript(link, 'zz-files') as { uri?: string; refId: string; expired?: string; unfetchable?: string };
    assert.equal(object.uri, uri);
    assert.match(object.refId, /^ref_/);
    assert.equal(object.expired, EXPIRY_REASON.passed);
    assert.equal(object.unfetchable, `the reference is ${EXPIRY_REASON.passed}`);
    assert.ok(toolResultDataToHistoryString([TEXT, link]).endsWith(`[resource link "expired.csv": ${uri}; not fetched]`));
  });

  it("reads the clock once for a script's object and once for a stub, so neither disagrees with itself across an expiry", () => {
    servingFiles();
    const expiresAt = '2030-01-01T00:00:00Z';
    const at = Date.parse(expiresAt);
    for (const [what, block] of [
      ['a reference', { type: 'resource', uri: 'https://zz-files.example/clock.csv', name: 'clock.csv', expiresAt }],
      ['a link to a reference', { type: 'resource_link', uri: 'https://zz-files.example/clock-link.csv', name: 'clock.csv' }],
    ] as const) {
      // Its record holds the expiry, as a reference delivered for the link's
      // uri leaves it, before the clock moves.
      referenceRegistry.register(testimonyOf({ ...block, type: 'resource', expiresAt }), 'zz-files');
      const now = Date.now;
      // A clock that reads just before the expiry the first time it's read,
      // and past it every time after.
      let reads = 0;
      Date.now = () => (reads++ === 0 ? at - 1000 : at + 1000);
      let object: { uri?: string; expired?: string; unfetchable?: string };
      let stub: string;
      try {
        object = referenceBlockForScript(block, 'zz-files') as typeof object;
        reads = 0;
        stub = buildReferenceStub(testimonyOf(block), 'from tool result', undefined, { unfetchedLinkUri: true });
      } finally {
        Date.now = now;
      }
      // Each says, as of its one reading, that a fetch would dial.
      assert.deepEqual([object.uri, object.expired, object.unfetchable], [undefined, undefined, undefined], what);
      assert.ok(stub.endsWith('— fetch with fetch_reference'), `${what}: ${stub}`);
    }
  });

  it("asks the resolver once for each server a fetch's check reads, so its address and its credential are one answer", () => {
    const record = referenceRegistry.register(testimonyOf({ type: 'resource', uri: 'https://zz-refs.example/once.bin', name: 'once.bin' }), 'zz-once');
    let asked = 0;
    const fetcher = new ReferenceFetcher(() => {
      asked += 1;
      // A resolver that would answer elsewhere the second time it's asked.
      return asked === 1 ? { url: 'wss://zz-refs.example' } : { url: 'wss://zz-other.example' };
    }, async () => null);
    assert.equal(fetcher.refusal(record), null);
    assert.equal(asked, 1);
  });

  it("pairs each check's origin with the same answer's token and eager limit, on a fetch and on the eager check that joins it", async (t) => {
    const heard: Array<string | undefined> = [];
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => { arrived = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const server = createServer((req, res) => {
      heard.push(req.headers.authorization);
      arrived();
      void held.then(() => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from('zz-bytes'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const record = referenceRegistry.register(
      testimonyOf({ type: 'resource', uri: `http://${host}/answer.bin`, name: 'answer.bin', sizeBytes: 8 }), 'zz-answer');
    // Every answer is on the server's own origin, each with its own token
    // and eager limit, so a second read for one check would mix answers.
    const answers = [
      { url: `ws://${host}`, token: 'zz-first' },
      { url: `ws://${host}`, token: 'zz-second', autofetch: { maxBytes: 1 } },
      { url: `ws://${host}`, token: 'zz-third', autofetch: { maxBytes: 100 } },
    ];
    let asked = 0;
    const fetcher = new ReferenceFetcher(() => answers[Math.min(asked++, answers.length - 1)], async () => 'scratch/answer.bin');
    const fetching = fetcher.fetch(record);
    await arrival;
    assert.equal(asked, 1);
    // The eager check of a record in flight joins it through dialServer,
    // with one answer: the second's eager limit of 1 byte, which 8 bytes pass.
    assert.equal(fetcher.isEagerEligible(record), false);
    assert.equal(asked, 2);
    release();
    assert.equal((await fetching).ok, true);
    assert.deepEqual(heard, ['Bearer zz-first']);
  });

  it("hands the live copy the stored pass's own blocks, so a change between the two leaves the live copy as stored", async () => {
    servingFiles();
    const link = { type: 'resource_link', uri: 'https://zz-files.example/handed.csv', name: 'handed.csv' };
    // Delivered by the zz-files server, as an MCPL dispatch registers it.
    referenceRegistry.register(testimonyOf(link), 'zz-files');
    const result: ToolResult = { success: true, data: [IMAGE, link], dataIsContent: true };
    const fw = Object.create(AgentFramework.prototype) as {
      buildStoredToolResultContent(agent: string, calls: unknown[], maxChars: number | undefined): Promise<{ spilled: Map<string, unknown> }>;
      toMembraneToolResult(callId: string, result: ToolResult, maxChars: number | undefined, precomputed: unknown): Live;
    };
    Object.assign(fw, { toolImageLedgers: new Map() });
    const call = { id: 'zz-handed', name: 'zz_tool', input: {}, result };
    const { spilled } = await fw.buildStoredToolResultContent('zz-agent', [call], 1000);
    const stored = spilled.get('zz-handed') as { text: string; live: unknown[] | null };
    const [, line] = stored.text.split('\n');
    // Fetchable when stored: the link is a stub.
    assert.match(line!, /^\[ref_[^\]]+\] handed\.csv — from tool result — fetch with fetch_reference$/);
    // Then its server's address goes, so classified again it would be a line.
    referenceRegistry.forgetServerAddress('zz-files', TEST_HOST);
    try {
      const live = fw.toMembraneToolResult('zz-handed', result, 1000, stored).content as Array<{ type: string; text?: string }>;
      assert.deepEqual(live.map((b) => b.text ?? b.type), ['image', line]);
    } finally {
      servingFiles();
    }
  });

  it("withholds a uri inline data marks never from a link naming it, in a content array, at depth and in a script's view", () => {
    // Off the server's origin, so a link to it shows its uri where nothing
    // withholds it; the inline block's never does, though it's no reference
    // (Ada-1017, room-203 #201013).
    const uri = 'https://zz-elsewhere.example/inline-never/report.csv';
    const sealed = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri, disposition: 'never' };
    const link = { type: 'resource_link', uri, name: 'report.csv' };
    const control = toolResultDataToHistoryString([link], undefined, { dataIsContent: true });
    assert.ok(control.includes('inline-never'), control);
    for (const shown of [
      toolResultDataToHistoryString([sealed, link], undefined, { dataIsContent: true }),
      toolResultDataToHistoryString({ sealed, link }),
      JSON.stringify(shownToScript(link, scriptViewClaims([sealed, link], false))),
    ]) {
      assert.ok(!shown.includes('inline-never'), shown);
    }
    // Only its never counts: an expiry beside its data claims nothing.
    const dated = { ...sealed, disposition: 'ref', expiresAt: '2000-01-01T00:00:00Z' };
    assert.ok(toolResultDataToHistoryString([dated, link], undefined, { dataIsContent: true }).includes('inline-never'));
  });

  it("withholds a never uri from a link whose uri shows as the same text once well formed, a lone surrogate showing as U+FFFD", () => {
    // Each side as the other shows it: a never with the replacement character
    // and a link with a lone surrogate, and the other way round.
    // Each pair at a path of its own, since the registry keeps each never.
    for (const [i, [sealedEnd, linkEnd]] of [['\uFFFD', '\uD800'], ['\uD800', '\uFFFD']].entries()) {
      const at = `https://zz-elsewhere.example/sur-never-${i}/`;
      const sealed = { type: 'resource', uri: `${at}${sealedEnd}.csv`, name: 'report.csv', disposition: 'never' };
      const link = { type: 'resource_link', uri: `${at}${linkEnd}.csv`, name: 'report.csv' };
      const control = toolResultDataToHistoryString([link], undefined, { dataIsContent: true });
      assert.ok(control.includes(`sur-never-${i}`), control);
      for (const shown of [
        toolResultDataToHistoryString([sealed, link], undefined, { dataIsContent: true }),
        toolResultDataToHistoryString({ sealed, link }),
        JSON.stringify(shownToScript(link, scriptViewClaims([sealed, link], false))),
      ]) {
        assert.ok(!shown.includes(`sur-never-${i}`), shown);
      }
    }
  });

  it("withholds a never uri from a link whose uri shows as the same text, its bidi control cut", () => {
    // The same uri with a right-to-left mark, which sanitizeLabel cuts, so
    // the link would show exactly the text the never withholds: the mark on
    // the link's side, and on the never's, each pair at a path of its own,
    // since the registry keeps each never.
    for (const [i, markOnLink] of [true, false].entries()) {
      const clean = `https://zz-elsewhere.example/cut-never-${i}/report.csv`;
      const marked = `https://zz-elsewhere.example/cut-never-${i}/\u200Freport.csv`;
      const sealed = { type: 'resource', uri: markOnLink ? clean : marked, name: 'report.csv', disposition: 'never' };
      const link = { type: 'resource_link', uri: markOnLink ? marked : clean, name: 'report.csv' };
      const control = toolResultDataToHistoryString([link], undefined, { dataIsContent: true });
      assert.ok(control.includes(`cut-never-${i}/report.csv`), control);
      for (const shown of [
        toolResultDataToHistoryString([sealed, link], undefined, { dataIsContent: true }),
        toolResultDataToHistoryString({ sealed, link }),
        JSON.stringify(shownToScript(link, scriptViewClaims([sealed, link], false))),
      ]) {
        assert.ok(!shown.includes(`cut-never-${i}`), shown);
      }
    }
  });

  it("shows the model the unchecked notice, with a line naming the tool, for whatever stops reading or showing a result, where the serializer throws for a script", () => {
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      // A block of a content array whose text can't be read.
      const unreadable = [{ type: 'text', get text(): string { throw new Error('zz-unreadable text'); } }];
      let blocks = false;
      const text = nonErrorResultText({ data: unreadable, dataIsContent: true }, undefined, { toolName: 'zz_tool', onBlocks: () => { blocks = true; } });
      assert.equal(text, UNCHECKED_RESULT_TEXT);
      assert.equal(blocks, false, 'no live copy of its own: the notice is both copies');
      assert.throws(() => toolResultDataToHistoryString(unreadable, undefined, { dataIsContent: true }), /zz-unreadable text/);
      // A result whose data itself can't be read, as a host's object to the
      // direct Agent API can be.
      const result = { get data(): unknown { throw new Error('zz-unreadable data'); } };
      assert.equal(nonErrorResultText(result, undefined, { toolName: 'zz_data' }), UNCHECKED_RESULT_TEXT);
      const noError = { data: null, get error(): string { throw new Error('zz-unreadable error'); } };
      assert.equal(nonErrorResultText(noError, undefined, { toolName: 'zz_error' }), UNCHECKED_RESULT_TEXT);
      const noFlag = { data: [{ type: 'text', text: 'x' }], get dataIsContent(): boolean { throw new Error('zz-unreadable flag'); } };
      assert.equal(nonErrorResultText(noFlag, undefined, { toolName: 'zz_flag' }), UNCHECKED_RESULT_TEXT);
      // What's thrown can be a value String() can't read itself; the line
      // still goes out, saying so.
      const unprintable = { get data(): unknown { throw Object.create(null); } };
      // The words themselves, which the agent reads, pinned here once.
      assert.equal(UNCHECKED_RESULT_TEXT, "[Result not shown: the tool ran, but its result couldn't be read through, checked for references and shown, so this host withheld it.]");
      assert.equal(nonErrorResultText(unprintable, undefined, { toolName: 'zz_unprintable' }), UNCHECKED_RESULT_TEXT);
      // A render that stops where the claims walk got through: the render
      // registers what it shows, and the claims walk registers nothing.
      const uri = 'https://zz-elsewhere.example/render-stop/report.csv';
      const real = referencesModule.referenceRegistry.register;
      referencesModule.referenceRegistry.register = function (this: unknown, ...args: Parameters<typeof real>) {
        if (args[0].uri === uri) throw new RangeError('Maximum call stack size exceeded');
        return real.apply(referencesModule.referenceRegistry, args);
      } as typeof real;
      try {
        const data = { found: { type: 'resource', uri, name: 'report.csv' } };
        assert.equal(nonErrorResultText({ data }, 100, { toolName: 'zz_deep' }), truncateForHistory(UNCHECKED_RESULT_TEXT, 100));
        assert.throws(() => toolResultDataToHistoryString(data), RangeError);
      } finally {
        referencesModule.referenceRegistry.register = real;
      }
    } finally {
      console.error = error;
    }
    assert.equal(logged.length, 6, logged.join('\n'));
    assert.match(logged[0]!, /tool 'zz_tool'.*zz-unreadable text/);
    assert.match(logged[1]!, /tool 'zz_data'.*zz-unreadable data/);
    assert.match(logged[2]!, /tool 'zz_error'.*zz-unreadable error/);
    assert.match(logged[3]!, /tool 'zz_flag'.*zz-unreadable flag/);
    assert.match(logged[4]!, /tool 'zz_unprintable'.*a value that can't be read/);
    assert.match(logged[5]!, /tool 'zz_deep'.*Maximum call stack size exceeded/);
  });

  it('shows data whose claims walk stops as the unchecked notice, never with no claims, and a round with it completes, both copies alike', async () => {
    // A value that stops the claims walk and not the render's: its type
    // throws a RangeError the first time it's read, as a stack can run out
    // one frame sooner in one walk than in the other, and then reads as data.
    const once = () => {
      let read = false;
      return { get type(): string { if (!read) { read = true; throw new RangeError('Maximum call stack size exceeded'); } return 'note'; } };
    };
    // A link beside a never to its uri, which a render with no claims would show.
    const data = () => ({ link: { type: 'resource_link', uri: PLAIN_URI, name: 'report.csv' }, sealed: { type: 'resource', uri: PLAIN_URI, disposition: 'never' }, deep: once() });
    assert.throws(() => toolResultDataToHistoryString(data()), RangeError, 'a script\'s routes take the serializer\'s own answer');
    const fw = Object.create(AgentFramework.prototype) as {
      buildStoredToolResultContent(agent: string, calls: unknown[], maxChars: number | undefined): Promise<{ blocks: Array<{ content: unknown }>; spilled: Map<string, unknown> }>;
      toMembraneToolResult(callId: string, result: ToolResult, maxChars: number | undefined, precomputed: unknown): Live;
    };
    Object.assign(fw, { toolImageLedgers: new Map(), writeToolResultFile: async () => null, moduleRegistry: { getAllModules: () => [] } });
    const call = { id: 'zz-unchecked', name: 'zz_tool', input: {}, result: { success: true, data: data() } };
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const { blocks, spilled } = await fw.buildStoredToolResultContent('zz-agent', [call], 24_000);
      assert.deepEqual(blocks.map((block) => block.content), [UNCHECKED_RESULT_TEXT]);
      assert.equal(fw.toMembraneToolResult(call.id, call.result, 24_000, spilled.get(call.id)).content, UNCHECKED_RESULT_TEXT);
    } finally {
      console.error = error;
    }
    // The stored copy's builder names the tool in the model lane's log line.
    assert.ok(logged.some((line) => /tool 'zz_tool'.*Maximum call stack size exceeded/.test(line)), logged.join('\n'));
  });

  it("keeps a result's native live copy when its turn's results are stored by their shares of the readers' bound", async () => {
    const fw = Object.create(AgentFramework.prototype) as {
      buildStoredToolResultContent(agent: string, calls: unknown[], maxChars: number | undefined, bound?: number): Promise<{ spilled: Map<string, unknown> }>;
    };
    Object.assign(fw, {
      toolImageLedgers: new Map(), toolRoundsByShare: new WeakSet(),
      writeToolResultFile: async () => null, moduleRegistry: { getAllModules: () => [] },
    });
    // Two results that pass a bound of 600 together, so each is stored by
    // its share; the first holds an image, which goes natively at the cap.
    const withImage = { id: 'zz-share-image', name: 'zz_tool', input: {}, result: { success: true, data: [IMAGE, { type: 'text', text: 'i'.repeat(400) }], dataIsContent: true } };
    const plain = { id: 'zz-share-text', name: 'zz_tool', input: {}, result: { success: true, data: 't'.repeat(400) } };
    const { spilled } = await fw.buildStoredToolResultContent('zz-agent', [withImage, plain], 24_000, 600);
    const stored = spilled.get(withImage.id) as { text: string; live: Array<{ kind: string }> | null };
    assert.ok(stored.text.length < 500, `stored by its share: ${stored.text.length}`);
    assert.deepEqual(stored.live?.map((block) => block.kind), ['image', 'text']);
  });

  it("goes natively from the stored pass with links and markers exactly at the cap, and as its stored text one past it", async () => {
    const fw = Object.create(AgentFramework.prototype) as {
      buildStoredToolResultContent(agent: string, calls: unknown[], maxChars: number | undefined): Promise<{ spilled: Map<string, unknown> }>;
      toMembraneToolResult(callId: string, result: ToolResult, maxChars: number | undefined, precomputed: unknown): Live;
    };
    // A spill that can't be written names where the agent would read it, so
    // the notice asks the module registry for a workspace: there's none.
    Object.assign(fw, { toolImageLedgers: new Map(), writeToolResultFile: async () => null, moduleRegistry: { getAllModules: () => [] } });
    const result: ToolResult = { success: true, data: [IMAGE, AUDIO, AUDIO], dataIsContent: true };
    const cap = AUDIO_TEXT.length * 2;
    for (const [maxChars, native] of [[cap, true], [cap - 1, false]] as const) {
      const call = { id: `zz-cap-${maxChars}`, name: 'zz_tool', input: {}, result };
      const { spilled } = await fw.buildStoredToolResultContent('zz-agent', [call], maxChars);
      const stored = spilled.get(call.id) as { text: string; live: unknown[] | null };
      assert.equal(stored.live !== null, native, String(maxChars));
      const live = fw.toMembraneToolResult(call.id, result, maxChars, stored).content;
      if (native) assert.ok(Array.isArray(live), String(maxChars));
      else assert.equal(live, stored.text, String(maxChars));
    }
  });

  test("an MCPL send whose result has an element that isn't a block before its channel's id still succeeds", { timeout: 30_000 }, async (t) => {
    const f = await fixture({
      tools: [{ name: 'send_message', description: 'Send a message.', inputSchema: { type: 'object' } }],
      toolsCall: () => ({ content: [null, { type: 'text', text: JSON.stringify({ channelId: 'zz-chan' }) }] }),
    });
    t.after(f.close);
    const internals = f.framework as unknown as { pushEvent(event: unknown): void; dispatchToolCall(agent: string, call: unknown): void };
    const result = await new Promise<ToolResult>((resolve) => {
      const original = internals.pushEvent;
      internals.pushEvent = (event: unknown) => {
        const e = event as { type: string; callId?: string; result?: ToolResult };
        if (e.type === 'tool-result' && e.callId === 'zz-send') { internals.pushEvent = original; resolve(e.result!); }
        else original.call(internals, event);
      };
      internals.dispatchToolCall('agent', { id: 'zz-send', name: 'mcpl--editor--send_message', input: { channelId: 'zz-chan' } });
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(nonErrorResultText(result), `${unknownBlockText(null)}\n{"channelId":"zz-chan"}`);
  });

  it("makes an MCPL result with an element that isn't a block its marker, not a failure", async () => {
    const fw = framework() as unknown as {
      mcpToolResult(result: unknown, callId: string, mcplPeer: boolean, serverId: string, callName: string): Promise<ToolResult>;
    };
    const result = await fw.mcpToolResult({ content: [null, TEXT] }, 'zz-null', true, 'zz-server', 'zz-tool');
    assert.equal(result.success, true);
    assert.equal(result.dataIsContent, true);
    assert.equal(nonErrorResultText(result), `${unknownBlockText(null)}\nzz-text`);
  });
});
