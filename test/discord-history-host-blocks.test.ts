/**
 * A stored Discord message keeps what the host added beside its own text:
 * images, inlined file text and attachment notes. The live path stores the
 * message's own text first, '' when it has none, and marks the row so; an
 * edit or a history sync then replaces that block alone. A row stored before
 * the mark is left alone by a live edit unless its text really changed.
 * History carries attachments, so a message the sync missed is stored as the
 * live path would have stored it, a row that doesn't hold what the live path
 * would store is stored through it again, and fetch_history lists them. The
 * sync leaves what the live path wrote while it ran.
 *
 * Run: node --import tsx --test test/discord-history-host-blocks.test.ts
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { bodyBoundsIn } from '@animalabs/context-manager';
import { DiscordModule, DiscordJsClient } from '../src/modules/discord/index.js';
import type {
  DiscordAttachment,
  DiscordClientInterface,
  DiscordMessageData,
  HistoryMessage,
} from '../src/modules/discord/types.js';
import type { ModuleContext, ProcessEvent, ProcessState } from '../src/types/index.js';

type Block = { type: string; text?: string; source?: unknown };
interface Row {
  id: string;
  participant: string;
  content: Block[];
  metadata: Record<string, unknown> & { external: { source: string; id: string }; channelId: string };
  timestamp: Date;
  bodyGroupId?: string;
  shardIndex?: number;
}

interface Harness {
  ctx: ModuleContext | null;
  handleDiscordMessage(message: DiscordMessageData): Promise<void>;
  handleDiscordMessageEdit(messageId: string, newContent: string, attachments?: DiscordAttachment[]): void;
  handleDiscordMessageDelete(messageId: string): void;
  syncChannelHistory(channelId: string): Promise<{ newMessages: number; editedMessages: number; deletedMessages: number }>;
  replyContexts: Map<string, { channelId: string }>;
  creating: Map<string, unknown>;
}

const image: DiscordAttachment = { id: 'a1', filename: 'cat.png', url: 'https://cdn.example/cat.png', contentType: 'image/png', size: 2_000 };
const notes: DiscordAttachment = { id: 'a2', filename: 'notes.txt', url: 'https://cdn.example/notes.txt', contentType: 'text/plain', size: 9 };
const imageBlock = { type: 'image', source: { type: 'url', url: image.url } };
const fileBlock = { type: 'text', text: '\n--- File: notes.txt ---\nfile body\n--- End of notes.txt ---\n' };
const text = (t: string) => ({ type: 'text', text: t });

function row(id: string, content: Block[], textFirst: boolean, timestamp = 1_000): Row {
  return {
    id: `stored-${id}`,
    participant: 'User',
    content,
    metadata: {
      external: { source: 'discord', id },
      channelId: 'c1',
      timestamp,
      ...(textFirst ? { discordTextFirst: true } : {}),
    },
    timestamp: new Date(timestamp),
  };
}

/** `storeAdds`: the context's addMessage stores a row, as the store does,
 *  for tests where a later lookup must find what a sync added. `hold` and
 *  `land` play rows that don't show yet: between them, an add, a sync's or a
 *  live answer's, waits unseen by queryMessages, and `land` stores what
 *  waited, in order. The framework shows a write it holds as a held row,
 *  which discord-held-writes.test.ts runs the module over, so these play
 *  the rows of answers it hasn't written or held. Edits and removals act at
 *  once, on stored rows, as the framework's do. */
function setup(rows: Row[], client: Partial<DiscordClientInterface> = {}, { storeAdds = false } = {}) {
  const module = new DiscordModule({ sendTyping: async () => {}, ...client } as unknown as DiscordClientInterface, { token: 't', autoTyping: false });
  const harness = module as unknown as Harness;
  const events: ProcessEvent[] = [];
  const added: Array<{ content: Block[]; metadata: Record<string, unknown> }> = [];
  const edits: Array<{ id: string; content: Block[] }> = [];
  const removed: string[] = [];
  let holding = false;
  const waiting: Row[] = [];
  const store = (row: Row) => { if (holding) waiting.push(row); else rows.push(row); };
  // As context-manager's store does, an edit or removal of a row it doesn't
  // hold throws, and so does an edit of a shard of a body.
  const held = (id: string) => {
    const r = rows.find((candidate) => candidate.id === id);
    if (!r) throw new Error(`Message not found: ${id}`);
    return r;
  };
  const edit = (id: string, content: Block[]) => {
    const r = held(id);
    if (r.bodyGroupId) throw new Error(`Cannot edit shard ${id}`);
    r.content = content;
  };
  // As the framework does, removing a shard takes out its whole body, read
  // by context-manager's rule in store order.
  const remove = (id: string) => {
    const { from, to } = bodyBoundsIn(rows, rows.indexOf(held(id)));
    rows.splice(from, to - from + 1);
  };
  harness.ctx = {
    queryMessages: (q: { source?: string; externalIds?: string[]; metadata?: Record<string, unknown> }) => {
      const messages = rows.filter((r) => (q.source === undefined || r.metadata.external.source === q.source)
        && (!q.externalIds || q.externalIds.includes(r.metadata.external.id))
        && (q.metadata?.channelId === undefined || r.metadata.channelId === q.metadata.channelId));
      return { messages, totalCount: messages.length };
    },
    getAgents: () => [{ name: 'Sol' }],
    addMessage: (participant: string, content: Block[], metadata: Record<string, unknown>) => {
      added.push({ content, metadata });
      const id = `stored-new-${added.length}`;
      if (storeAdds) store({ id, participant, content, metadata: metadata as Row['metadata'], timestamp: new Date(metadata.timestamp as number) });
      return holding ? '' : id;
    },
    editMessage: (id: string, content: Block[]) => { edit(id, content); edits.push({ id, content }); },
    removeMessage: (id: string) => { remove(id); removed.push(id); },
    pushEvent: (event: ProcessEvent) => { events.push(event); },
    setState: () => {},
  } as unknown as ModuleContext;
  // As the framework's is, the context's external-id index holds only rows a
  // module stored through the context, so it misses every row in these tests.
  const state = {
    getState: () => null,
    findMessageByExternalId: () => null,
  } as unknown as ProcessState;
  // The framework's part: a live event's response, written to the store.
  const apply = async (event: Record<string, unknown>) => {
    const response = await module.onProcess(event as unknown as ProcessEvent, state);
    for (const message of response.addMessages ?? []) {
      const metadata = message.metadata as Row['metadata'];
      store({ id: `stored-${metadata.external.id}`, participant: message.participant, content: message.content as Block[], metadata, timestamp: new Date(metadata.timestamp as number) });
    }
    for (const change of response.editMessages ?? []) edit(change.messageId, change.content as Block[]);
    for (const id of response.removeMessages ?? []) remove(id);
    return response;
  };
  const hold = () => { holding = true; };
  const land = () => { holding = false; rows.push(...waiting.splice(0)); };
  return { module, harness, events, added, edits, removed, state, apply, rows, hold, land };
}

