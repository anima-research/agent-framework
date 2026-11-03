/**
 * A channel message's author reaches the model.
 *
 * MCPL's `channels/incoming` carries the author as a field — `author: {id,
 * name}` — and the body alone as content (SPEC §14). The framework stores
 * the message under the anonymous participant `user` with the author in
 * metadata, and nothing between the store and the wire rendered the name,
 * so the model read `user: <text>`: who spoke was lost. Servers that
 * pre-render `Name: body` into the text (portal-mcpl) masked it, and the
 * tune-out backlog, which does read the metadata, doubled their name.
 * Found by Weft's rig with a spec-shaped driver, 2026-10-13 ("Zinnia-Probe").
 *
 * The rule: a message stored under `user` that names an author is stored as
 * `author: text`, unless its text already begins that way. The compiled view
 * carries no metadata, so the name has to be in the stored text to reach the
 * wire; the author stays in `metadata.author` as the structured record.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { renderHeldLine } from '../src/tune-out/coordinator.js';
import { defaultReaderFraming } from '../src/tune-out/tools.js';
import { presentAuthor, authorLine, ANONYMOUS_PARTICIPANT } from '../src/author-presentation.js';

const CHANNEL = 'probe:guild:alpha';

function incoming(text: string, author = { id: 'Z1', name: 'Zinnia-Probe' }): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'probe',
    channelId: CHANNEL,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    author,
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: {},
    tags: ['chat:addressed'],
    triggerInference: true,
  } as unknown as ProcessEvent;
}

const texts = (request: NormalizedRequest): string[] =>
  request.messages.flatMap((m) =>
    m.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text));

describe('author presentation', () => {
  describe('on the wire', () => {
    let tempDir: string;
    let membrane: MockMembrane;
    let framework: AgentFramework;

    beforeEach(async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'author-presentation-'));
      membrane = new MockMembrane();
      framework = await AgentFramework.create({
        storePath: join(tempDir, 'test.chronicle'),
        membrane: membrane.asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
        modules: [],
      });
    });

    afterEach(async () => {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('a spec-shaped message (body only, author in the field) reaches the model as "author: text"', async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Later, yes.' }]));
      framework.pushEvent(incoming('scout, quick question while you are busy: are you free later?'));
      await framework.runUntilIdle();

      assert.equal(membrane.calls.length, 1, 'one turn ran');
      const wire = texts(membrane.calls[0]!);
      assert.ok(
        wire.includes('Zinnia-Probe: scout, quick question while you are busy: are you free later?'),
        `the request names the author:\n${wire.join('\n')}`,
      );
    });

    it('is stored as the model reads it, under the anonymous participant, with the author kept in metadata', async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
      framework.pushEvent(incoming('are you free later?'));
      await framework.runUntilIdle();

      const { messages } = await framework.getAgent('scout')!.getContextManager().compile();
      const stored = messages.find((m) => JSON.stringify(m.content).includes('are you free later?'));
      assert.ok(stored, 'the message is stored');
      assert.equal(stored!.participant, 'user');
      assert.deepEqual(stored!.content, [{ type: 'text', text: 'Zinnia-Probe: are you free later?' }]);
      const row = framework.getAgent('scout')!.getContextManager().getAllMessages()
        .find((m) => JSON.stringify(m.content).includes('are you free later?'));
      assert.deepEqual((row?.metadata as { author?: unknown })?.author, { id: 'Z1', name: 'Zinnia-Probe' });
    });

    it('a server that already renders "Name: body" into the text is not doubled', async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
      framework.pushEvent(incoming('Zinnia-Probe: are you free later?'));
      await framework.runUntilIdle();

      const wire = texts(membrane.calls[0]!);
      assert.ok(wire.includes('Zinnia-Probe: are you free later?'), wire.join('\n'));
      assert.ok(!wire.some((t) => t.includes('Zinnia-Probe: Zinnia-Probe:')), `not doubled:\n${wire.join('\n')}`);
    });
  });

  describe('on the wire, delivered to a conversation fork', () => {
    let tempDir: string;
    let membrane: MockMembrane;
    let framework: AgentFramework;

    beforeEach(async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'author-presentation-fork-'));
      membrane = new MockMembrane();
      framework = await AgentFramework.create({
        storePath: join(tempDir, 'test.chronicle'),
        membrane: membrane.asMembrane(),
        agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' }],
        modules: [],
        conversations: { templateAgent: 'trunk' },
      });
    });

    afterEach(async () => {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    });

    const dm = (text: string, extra: Record<string, unknown> = {}): ProcessEvent => ({
      ...(incoming(text) as unknown as Record<string, unknown>),
      channelId: 'probe:dm:zinnia',
      metadata: { channel_type: 'im' },
      ...extra,
    }) as unknown as ProcessEvent;

    it('a routed message and a correction delivered to the fork by name (deliverTo) are both stored under the author', async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello.' }]));
      framework.pushEvent(dm('hello there'));
      await framework.runUntilIdle();
      const fork = framework.getConversationRouter()!.getBinding({ serverId: 'probe', channelId: 'probe:dm:zinnia' })!.agentName;
      assert.ok(framework.getAgent(fork), 'the DM spawned a fork');

      // RFC-006: a replacement notice follows its delivery into the agent
      // that holds the prior occurrence, named by `deliverTo`.
      const internals = framework as unknown as { handleMcplChannelIncoming(event: unknown): Promise<unknown> };
      await internals.handleMcplChannelIncoming(dm('hello there (edited)', { triggerInference: false, deliverTo: fork }));

      const stored = framework.getAgent(fork)!.getContextManager().getAllMessages()
        .filter((m) => m.participant === 'user')
        .map((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(''));
      assert.ok(stored.includes('Zinnia-Probe: hello there'), `the routed message names its author:\n${stored.join('\n')}`);
      assert.ok(stored.includes('Zinnia-Probe: hello there (edited)'), `the deliverTo correction names its author:\n${stored.join('\n')}`);
      assert.ok(
        !framework.getAgent('trunk')!.getContextManager().getAllMessages().some((m) => JSON.stringify(m.content).includes('hello there')),
        'the trunk holds neither',
      );
    });
  });

  describe('the rule', () => {
    const stored = (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>) =>
      ({ participant, content, ...(metadata ? { metadata } : {}) });

    it('prefixes the first text block of an anonymous message that names an author', () => {
      const m = stored('user', [{ type: 'text', text: 'hi' }], { author: { id: '1', name: 'Alice' } });
      assert.deepEqual(presentAuthor(m).content, [{ type: 'text', text: 'Alice: hi' }]);
      assert.deepEqual(m.content, [{ type: 'text', text: 'hi' }], 'the input is not mutated');
      // The first text block only, wherever it is: not the first block, and not every text block.
      const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA==' } } as unknown as ContentBlock;
      const mixed = stored('user', [image, { type: 'text', text: 'hi' }, { type: 'text', text: 'and more' }], { author: { id: '1', name: 'Alice' } });
      assert.deepEqual(presentAuthor(mixed).content, [image, { type: 'text', text: 'Alice: hi' }, { type: 'text', text: 'and more' }]);
    });

    it('is idempotent: text already beginning with the author\'s name is left alone', () => {
      const m = stored('user', [{ type: 'text', text: 'Alice: hi' }], { author: { id: '1', name: 'Alice' } });
      assert.equal(presentAuthor(m), m);
      // A name that merely prefixes another word is not the author's line.
      const other = stored('user', [{ type: 'text', text: 'Alicent: hi' }], { author: { id: '1', name: 'Alice' } });
      assert.deepEqual(presentAuthor(other).content, [{ type: 'text', text: 'Alice: Alicent: hi' }]);
    });

    it('names the author before media when the message has no text', () => {
      const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA==' } } as unknown as ContentBlock;
      const m = stored('user', [image], { author: { id: '1', name: 'Alice' } });
      assert.deepEqual(presentAuthor(m).content, [{ type: 'text', text: 'Alice:' }, image]);
    });

    it('leaves a named participant, a message without an author, and an empty name as they are', () => {
      const named = stored('Alice', [{ type: 'text', text: 'hi' }], { author: { id: '1', name: 'Alice' } });
      assert.equal(presentAuthor(named), named);
      const anonymous = stored('user', [{ type: 'text', text: 'hi' }], { system: true });
      assert.equal(presentAuthor(anonymous), anonymous);
      const blank = stored('user', [{ type: 'text', text: 'hi' }], { author: { id: '1', name: '' } });
      assert.equal(presentAuthor(blank), blank);
    });

    it('authorLine is the same rule for a single line', () => {
      assert.equal(authorLine('Alice', 'hi'), 'Alice: hi');
      assert.equal(authorLine('Alice', 'Alice: hi'), 'Alice: hi');
      assert.equal(authorLine('Alice', 'Alice:'), 'Alice:');
    });
  });

  describe('tune-out backlog lines', () => {
    const held = (text: string) => ({
      participant: 'user',
      content: [{ type: 'text', text }] as ContentBlock[],
      metadata: { author: { id: 'Z1', name: 'Zinnia-Probe' } },
    });

    it('a release line names the author once, whichever shape the server sent', () => {
      assert.equal(renderHeldLine(held('hello?')), 'Zinnia-Probe: hello?');
      assert.equal(renderHeldLine(held('Zinnia-Probe: hello?')), 'Zinnia-Probe: hello?');
    });

    it('a release line names the author once when media comes before the text, as presentAuthor stores it', () => {
      const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA==' } } as unknown as ContentBlock;
      const stored = presentAuthor({
        participant: ANONYMOUS_PARTICIPANT,
        content: [image, { type: 'text', text: 'hello?' } as ContentBlock],
        metadata: { author: { id: 'Z1', name: 'Zinnia-Probe' } },
      });
      const line = renderHeldLine(stored);
      assert.equal(line.split('Zinnia-Probe:').length - 1, 1, line);
      assert.ok(line.includes('[image]') && line.includes('hello?'), line);
    });

    it('a release line reads a blank author name as no author, as presentAuthor does', () => {
      const content = [{ type: 'text', text: 'hello?' }] as ContentBlock[];
      assert.equal(
        renderHeldLine({ participant: 'user', content, metadata: { author: { id: 'Z1', name: '' } } }),
        renderHeldLine({ participant: 'user', content, metadata: {} }),
      );
    });

    it('the reader framing names the author once, whichever shape the server sent', () => {
      const content = defaultReaderFraming({
        resident: 'scout', fork: 'reader', voice: 'Report.',
        channelId: CHANNEL, epochId: 'e1-epoch', trigger: 'wake', notice: '[Tune-out wake]',
        dispositions: null, backlog: [held('hello?'), held('Zinnia-Probe: again?')],
      } as unknown as Parameters<typeof defaultReaderFraming>[0]);
      const text = content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text).join('\n');
      assert.ok(text.includes('\nZinnia-Probe: hello?\nZinnia-Probe: again?'), text);
    });
  });
});
