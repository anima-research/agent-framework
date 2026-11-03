/**
 * What the agent reads for a text attachment the Discord module tries to
 * fetch: its contents, or a notice that they couldn't be fetched, whether the
 * fetch threw or was answered with a status that wasn't OK.
 *
 * Run: node --import tsx --test test/discord-attachment-notice.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { DiscordClientInterface, DiscordMessageData } from '../src/modules/discord/types.js';

interface ConversionHarness {
  convertMessageToContent(message: DiscordMessageData): Promise<ContentBlock[]>;
}

/** A message whose only content is one small attachment, so its own text,
 *  stored first, is ''. */
function messageWithFile(filename: string, contentType = 'text/plain'): DiscordMessageData {
  return {
    id: 'm1', channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'User', isBot: false,
    content: '', isReply: false, mentionedUserIds: [], timestamp: new Date(0),
    attachments: [{ id: 'a1', filename, url: `https://cdn.example.invalid/${filename}`, contentType, size: 64 }],
  };
}

/** Converts the message with `fetch` answering as `answer` does. */
async function convert(
  t: { after: (fn: () => void) => void },
  answer: () => Promise<Response>,
  message: DiscordMessageData = messageWithFile('notes.txt'),
): Promise<ContentBlock[]> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => answer()) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const module = new DiscordModule({} as unknown as DiscordClientInterface, { token: 'test-token' });
  return (module as unknown as ConversionHarness).convertMessageToContent(message);
}

test('a text attachment whose fetch is answered with a status that isn\'t OK reads as not fetched, not as an empty message', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  let response: Response | undefined;
  const blocks = await convert(t, async () => (response = new Response('gone', { status: 404 })));
  assert.deepEqual(blocks, [{ type: 'text', text: '' }, { type: 'text', text: "[Attachment: notes.txt couldn't be fetched, so its text isn't in your context. If you need it, ask the sender in the channel to paste it.]" }]);
  // The operator's line names the file, the message and the status, and the
  // unread answer is cancelled, so its connection is released.
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments.join(' ')), ['Discord: Attachment notes.txt in message m1 wasn\'t fetched: HTTP 404']);
  assert.equal(response!.bodyUsed, true, 'the unread answer was cancelled');
});

test('a filename that could break a log line is printed quoted, as one field', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const message = messageWithFile('a\nb.txt');
  await convert(t, async () => new Response('gone', { status: 404 }), message);
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments.join(' ')), ['Discord: Attachment "a\\nb.txt" in message m1 wasn\'t fetched: HTTP 404']);
});

test('a text attachment whose fetch throws reads the same', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const blocks = await convert(t, async () => { throw new TypeError('fetch failed'); });
  assert.deepEqual(blocks, [{ type: 'text', text: '' }, { type: 'text', text: "[Attachment: notes.txt couldn't be fetched, so its text isn't in your context. If you need it, ask the sender in the channel to paste it.]" }]);
  assert.equal(warn.mock.calls.length, 1);
  const line = warn.mock.calls[0].arguments.join(' ');
  for (const part of ['notes.txt', 'm1', 'fetch failed']) assert.ok(line.includes(part), `the line names ${part}: ${line}`);
});

test('a text attachment that is fetched is read whole', async (t) => {
  const blocks = await convert(t, async () => new Response('line one', { status: 200 }));
  assert.deepEqual(blocks, [{ type: 'text', text: '' }, { type: 'text', text: '\n--- File: notes.txt ---\nline one\n--- End of notes.txt ---\n' }]);
});

test('an attachment the host doesn\'t read in says its contents aren\'t in context', async (t) => {
  const blocks = await convert(t, async () => { throw new Error('not fetched'); }, messageWithFile('report.pdf', 'application/pdf'));
  assert.deepEqual(blocks, [{ type: 'text', text: '' }, {
    type: 'text',
    text: "[Attachment: report.pdf (application/pdf): this host didn't read its contents in, so they aren't in your context. If you need them, ask the sender for them in a form you can read, such as pasted text.]",
  }]);
});

test('a text attachment too large to read in says so, and isn\'t fetched', async (t) => {
  const sized = (size: number) => {
    const message = messageWithFile('big.txt');
    message.attachments[0]!.size = size;
    return message;
  };
  let fetched = 0;
  const answer = async () => { fetched++; return new Response('x'); };
  const tooLarge = (size: string) => [{ type: 'text', text: '' }, {
    type: 'text',
    text: `[Attachment: big.txt (${size} bytes): this host reads text files under 100,000 bytes into your context, so its text isn't here. If you need it, ask the sender to paste the part that matters.]`,
  }];
  assert.deepEqual(await convert(t, answer, sized(150_000)), tooLarge('150,000'));
  assert.deepEqual(await convert(t, answer, sized(100_000)), tooLarge('100,000'));
  assert.equal(fetched, 0);
  // One byte under the limit is read in.
  assert.deepEqual(await convert(t, answer, sized(99_999)), [{ type: 'text', text: '' }, { type: 'text', text: '\n--- File: big.txt ---\nx\n--- End of big.txt ---\n' }]);
  assert.equal(fetched, 1);
  // A text file whose size is 0 isn't fetched: it gets the note any file not read gets.
  const unread = await convert(t, answer, sized(0));
  assert.equal(fetched, 1);
  assert.match((unread[1] as { text: string }).text, /^\[Attachment: big\.txt \(text\/plain\): this host didn't read its contents in/);
});