function live(id: string, content: string, attachments: DiscordAttachment[] = []): DiscordMessageData {
  return {
    id, channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'User', isBot: false, content,
    isReply: false, mentionedUserIds: [], attachments, timestamp: new Date(1_000),
  };
}

function history(id: string, content: string, timestamp: number, attachments?: DiscordAttachment[]): HistoryMessage {
  return { id, authorId: 'u1', authorName: 'User', isBot: false, content, timestamp: new Date(timestamp), ...(attachments ? { attachments } : {}) };
}

test('a live message is stored with its own text first, \'\' when it has none, then what the host added, and is marked so', async () => {
  const { module, harness, events, state } = setup([]);
  await harness.handleDiscordMessage(live('m1', '', [image]));
  await harness.handleDiscordMessage(live('m2', 'hello'));
  await harness.handleDiscordMessage(live('m3', '   '));
  const stored = [];
  for (const event of events) {
    const response = await module.onProcess(event, state);
    const [message] = response.addMessages ?? [];
    stored.push({ content: message?.content, textFirst: (message?.metadata as Record<string, unknown>)?.discordTextFirst });
  }
  assert.deepEqual(stored, [
    { content: [text(''), imageBlock], textFirst: true },
    { content: [text('hello')], textFirst: true },
    { content: [text(''), text('[Empty message]')], textFirst: true },
  ]);
});

test('an edit replaces a marked row\'s own text and keeps every block the host added', async () => {
  const slack = row('m1', [text('another source')], true);
  const { module, state } = setup([
    // Another source's message with the same id, which no Discord edit reaches.
    { ...slack, id: 'slack-m1', metadata: { ...slack.metadata, external: { source: 'slack', id: 'm1' } } },
    row('m1', [text('old'), fileBlock, imageBlock], true),
    row('m2', [text('only text')], true),
    row('m3', [text(''), text('[Empty message]')], true),
    row('m4', [text(''), imageBlock], true),
    row('m5', [text('x'), imageBlock], true),
  ]);
  const edit = (id: string, newContent: string) =>
    module.onProcess({ type: 'discord:edit', discordMessageId: id, newContent } as unknown as ProcessEvent, state);
  assert.deepEqual(await edit('m1', 'new'), { editMessages: [{ messageId: 'stored-m1', content: [text('new'), fileBlock, imageBlock] }] });
  // An update that leaves the text as it was, such as a link's embed
  // arriving, changes nothing.
  assert.deepEqual(await edit('m1', 'old'), {});
  // An edit that leaves no text: the marker comes back only when nothing
  // else is left, and goes once there is text again.
  assert.deepEqual(await edit('m2', ''), { editMessages: [{ messageId: 'stored-m2', content: [text(''), text('[Empty message]')] }] });
  assert.deepEqual(await edit('m4', ''), {});
  assert.deepEqual(await edit('m5', ''), { editMessages: [{ messageId: 'stored-m5', content: [text(''), imageBlock] }] });
  assert.deepEqual(await edit('m3', 'now'), { editMessages: [{ messageId: 'stored-m3', content: [text('now')] }] });
  // A message nobody stored is left alone.
  assert.deepEqual(await edit('m9', 'x'), {});
});

test('a live edit leaves a row stored before the mark alone unless its text is there and differs, and then puts the text in place of the first block, keeping the rest; a sync without attachments to compare rebuilds none, and changes a text as an edit does', async () => {
  const pdfNote = text('[Attachment: x.pdf (application/pdf)]');
  const { module, harness, edits, state } = setup([
    row('l1', [text('own'), fileBlock], false),
    row('l2', [pdfNote], false),
    row('l3', [imageBlock], false),
    row('l4', [pdfNote, imageBlock], false),
    row('l5', [text('[Empty message]')], false),
    row('l6', [text('own'), fileBlock], false),
    // As the history sync rebuilds an empty message stored before the mark.
    row('l7', [text(''), text('[Empty message]')], false),
    row('l8', [fileBlock, imageBlock], false),
  ], {
    fetchHistory: async () => ['l8', 'l7', 'l5', 'l4', 'l3', 'l2'].map((id) => history(id, '', 1_000))
      .concat(history('l6', 'changed while away', 1_000), history('l1', 'own', 1_000)),
  });
  const edit = (id: string, newContent: string) =>
    module.onProcess({ type: 'discord:edit', discordMessageId: id, newContent } as unknown as ProcessEvent, state);
  assert.deepEqual(await edit('l1', 'own'), {});
  assert.deepEqual(await edit('l1', ''), {}, 'a blank edit leaves it: its first block may be what the host added');
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 1, deletedMessages: 0 });
  // With no attachments to compare, the sync rebuilds nothing, so l6 keeps its file.
  assert.deepEqual(edits, [{ id: 'stored-l6', content: [text('changed while away'), fileBlock] }]);
  // A real change takes the first block's place when it's text, and keeps the rest.
  assert.deepEqual(await edit('l1', 'changed'), { editMessages: [{ messageId: 'stored-l1', content: [text('changed'), fileBlock] }] });
  assert.deepEqual(await edit('l5', 'now'), { editMessages: [{ messageId: 'stored-l5', content: [text('now')] }] });
  // The marker goes once there's text.
  assert.deepEqual(await edit('l7', 'now'), { editMessages: [{ messageId: 'stored-l7', content: [text('now')] }] });
  // A row that begins with what the host added, an image, gets the text before it.
  assert.deepEqual(await edit('l3', 'caption'), { editMessages: [{ messageId: 'stored-l3', content: [text('caption'), imageBlock] }] });
  // The worst case: a message with no text of its own, stored beginning with
  // a file's note or contents, loses that block, where the rewrite lost the
  // image too.
  assert.deepEqual(await edit('l4', 'added'), { editMessages: [{ messageId: 'stored-l4', content: [text('added'), imageBlock] }] });
  assert.deepEqual(await edit('l8', 'added'), { editMessages: [{ messageId: 'stored-l8', content: [text('added'), imageBlock] }] });
});

