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

/** A message whose only content is one small text attachment, so its own
 *  text, stored first, is ''. */
function messageWithTextFile(filename: string): DiscordMessageData {
  return {
    id: 'm1', channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'User', isBot: false,
    content: '', isReply: false, mentionedUserIds: [], timestamp: new Date(0),
    attachments: [{ id: 'a1', filename, url: `https://cdn.example.invalid/${filename}`, contentType: 'text/plain', size: 64 }],
  };
}

/** Converts the message with `fetch` answering as `answer` does. */
async function convert(
  t: { after: (fn: () => void) => void },
  answer: () => Promise<Response>,
  message: DiscordMessageData = messageWithTextFile('notes.txt'),
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
  assert.deepEqual(blocks, [{ type: 'text', text: '' }, { type: 'text', text: '[Attachment: notes.txt (failed to fetch)]' }]);
  // The operator's line names the file, the message and the status, and the
  // unread answer is cancelled, so its connection is released.
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments.join(' ')), ['Discord: Attachment notes.txt in message m1 wasn\'t fetched: HTTP 404']);
  assert.equal(response!.bodyUsed, true, 'the unread answer was cancelled');
});

test('a filename that could break a log line is printed quoted, as one field', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const message = messageWithTextFile('a\nb.txt');
  await convert(t, async () => new Response('gone', { status: 404 }), message);
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments.join(' ')), ['Discord: Attachment "a\\nb.txt" in message m1 wasn\'t fetched: HTTP 404']);
});

test('a text attachment whose fetch throws reads the same', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const blocks = await convert(t, async () => { throw new TypeError('fetch failed'); });
  assert.deepEqual(blocks, [{ type: 'text', text: '' }, { type: 'text', text: '[Attachment: notes.txt (failed to fetch)]' }]);
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /^Discord: Attachment notes\.txt in message m1 wasn't fetched:$/);
  assert.equal((warn.mock.calls[0].arguments[1] as Error).message, 'fetch failed');
});

test('a text attachment that is fetched is read whole', async (t) => {
  const blocks = await convert(t, async () => new Response('line one', { status: 200 }));
  assert.deepEqual(blocks, [{ type: 'text', text: '' }, { type: 'text', text: '\n--- File: notes.txt ---\nline one\n--- End of notes.txt ---\n' }]);
});