test('a history sync replaces only a marked row\'s own text, and stores a missed message as the live path would', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, notes.url);
    return new Response('file body', { status: 200 });
  });
  const note = text('[Attachment: x.pdf (application/pdf)]');
  const { harness, added, edits } = setup([
    row('s1', [text('same'), note], true, 1_000),
    row('s2', [text('before'), imageBlock], true, 2_000),
  ], {
    fetchHistory: async () => [
      history('n2', '', 5_000, [image]),
      history('n1', 'with a file', 4_000, [notes]),
      history('s2', 'after', 2_000, [image]),
      history('s1', 'same', 1_000),
    ],
  });
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 2, editedMessages: 1, deletedMessages: 0 });
  assert.deepEqual(edits, [{ id: 'stored-s2', content: [text('after'), imageBlock] }]);
  assert.deepEqual(added.map((a) => [a.content, a.metadata.discordTextFirst]), [
    [[text('with a file'), fileBlock], true],
    [[text(''), imageBlock], true],
  ]);
  // Stored with what a live edit or delete, and the next sync, find a row by.
  assert.deepEqual(added.map((a) => [a.metadata.external, a.metadata.channelId]), [
    [{ source: 'discord', id: 'n1' }, 'c1'],
    [{ source: 'discord', id: 'n2' }, 'c1'],
  ]);
});

test('a history sync stores nothing the live path stored while a missed message\'s attachments were fetched, nor anything once the module stopped or started again', async (t) => {
  const rows: Row[] = [];
  let during = () => {};
  t.mock.method(globalThis, 'fetch', async () => {
    during();
    return new Response('file body', { status: 200 });
  });
  const { harness, added } = setup(rows, { fetchHistory: async () => [history('n1', 'with a file', 1_000, [notes])] });
  const original = harness.ctx;
  during = () => { rows.push(row('n1', [text('with a file'), fileBlock], true)); };
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 0, deletedMessages: 0 });
  assert.deepEqual(added, []);
  rows.length = 0;
  during = () => { harness.ctx = null; };
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 0, deletedMessages: 0 });
  assert.deepEqual(added, []);
  // Nor into the context of a module started again meanwhile.
  const next = setup([]);
  harness.ctx = original;
  during = () => { harness.ctx = next.harness.ctx; };
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 0, deletedMessages: 0 });
  assert.deepEqual([added, next.added], [[], []]);
});

test('a message the live path stored is neither rebuilt nor fetched again by a history sync', async (t) => {
  const pdf: DiscordAttachment = { id: 'a3', filename: 'x.pdf', url: 'https://cdn.example/x.pdf', contentType: 'application/pdf', size: 50 };
  const lost: DiscordAttachment = { id: 'a4', filename: 'gone.txt', url: 'https://cdn.example/gone.txt', contentType: 'text/plain', size: 9 };
  const fetched: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    fetched.push(url);
    return url === lost.url ? new Response('', { status: 404 }) : new Response('file body', { status: 200 });
  });
  // An image, a file's text, a file not fetched (its notice) and a note; a
  // file alone; text alone; and nothing at all (the empty marker).
  const messages = [live('m1', 'all of them', [image, notes, lost, pdf]), live('m2', '', [notes]), live('m3', 'plain'), live('m4', '')];
  const rows: Row[] = [];
  const { harness, events, added, edits, apply } = setup(rows, {
    fetchHistory: async () => [...messages].reverse().map((m) => history(m.id, m.content, 1_000, m.attachments)),
  });
  for (const message of messages) await harness.handleDiscordMessage(message);
  for (const event of events) await apply(event as unknown as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => r.content), [
    [text('all of them'), imageBlock, fileBlock, text('[Attachment: gone.txt couldn\'t be fetched, so its text isn\'t in your context. If you need it, ask the sender in the channel to paste it.]'), text('[Attachment: x.pdf (application/pdf): this host didn\'t read its contents in, so they aren\'t in your context. If you need them, ask the sender for them in a form you can read, such as pasted text.]')],
    [text(''), fileBlock],
    [text('plain')],
    [text(''), text('[Empty message]')],
  ]);
  fetched.length = 0;
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 0, deletedMessages: 0 });
  assert.deepEqual([edits, added, fetched], [[], [], []]);
});

test('a history sync rebuilds a row that doesn\'t hold what the live path would store, blanked or stripped before the mark, still holding a removed attachment or text its message lost, or a caption its message lost, and a row whose text changed keeps its file', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('file body', { status: 200 }));
  const pdf: DiscordAttachment = { id: 'a3', filename: 'x.pdf', url: 'https://cdn.example/x.pdf', contentType: 'application/pdf', size: 50 };
  // The note as the live path wrote it before this wording, and as it writes it now.
  const pdfNote = text('[Attachment: x.pdf (application/pdf)]');
  const pdfNoteNow = text('[Attachment: x.pdf (application/pdf): this host didn\'t read its contents in, so they aren\'t in your context. If you need them, ask the sender for them in a form you can read, such as pasted text.]');
  const { module, state, harness, edits, added } = setup([
    row('b1', [text('')], false, 1_000),
    row('b2', [text('own')], false, 2_000),
    row('b3', [text('old'), fileBlock], false, 3_000),
    row('b4', [pdfNote], false, 4_000),
    row('b5', [text('keep'), imageBlock], true, 5_000),
    row('b6', [imageBlock], false, 6_000),
    row('b7', [text('was here'), fileBlock], false, 7_000),
    row('b8', [text('')], false, 8_000),
    // An earlier sync stripped b9 to its caption, and the caption went while
    // its file stayed: one block where one is expected.
    row('b9', [text('old caption')], false, 9_000),
    // b10's own text reads as the marker.
    row('b10', [text('[Empty message]'), fileBlock], false, 10_000),
    // b11 holds its note in the words the live path wrote before this change.
    row('b11', [text('own'), pdfNote], false, 11_000),
  ], {
    fetchHistory: async () => [
      history('b11', 'own', 11_000, [pdf]),
      history('b10', '[Empty message]', 10_000, [notes]),
      history('b9', '', 9_000, [notes]),
      history('b8', '', 8_000, []),
      history('b7', '', 7_000, [notes]),
      history('b6', '', 6_000, []),
      history('b5', 'keep', 5_000, []),
      history('b4', '', 4_000, [pdf]),
      history('b3', 'new', 3_000, [notes]),
      history('b2', 'own', 2_000, [pdf]),
      history('b1', '', 1_000, [notes]),
    ],
  });
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 9, deletedMessages: 0 });
  assert.deepEqual(edits, [
    // An attachment-only message an earlier sync blanked.
    { id: 'stored-b1', content: [text(''), fileBlock] },
    // One an earlier sync stripped of its note.
    { id: 'stored-b2', content: [text('own'), pdfNoteNow] },
    // One whose text changed while the client was away keeps its file.
    { id: 'stored-b3', content: [text('new'), fileBlock] },
    // b4 holds what the live path stored before the mark, but its message has
    // no text, so its first block can't be told from a caption it lost, and
    // it's stored again, once.
    { id: 'stored-b4', content: [text(''), pdfNoteNow] },
    // A marked row whose image was removed from the message loses it.
    { id: 'stored-b5', content: [text('keep')] },
    // So does an image-only message stored before the mark.
    { id: 'stored-b6', content: [text(''), text('[Empty message]')] },
    // One whose message lost its text and kept its file, which a live edit
    // left alone, since a blank text there may be the host's first block.
    { id: 'stored-b7', content: [text(''), fileBlock] },
    // A message with neither text nor attachments, which an earlier sync blanked.
    { id: 'stored-b8', content: [text(''), text('[Empty message]')] },
    // The caption its message lost goes, and its file comes back.
    { id: 'stored-b9', content: [text(''), fileBlock] },
    // b10's text and file are both there, so it's left alone, and so is b11,
    // whose note in the earlier words still counts as its note.
  ]);
  assert.deepEqual(added, []);
  // Each row it rebuilt holds what the next sync expects, so that sync
  // writes nothing.
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 0, deletedMessages: 0 });
  // The sync can't mark what it rebuilt, since an edit keeps metadata, and a
  // live edit of it keeps the note the sync gave back.
  assert.deepEqual(await module.onProcess({ type: 'discord:edit', discordMessageId: 'b2', newContent: 'newer' } as unknown as ProcessEvent, state),
    { editMessages: [{ messageId: 'stored-b2', content: [text('newer'), pdfNoteNow] }] });
});

test('a rebuild whose file wasn\'t fetched writes nothing over a row holding text besides its message\'s own, which a later sync rebuilds once the file is fetched, and gives a row missing its file the notice', async (t) => {
  let reachable = false;
  t.mock.method(globalThis, 'fetch', async () => reachable ? new Response('file body', { status: 200 }) : new Response('', { status: 503 }));
  t.mock.method(console, 'warn', () => {});
  const more = text('\n--- File: more.txt ---\nmore\n--- End of more.txt ---\n');
  const notFetched = text('[Attachment: notes.txt couldn\'t be fetched, so its text isn\'t in your context. If you need it, ask the sender in the channel to paste it.]');
  const rows: Row[] = [
    // A message without text whose row begins with its file's text.
    row('p1', [fileBlock], false, 1_000),
    // A file removed while away from a row holding both files' texts.
    row('p2', [text('both'), fileBlock, more], false, 2_000),
    // Rows an earlier sync stripped of their file, to blank text and to the
    // caption: a notice costs them nothing.
    row('p3', [text('')], false, 3_000),
    row('p4', [text('caption')], false, 4_000),
    // A message whose own text reads as the notice for its file.
    row('p5', [notFetched, fileBlock, more], true, 5_000),
    // An attachment-only message that has gained text since its row was stored.
    row('p6', [fileBlock], false, 6_000),
  ];
  const { harness } = setup(rows, {
    fetchHistory: async () => [
      history('p6', 'gained', 6_000, [notes]),
      history('p5', notFetched.text, 5_000, [notes]),
      history('p4', 'caption', 4_000, [notes]),
      history('p3', '', 3_000, [notes]),
      history('p2', 'both', 2_000, [notes]),
      history('p1', '', 1_000, [notes]),
    ],
  });
  const held = () => rows.map((r) => r.content);
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 2, deletedMessages: 0 });
  assert.deepEqual(held(), [[fileBlock], [text('both'), fileBlock, more], [text(''), notFetched], [text('caption'), notFetched], [notFetched, fileBlock, more], [fileBlock]]);
  reachable = true;
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 4, deletedMessages: 0 });
  assert.deepEqual(held(), [[text(''), fileBlock], [text('both'), fileBlock], [text(''), notFetched], [text('caption'), notFetched], [text(`\\${notFetched.text}`), fileBlock], [text('gained'), fileBlock]]);
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 0, deletedMessages: 0 });
});

test('a history sync leaves what the live path wrote while it fetched, stores a missed message as it fetched it though a live edit came for it, and writes no row that has gone', async (t) => {
  const pdf: DiscordAttachment = { id: 'a3', filename: 'x.pdf', url: 'https://cdn.example/x.pdf', contentType: 'application/pdf', size: 50 };
  const rows: Row[] = [
    row('e1', [text('before')], true, 1_000),
    row('e2', [text('before')], true, 2_000),
    row('e3', [text('stays')], true, 3_000),
    row('e4', [text('before')], true, 4_000),
    // A row the sync would store again through the live conversion: one
    // that lacks its file, and one stored before the mark that lacks its note.
    row('e5', [text('before')], true, 4_500),
    row('e6', [text('own')], false, 4_800),
  ];
  let during = async () => {};
  t.mock.method(globalThis, 'fetch', async () => {
    const now = during;
    during = async () => {};
    await now();
    return new Response('file body', { status: 200 });
  });
  const { module, harness, edits, added, removed, state, apply } = setup(rows, {
    // While the sync fetches history, another writer removes e4.
    fetchHistory: async () => {
      rows.splice(rows.findIndex((r) => r.id === 'stored-e4'), 1);
      return [
        history('n3', 'sent while away', 7_000, []),
        history('n2', 'missed, then deleted', 6_000, [notes]),
        history('n1', 'missed', 5_000, [notes]),
        history('e6', 'own', 4_800, [pdf]),
        history('e5', 'before', 4_500, [notes]),
        history('e4', 'edited while away', 4_000, []),
        history('e3', 'stays', 3_000, []),
        history('e2', 'edited while away', 2_000, []),
        history('e1', 'edited while away', 1_000, []),
      ];
    },
  });
  // While the sync fetches e5's file, the first it fetches: e1 is edited
  // live and e2 deleted; e5 is removed by another writer; e6 gets an update
  // that leaves its text as it was; the first missed message is edited and
  // the second deleted; and the third arrives live, its add written only
  // once the sync is done, as the framework may write it after other
  // modules have answered.
  let arrival: Awaited<ReturnType<typeof module.onProcess>> | undefined;
  during = async () => {
    await apply({ type: 'discord:edit', discordMessageId: 'e1', newContent: 'edited live' });
    await apply({ type: 'discord:delete', discordMessageId: 'e2' });
    rows.splice(rows.findIndex((r) => r.id === 'stored-e5'), 1);
    assert.deepEqual(await apply({ type: 'discord:edit', discordMessageId: 'e6', newContent: 'own' }), {});
    assert.deepEqual(await apply({ type: 'discord:edit', discordMessageId: 'n1', newContent: 'missed, then edited' }), {});
    await apply({ type: 'discord:delete', discordMessageId: 'n2' });
    arrival = await module.onProcess({
      type: 'discord:message', discordMessageId: 'n3', channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'User',
      content: 'sent while away', contentBlocks: [text('sent while away')], timestamp: 7_000, attachments: [],
    } as unknown as ProcessEvent, state);
  };
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 1, editedMessages: 1, deletedMessages: 0 });
  // e6's update wrote nothing, so the sync still stores it again with its note.
  const pdfNote = text('[Attachment: x.pdf (application/pdf): this host didn\'t read its contents in, so they aren\'t in your context. If you need them, ask the sender for them in a form you can read, such as pasted text.]');
  assert.deepEqual(rows.map((r) => [r.id, r.content]), [['stored-e1', [text('edited live')]], ['stored-e3', [text('stays')]], ['stored-e6', [text('own'), pdfNote]]]);
  assert.deepEqual([edits.map((e) => e.id), removed], [['stored-e6'], []]);
  // n1 with the text the sync fetched: the live edit that came before any
  // row held it was dropped. e4 and e5, removed meanwhile, aren't brought
  // back.
  assert.deepEqual(added.map((a) => a.content), [[text('missed'), fileBlock]]);
  assert.deepEqual(arrival?.addMessages?.map((m) => m.content), [[text('sent while away')]]);
});

test('a history sync removes no message the live path stored or was told was deleted while it ran, which its fetch couldn\'t hold', async (t) => {
  const rows: Row[] = [row('d1', [text('deleted on Discord before the fetch')], true, 1_000)];
  let during = async () => {};
  t.mock.method(globalThis, 'fetch', async () => {
    const now = during;
    during = async () => {};
    await now();
    return new Response('file body', { status: 200 });
  });
  const { module, harness, removed, state, apply } = setup(rows, {
    fetchHistory: async () => [history('n1', 'missed', 2_000, [notes])],
  });
  // While the sync fetches the missed message's file: a message posted after
  // the fetch arrives live and is stored, and d1's delete arrives, its
  // removal written only once the sync is done.
  let deletion: Awaited<ReturnType<typeof module.onProcess>> | undefined;
  during = async () => {
    await apply({
      type: 'discord:message', discordMessageId: 'n2', channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'User',
      content: 'posted after the fetch', contentBlocks: [text('posted after the fetch')], timestamp: 3_000, attachments: [],
    });
    deletion = await module.onProcess({ type: 'discord:delete', discordMessageId: 'd1' } as unknown as ProcessEvent, state);
  };
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 1, editedMessages: 0, deletedMessages: 0 });
  assert.deepEqual([rows.map((r) => r.id), removed], [['stored-d1', 'stored-n2'], []]);
  // d1 is still there for the live delete, which would otherwise find no row.
  assert.deepEqual(deletion?.removeMessages, ['stored-d1']);
});

test('a history sync writes nothing once its module stopped while it fetched history', async () => {
  const rows: Row[] = [row('s1', [text('old')], true, 1_000)];
  const s = setup(rows, {
    fetchHistory: async () => {
      s.harness.ctx = null;
      return [history('s1', 'new', 1_000, [])];
    },
  });
  assert.deepEqual(await s.harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 0, deletedMessages: 0 });
  assert.deepEqual([s.edits, s.added, s.removed], [[], [], []]);
});

test('a history sync leaves no record of itself once it ends, when it writes and when its fetch throws', async () => {
  const running = (module: unknown) => (module as { liveDuringSync: Set<unknown> }).liveDuringSync.size;
  const wrote = setup([row('s1', [text('old')], true)], { fetchHistory: async () => [history('s1', 'new', 1_000, [])] });
  assert.deepEqual(await wrote.harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 1, deletedMessages: 0 });
  assert.equal(running(wrote.module), 0);
  const failed = setup([], { fetchHistory: async () => { throw new Error('gateway closed'); } });
  await assert.rejects(failed.harness.syncChannelHistory('c1'), /gateway closed/);
  assert.equal(running(failed.module), 0);
});

test('a message stored as a body is removed whole by a live delete and the history sync, and its text is left as stored', async (t) => {
  // A body: one Discord message stored as shards that share its metadata.
  const body = (id: string, timestamp: number) => ['a', 'b'].map((part, shardIndex) => ({
    ...row(id, [text(`part ${part}`)], true, timestamp), id: `stored-${id}${part}`, bodyGroupId: `g-${id}`, shardIndex,
  }));
  const { harness, edits, removed, apply, rows } = setup([...body('s1', 1_000), ...body('s2', 2_000), ...body('s3', 3_000), ...body('s4', 4_000)], {
    fetchHistory: async () => [history('s3', 'part a', 3_000, [notes]), history('s1', 'changed', 1_000, [])],
  });
  const fetched: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => { fetched.push(url); return new Response('file body', { status: 200 }); });
  const warned: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
  // context-manager can't edit a body in place, so an edit leaves it as
  // stored, and the host's log says so.
  assert.deepEqual(await apply({ type: 'discord:edit', discordMessageId: 's1', newContent: 'changed' }), {});
  assert.deepEqual(warned, ['Discord: An update to message s1 wasn\'t applied: it\'s stored in shards, which can\'t be edited, so if its text changed, the agent still has the earlier text']);
  const liveDelete = await apply({ type: 'discord:delete', discordMessageId: 's4' });
  assert.equal(liveDelete.removeMessages?.length, 1, 'one removal for the body');
  assert.match(String(liveDelete.removeMessages?.[0]), /^stored-s4[ab]$/);
  // As far as the sync can tell, s1's text changed, s2 was deleted and s3
  // gained a file. It removes s2 whole, by one of its shards, and fetches
  // nothing for a body.
  assert.deepEqual(await harness.syncChannelHistory('c1'), { newMessages: 0, editedMessages: 0, deletedMessages: 1 });
  assert.deepEqual([edits, fetched], [[], []]);
  assert.equal(removed.length, 1, 'one removal for the body');
  assert.match(String(removed[0]), /^stored-s2[ab]$/);
  assert.deepEqual(rows.map((r) => r.id), ['stored-s1a', 'stored-s1b', 'stored-s3a', 'stored-s3b']);
});

test('a live delete removes the row the live path stored, which the context\'s external-id index doesn\'t hold', async () => {
  const { module, state } = setup([row('m1', [text('hello')], true)]);
  assert.deepEqual(await module.onProcess({ type: 'discord:delete', discordMessageId: 'm1' } as unknown as ProcessEvent, state), { removeMessages: ['stored-m1'] });
  assert.deepEqual(await module.onProcess({ type: 'discord:delete', discordMessageId: 'm9' } as unknown as ProcessEvent, state), {});
});

test('a message event that carries no content blocks is stored from its text by the same rule', async () => {
  const { module, state } = setup([]);
  const stored = async (content: string) => {
    const response = await module.onProcess({
      type: 'discord:message', discordMessageId: 'm1', channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'User',
      content, timestamp: 1_000, attachments: [],
    } as unknown as ProcessEvent, state);
    return response.addMessages?.[0]?.content;
  };
  assert.deepEqual(await stored('hello'), [text('hello')]);
  assert.deepEqual(await stored('   '), [text(''), text('[Empty message]')]);
  assert.deepEqual(await stored(''), [text(''), text('[Empty message]')]);
});

test('fetch_history lists each message\'s attachments, and leaves the list out of a message with none', async () => {
  const { module } = setup([], {
    fetchHistory: async () => [history('h2', 'look', 2_000, [image]), history('h1', 'plain', 1_000)],
  });
  const result = await module.handleToolCall({ id: 'call-1', name: 'fetch_history', input: { channelId: 'c1' } });
  const messages = (result.data as { messages: Array<Record<string, unknown>> }).messages;
  assert.deepEqual(messages[0]?.attachments, [{ filename: 'cat.png', contentType: 'image/png', size: 2_000 }]);
  assert.equal('attachments' in (messages[1] ?? {}), false);
});

test('the client\'s history carries each message\'s attachments, as a live message does', async (t) => {
  const client = new DiscordJsClient({ token: 't' });
  t.after(() => client.disconnect());
  const attachment = { id: 'a1', name: 'cat.png', url: image.url, contentType: 'image/png', size: 2_000 };
  const message = {
    id: 'h1', author: { id: 'u1', username: 'User', bot: false }, content: 'look', createdAt: new Date(1_000),
    reference: null, attachments: new Collection([['a1', attachment]]),
  };
  const channels = (client as unknown as { client: { channels: { fetch: unknown } } }).client.channels;
  channels.fetch = async () => ({ messages: { fetch: async () => new Collection([['h1', message]]) } });
  const [fetched] = await client.fetchHistory('c1');
  assert.deepEqual(fetched?.attachments, [image]);
});

test('the client passes on an edit that leaves no text, and not a partial message\'s missing text', async (t) => {
  const client = new DiscordJsClient({ token: 't' });
  t.after(() => client.disconnect());
  const seen: Array<[string, string]> = [];
  client.onMessageEdit((id, content) => { seen.push([id, content]); });
  const emitter = (client as unknown as { client: { emit(event: string, ...args: unknown[]): boolean } }).client;
  emitter.emit('messageUpdate', {}, { id: 'm1', content: '' });
  emitter.emit('messageUpdate', {}, { id: 'm2', content: null });
  emitter.emit('messageUpdate', {}, { id: 'm3', content: 'edited' });
  assert.deepEqual(seen, [['m1', ''], ['m3', 'edited']]);
});

// ---- The live path's creates against the history sync ----

/** A fetch that answers only once released, so a file's conversion waits. */
function heldFetch(t: TestContext): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { await gate; return new Response('file body', { status: 200 }); });
  return release;
}

const created = (id: string, content: string) => ({
  type: 'discord:message', discordMessageId: id, channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'User',
  content, contentBlocks: [text(content)], timestamp: 1_000, attachments: [], shouldTriggerInference: true,
});

test('a live create whose message a history sync stored first adds no second row, and still sets the reply context and asks for inference', async () => {
  const rows: Row[] = [];
  const { harness, apply } = setup(rows, { fetchHistory: async () => [history('n1', 'hello', 1_000, [])] }, { storeAdds: true });
  await harness.syncChannelHistory('c1');
  const response = await apply(created('n1', 'hello'));
  assert.deepEqual(rows.map((r) => [r.id, r.content]), [['stored-new-1', [text('hello')]]]);
  assert.deepEqual([response.addMessages, response.requestInference], [undefined, true]);
  assert.equal(harness.replyContexts.get('default')?.channelId, 'c1');
});

test('a history sync stores nothing for a message whose live create is still converting its file, which the create then stores once', async (t) => {
  const rows: Row[] = [];
  const release = heldFetch(t);
  const { harness, events, apply } = setup(rows, { fetchHistory: async () => [history('n2', 'with a file', 1_000, [])] }, { storeAdds: true });
  const creating = harness.handleDiscordMessage(live('n2', 'with a file', [notes]));
  await harness.syncChannelHistory('c1');
  release();
  await creating;
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => [r.id, r.content]), [['stored-n2', [text('with a file'), fileBlock]]]);
});

test('a history sync stores nothing for a message whose row doesn\'t show yet, through later Discord events, and the record lets it go once the row shows', async () => {
  const rows: Row[] = [];
  let fetched: HistoryMessage[] = [];
  const { harness, events, apply, hold, land } = setup(rows, { fetchHistory: async () => fetched }, { storeAdds: true });
  // Each answer's row doesn't show yet.
  hold();
  await harness.handleDiscordMessage(live('n3', 'late'));
  await harness.handleDiscordMessage(live('n4', 'later'));
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  fetched = [history('n4', 'later', 1_000, []), history('n3', 'late', 1_000, [])];
  await harness.syncChannelHistory('c1');
  land();
  assert.deepEqual(rows.map((r) => r.id), ['stored-n3', 'stored-n4']);
  // The next Discord event finds both rows, and their entries end.
  await apply({ type: 'discord:delete', discordMessageId: 'unrelated' });
  assert.equal(harness.creating.size, 0);
});

test('a create a delete dropped keeps a history sync from storing its message until that delete is handled, though another Discord event comes first and its row doesn\'t show yet', async (t) => {
  const rows: Row[] = [];
  const release = heldFetch(t);
  const { harness, events, apply, hold, land } = setup(rows, { fetchHistory: async () => [history('x6', 'withdrawn', 1_000, [])] }, { storeAdds: true });
  hold();
  const creating = harness.handleDiscordMessage(live('x6', 'withdrawn', [notes]));
  await harness.handleDiscordMessage(live('x7', 'unrelated'));
  harness.handleDiscordMessageDelete('x6');
  release();
  await creating;
  // The unrelated create's event is ahead of the delete's.
  await apply(events.shift() as unknown as Record<string, unknown>);
  await harness.syncChannelHistory('c1');
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  land();
  assert.deepEqual(rows.map((r) => r.id), ['stored-x7']);
  // Its delete ended its entry, and the next Discord event ends the other's.
  await apply({ type: 'discord:delete', discordMessageId: 'unrelated' });
  assert.equal(harness.creating.size, 0);
});

test('a delete handled while its create still converts ends the record\'s entry, and the create stores nothing once it has converted', async (t) => {
  const rows: Row[] = [];
  const release = heldFetch(t);
  const { harness, events, apply } = setup(rows);
  const creating = harness.handleDiscordMessage(live('x8', 'gone at once', [notes]));
  harness.handleDiscordMessageDelete('x8');
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  assert.equal(harness.creating.size, 0);
  release();
  await creating;
  assert.deepEqual([events, rows], [[], []]);
});

test('of a message stored twice, a live edit and a history sync both change the first row, and a live delete or a sync\'s delete takes every row', async () => {
  const rows: Row[] = [
    row('d1', [text('first')], true, 1_000), { ...row('d1', [text('first')], true, 1_000), id: 'stored-d1-copy' },
    row('d2', [text('two')], true, 2_000), { ...row('d2', [text('two')], true, 2_000), id: 'stored-d2-copy' },
  ];
  // Complete history, which holds d1 and not d2.
  const { harness, apply } = setup(rows, { fetchHistory: async () => [history('d1', 'synced text', 1_000)] });
  await apply({ type: 'discord:edit', discordMessageId: 'd1', newContent: 'edited live' });
  assert.deepEqual(rows.map((r) => [r.id, r.content]).slice(0, 2), [['stored-d1', [text('edited live')]], ['stored-d1-copy', [text('first')]]]);
  await harness.syncChannelHistory('c1');
  assert.deepEqual(rows.map((r) => [r.id, r.content]), [['stored-d1', [text('synced text')]], ['stored-d1-copy', [text('first')]]]);
  await apply({ type: 'discord:delete', discordMessageId: 'd1' });
  assert.deepEqual(rows, []);
});

test('a delete that comes while its create converts a file drops the create: nothing is stored and nobody is woken', async (t) => {
  const rows: Row[] = [];
  const release = heldFetch(t);
  const { harness, events, apply } = setup(rows);
  const creating = harness.handleDiscordMessage(live('x1', 'oops', [notes]));
  harness.handleDiscordMessageDelete('x1');
  release();
  await creating;
  assert.deepEqual(events.map((e) => e.type), ['discord:delete']);
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => r.id), []);
  // The next message is stored as ever.
  await harness.handleDiscordMessage(live('x9', 'next', [notes]));
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => r.id), ['stored-x9']);
});

test('a delete that comes while its create waits in the queue drops it when handled: no row, no reply context, no inference', async () => {
  const rows: Row[] = [];
  const { harness, events, apply } = setup(rows);
  await harness.handleDiscordMessage(live('x3', 'queued'));
  harness.handleDiscordMessageDelete('x3');
  const answers = [];
  for (const event of events.splice(0)) answers.push(await apply(event as unknown as Record<string, unknown>));
  assert.deepEqual(answers, [{}, {}]);
  assert.deepEqual([rows, harness.replyContexts.has('default')], [[], false]);
});

test('an edit that comes while its create converts a file is folded into the create: its text, without the blocks of the attachments it took away', async (t) => {
  const rows: Row[] = [];
  const release = heldFetch(t);
  const { harness, events, apply } = setup(rows);
  const creating = harness.handleDiscordMessage(live('x2', 'first wording', [image, notes]));
  harness.handleDiscordMessageEdit('x2', 'second wording', [notes]);
  release();
  await creating;
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => [r.id, r.content]), [['stored-x2', [text('second wording'), fileBlock]]]);
});

test('an edit that takes attachments away drops their blocks from a text-first row: an image by its URL whatever its query, a file by its header, a note by the filename it opens with whatever its words; a block another attachment of its name may stand for stays, and so do a row stored before the mark and one the client passed no attachments for', async (t) => {
  const pdf: DiscordAttachment = { id: 'a3', filename: 'x.pdf', url: 'https://cdn.example/x.pdf', contentType: 'application/pdf', size: 50 };
  const lost: DiscordAttachment = { id: 'a4', filename: 'gone.txt', url: 'https://cdn.example/gone.txt', contentType: 'text/plain', size: 9 };
  t.mock.method(globalThis, 'fetch', async (url: string) => url === lost.url ? new Response('', { status: 404 }) : new Response('file body', { status: 200 }));
  const rows: Row[] = [
    row('p2', [text('two files'), fileBlock, fileBlock], true),
    row('p3', [text('old'), imageBlock], false),
    row('p4', [text(''), imageBlock], true),
    row('p5', [text('worded'), text('[Attachment: old.txt was noted in other words.]'), text('[Attachment: x.pdf was noted in other words.]')], true),
  ];
  const { harness, events, apply } = setup(rows);
  const content = (id: string) => rows.find((r) => r.id === `stored-${id}`)?.content;
  const opens = (block: Block | undefined, filename: string) => block?.type === 'text' && block.text?.startsWith(`[Attachment: ${filename} `) === true;
  // Stored through the live conversion, so its file, its notice and its
  // note are as the live path writes them, whatever their words.
  await harness.handleDiscordMessage(live('p1', 'look', [image, notes, lost, pdf]));
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  const stored = content('p1') ?? [];
  assert.deepEqual(stored.slice(0, 3), [text('look'), imageBlock, fileBlock]);
  assert.deepEqual([stored.length, opens(stored[3], 'gone.txt'), opens(stored[4], 'x.pdf')], [5, true, true]);
  // The image's URL comes signed afresh; the file, the notice and the note are gone.
  await apply({ type: 'discord:edit', discordMessageId: 'p1', newContent: 'look', attachments: [{ ...image, url: `${image.url}?ex=2&hm=b` }] });
  assert.deepEqual(content('p1'), [text('look'), imageBlock]);
  // One of two files of one name is gone: either block may be its.
  assert.deepEqual(await apply({ type: 'discord:edit', discordMessageId: 'p2', newContent: 'two files', attachments: [notes] }), {});
  // Before the mark, the text rule alone, which leaves an unchanged text.
  assert.deepEqual(await apply({ type: 'discord:edit', discordMessageId: 'p3', newContent: 'old', attachments: [] }), {});
  // Nothing left: the empty marker, as a message with neither gets.
  await apply({ type: 'discord:edit', discordMessageId: 'p4', newContent: '', attachments: [] });
  assert.deepEqual(content('p4'), [text(''), text('[Empty message]')]);
  // A note in other words is matched by the filename it opens with.
  await apply({ type: 'discord:edit', discordMessageId: 'p5', newContent: 'worded', attachments: [pdf] });
  assert.deepEqual(content('p5'), [text('worded'), text('[Attachment: x.pdf was noted in other words.]')]);
  // A client that passes no attachments changes the text alone.
  await apply({ type: 'discord:edit', discordMessageId: 'p1', newContent: 'look again' });
  assert.deepEqual(content('p1'), [text('look again'), imageBlock]);
});

test('the client passes an edit\'s attachments as the update left them for a message discord.js had cached, and none for one it hadn\'t', async (t) => {
  const client = new DiscordJsClient({ token: 't' });
  t.after(() => client.disconnect());
  const seen: unknown[][] = [];
  client.onMessageEdit((...args) => { seen.push(args); });
  const emitter = (client as unknown as { client: { emit(event: string, ...args: unknown[]): boolean } }).client;
  const attachment = { id: 'a1', name: 'cat.png', url: image.url, contentType: 'image/png', size: 2_000 };
  // discord.js hands over the message as it had it (partial when it hadn't
  // cached it) and as the update left it.
  emitter.emit('messageUpdate', { partial: false }, { id: 'm4', content: 'kept', partial: false, attachments: new Collection([['a1', attachment]]) });
  emitter.emit('messageUpdate', { partial: false }, { id: 'm5', content: 'none left', partial: false, attachments: new Collection() });
  emitter.emit('messageUpdate', { partial: true }, { id: 'm6', content: 'uncached', partial: false, attachments: new Collection() });
  assert.deepEqual(seen.slice(0, 2), [['m4', 'kept', [image]], ['m5', 'none left', []]]);
  assert.deepEqual(seen[2]!.slice(0, 2), ['m6', 'uncached']);
  assert.equal(seen[2]![2], undefined, 'no attachments for an edit of a message discord.js had not cached');
});

test('a stopping module writes nothing while it disconnects: a create that converted, one that arrives and one it is handed; a stop forgets the creates on their way', async (t) => {
  const release = heldFetch(t);
  let disconnected: () => void = () => {};
  const disconnecting = new Promise<void>((resolve) => { disconnected = resolve; });
  const { module, harness, events, state } = setup([], { disconnect: () => disconnecting, fetchHistory: async () => [history('q1', 'queued at the stop', 1_000, [])] });
  const converting = harness.handleDiscordMessage(live('s1', 'late', [notes]));
  await harness.handleDiscordMessage(live('q1', 'queued at the stop'));
  const stopping = module.stop();
  // While it disconnects, the framework may still dispatch to it.
  await harness.handleDiscordMessage(live('s2', 'during the stop'));
  assert.deepEqual(await module.onProcess(events[0]!, state), {});
  release();
  await assert.doesNotReject(converting);
  assert.deepEqual(events.map((e) => (e as { discordMessageId?: string }).discordMessageId), ['q1']);
  disconnected();
  await stopping;
  // Started again: the queued create was never written, and a sync stores its message.
  const stored: Row[] = [];
  harness.ctx = setup(stored, {}, { storeAdds: true }).harness.ctx;
  await harness.syncChannelHistory('c1');
  assert.deepEqual(stored.map((r) => r.metadata.external.id), ['q1']);
});

test('a create converting through a stop and a start again writes to neither context', async (t) => {
  const release = heldFetch(t);
  const { module, harness, events } = setup([], { disconnect: async () => {} });
  const converting = harness.handleDiscordMessage(live('r1', 'across a restart', [notes]));
  await module.stop();
  const next = setup([]);
  harness.ctx = next.harness.ctx;
  release();
  await converting;
  assert.deepEqual([events, next.events], [[], []]);
});

test('a second delivery of a message whose create converts is ignored, so a delete in the meantime still drops it', async (t) => {
  const rows: Row[] = [];
  const release = heldFetch(t);
  const { harness, events, apply } = setup(rows);
  const first = harness.handleDiscordMessage(live('d7', 'twice', [notes]));
  const second = harness.handleDiscordMessage(live('d7', 'twice', [notes]));
  harness.handleDiscordMessageDelete('d7');
  release();
  await Promise.all([first, second]);
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => r.id), []);
});

test('a history sync between a deleted create\'s conversion and its delete being handled stores nothing for it', async (t) => {
  const rows: Row[] = [];
  const release = heldFetch(t);
  const { harness, events, apply } = setup(rows, { fetchHistory: async () => [history('x5', 'gone soon', 1_000, [])] }, { storeAdds: true });
  const creating = harness.handleDiscordMessage(live('x5', 'gone soon', [notes]));
  harness.handleDiscordMessageDelete('x5');
  release();
  await creating;
  // The delete still waits in the queue.
  await harness.syncChannelHistory('c1');
  for (const event of events.splice(0)) await apply(event as unknown as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => r.id), []);
});

test('a create whose conversion throws leaves its message to the history sync', async () => {
  const rows: Row[] = [];
  const { module, harness } = setup(rows, { fetchHistory: async () => [history('t1', 'thrown', 1_000, [])] }, { storeAdds: true });
  const converter = module as unknown as { convertMessageToContent: (message: unknown) => Promise<unknown> };
  const convert = converter.convertMessageToContent.bind(module);
  converter.convertMessageToContent = async () => { throw new Error('conversion failed'); };
  await assert.rejects(harness.handleDiscordMessage(live('t1', 'thrown')), /conversion failed/);
  converter.convertMessageToContent = convert;
  await harness.syncChannelHistory('c1');
  assert.deepEqual(rows.map((r) => r.metadata.external.id), ['t1']);
});
