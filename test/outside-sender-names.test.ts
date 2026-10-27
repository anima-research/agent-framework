/**
 * A sender's name that comes from outside the framework, a Discord author's
 * or an API caller's, is stored in a form marked with its source, so the
 * agent's request takes such a message as a user turn even when the plain
 * name is the agent's (here, an agent named neither `user` nor in a marked
 * form). The generic `user` is stored as given. The bot's own messages that a Discord history sync
 * stores keep the agent's name. History's author filter finds a sender by
 * the plain name, in rows stored before the change and after it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NativeFormatter, type NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework, ApiModule, ApiServer } from '../src/index.js';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { DiscordClientInterface, DiscordMessageData, HistoryMessage } from '../src/modules/discord/types.js';
import { HistoryModule } from '../src/modules/history/index.js';
import type { ToolCall } from '../src/types/events.js';
import type { Module, ModuleContext } from '../src/types/module.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const AGENT = 'Sol';

class FakeDiscord {
  onMessageHandler: ((message: DiscordMessageData) => Promise<void>) | null = null;
  history: HistoryMessage[] = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  getBotUserId(): string { return 'bot'; }
  onMessage(handler: (message: DiscordMessageData) => Promise<void>): void { this.onMessageHandler = handler; }
  onMessageEdit(): void {}
  onMessageDelete(): void {}
  async fetchHistory(): Promise<HistoryMessage[]> { return [...this.history].reverse(); }
  async sendTyping(): Promise<void> {}
}

interface DiscordInternals {
  syncChannelHistory(channelId: string): Promise<{ newMessages: number }>;
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withFramework(
  run: (s: { framework: AgentFramework; membrane: MockMembrane; discord: FakeDiscord; sync: DiscordInternals; host: ModuleContext }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'outside-sender-names-'));
  let host!: ModuleContext;
  const hostModule: Module = {
    name: 'host',
    async start(ctx) { host = ctx; },
    async stop() {},
    getTools: () => [],
    async handleToolCall() { return { success: true }; },
    async onProcess() { return {}; },
  };
  const discord = new FakeDiscord();
  const module = new DiscordModule(discord as unknown as DiscordClientInterface, { token: 't', autoTyping: false });
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: AGENT, model: 'test-model', systemPrompt: 'test' }],
    modules: [module, new ApiModule(), hostModule],
  });
  try {
    framework.start();
    await run({ framework, membrane, discord, sync: module as unknown as DiscordInternals, host });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const stored = (framework: AgentFramework, text: string) =>
  framework.getAgent(AGENT)!.getContextManager().getAllMessages()
    .filter((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === text));

/** The first request that carries `text`, and the role its message takes
 *  when membrane formats that request for the provider. */
async function compiled(membrane: MockMembrane, text: string): Promise<{ participant: string; role: string }> {
  const carries = (r: NormalizedRequest) => r.messages.some((m) => JSON.stringify(m.content).includes(text));
  await waitFor('a request carrying the message', () => membrane.calls.some(carries));
  const request = membrane.calls.find(carries)!;
  const message = request.messages.find((m) => JSON.stringify(m.content).includes(text))!;
  assert.equal(request.assistantParticipant, AGENT, 'the request names the agent as its assistant');
  const built = new NativeFormatter().buildMessages(request.messages, {
    participantMode: 'multiuser',
    assistantParticipant: request.assistantParticipant,
  });
  const provider = built.messages.find((m) => JSON.stringify(m).includes(text))!;
  return { participant: message.participant, role: (provider as { role: string }).role };
}

test("a Discord author named as the agent is stored as '<name> (Discord)' and compiles as a user turn, never the agent's own", async () => {
  await withFramework(async ({ framework, membrane, discord }) => {
    const text = 'a message from a Discord author who took the agent\'s name';
    await discord.onMessageHandler!({
      id: 'm1', channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: AGENT, isBot: false, content: text,
      isReply: false, mentionedUserIds: ['bot'], attachments: [], timestamp: new Date(1_000),
    });
    assert.deepEqual(await compiled(membrane, text), { participant: `${AGENT} (Discord)`, role: 'user' });
    const [row] = stored(framework, text);
    assert.equal(row?.participant, `${AGENT} (Discord)`);
    assert.deepEqual(row?.metadata?.author, { id: 'u1', name: AGENT });
  });
});

test("on history sync, a Discord author is stored as '<name> (Discord)', and the bot's own message keeps the agent's name", async () => {
  await withFramework(async ({ framework, discord, sync }) => {
    discord.history = [
      { id: 'h1', authorId: 'u1', authorName: AGENT, isBot: false, content: 'an author named as the agent, from history', timestamp: new Date(1_000), attachments: [] },
      { id: 'h2', authorId: 'bot', authorName: 'sol-bot', isBot: true, content: "the bot's own message, from history", timestamp: new Date(2_000), attachments: [] },
    ];
    assert.equal((await sync.syncChannelHistory('c1')).newMessages, 2);
    const [author] = stored(framework, 'an author named as the agent, from history');
    assert.equal(author?.participant, `${AGENT} (Discord)`);
    assert.deepEqual(author?.metadata?.author, { id: 'u1', name: AGENT });
    const [own] = stored(framework, "the bot's own message, from history");
    assert.equal(own?.participant, AGENT);
    assert.equal(own?.metadata?.author, undefined);
  });
});

test("an API caller named as the agent is stored as '<name> (API)' and compiles as a user turn, never the agent's own", async () => {
  await withFramework(async ({ framework, membrane }) => {
    const text = 'a message from an API caller who took the agent\'s name';
    framework.pushEvent({ type: 'api:message', participant: AGENT, content: text } as never);
    assert.deepEqual(await compiled(membrane, text), { participant: `${AGENT} (API)`, role: 'user' });
    const [row] = stored(framework, text);
    assert.deepEqual(row?.metadata?.author, { name: AGENT });
    // The ApiServer's message list returns the participant as stored.
    const server = new ApiServer(framework, { port: 0, host: '127.0.0.1' }) as unknown as {
      cmdMessageList(params?: unknown): Promise<{ messages: Array<{ participant: string; content: unknown }> }>;
    };
    const listed = (await server.cmdMessageList({})).messages.filter((m) => JSON.stringify(m.content).includes(text));
    assert.deepEqual(listed.map((m) => m.participant), [`${AGENT} (API)`]);
  });
});

test("a sender named the generic 'user', in any case, is stored as given, from Discord live and on sync, and from the API", async () => {
  await withFramework(async ({ framework, discord, sync }) => {
    discord.history = [{ id: 'hu', authorId: 'u8', authorName: 'USER', isBot: false, content: 'from history, by an author named USER', timestamp: new Date(1_000), attachments: [] }];
    assert.equal((await sync.syncChannelHistory('c1')).newMessages, 1);
    assert.equal(stored(framework, 'from history, by an author named USER')[0]?.participant, 'USER');
  });
  await withFramework(async ({ membrane, discord }) => {
    await discord.onMessageHandler!({
      id: 'u1', channelId: 'c1', guildId: 'g1', authorId: 'u7', authorName: 'User', isBot: false, content: 'from a Discord author named User',
      isReply: false, mentionedUserIds: ['bot'], attachments: [], timestamp: new Date(1_000),
    });
    assert.equal((await compiled(membrane, 'from a Discord author named User')).participant, 'User');
  });
  await withFramework(async ({ framework, membrane }) => {
    framework.pushEvent({ type: 'api:message', participant: 'user', content: 'from an API caller named user' } as never);
    assert.equal((await compiled(membrane, 'from an API caller named user')).participant, 'user');
  });
});

test("a sender's name that spans lines or holds other control characters is stored on one line, before its marker, and kept as sent in its author", async () => {
  await withFramework(async ({ framework, membrane }) => {
    const text = 'from a caller whose name has line breaks';
    const name = 'a\nb\r\nc\u2028d\u2029\u2029e\u0085f\tg\u0000h';
    framework.pushEvent({ type: 'api:message', participant: name, content: text } as never);
    assert.equal((await compiled(membrane, text)).participant, 'a b c d e f g h (API)');
    const [row] = stored(framework, text);
    assert.equal(row?.participant, 'a b c d e f g h (API)');
    assert.deepEqual(row?.metadata?.author, { name });
  });
});

test("a host's own module still writes an agent's turn under the agent's name", async () => {
  await withFramework(async ({ framework, membrane, host }) => {
    const text = 'an earlier turn the host writes for the agent';
    host.addMessage(AGENT, [{ type: 'text', text }]);
    framework.pushEvent({ type: 'api:message', participant: 'alice', content: 'and then a caller writes' } as never);
    assert.deepEqual(await compiled(membrane, text), { participant: AGENT, role: 'assistant' });
  });
});

test('the ApiServer refuses a participant that is not text, and stores nothing for it', async () => {
  await withFramework(async ({ framework }) => {
    const server = new ApiServer(framework, { port: 0, host: '127.0.0.1' }) as unknown as {
      cmdMessageSend(params: unknown): Promise<unknown>;
    };
    const pushed: unknown[] = [];
    const push = framework.pushEvent.bind(framework);
    (framework as unknown as { pushEvent: (event: unknown) => void }).pushEvent = (event) => { pushed.push(event); push(event as never); };
    const text = 'from a caller whose name is not text';
    for (const participant of [42, true, { name: AGENT }, [AGENT]]) {
      await assert.rejects(server.cmdMessageSend({ participant, content: text }), /participant must be text/);
    }
    await assert.rejects(server.cmdMessageSend({ participant: null, content: text }), /participant and content are required/);
    assert.equal(pushed.length, 0, 'a refused send pushes no event');
    // The control: a caller named in text is stored, after the refused sends would have been.
    await server.cmdMessageSend({ participant: 'alice', content: text });
    assert.equal(pushed.length, 1);
    await waitFor('the control message is stored', () => stored(framework, text).length > 0);
    assert.deepEqual(stored(framework, text).map((m) => m.participant), ['alice (API)']);
  });
});

test("a host's own api:message whose participant is not text is not stored", async () => {
  await withFramework(async ({ framework }) => {
    const text = 'from a host whose participant is not text';
    for (const participant of [42, { name: AGENT }, undefined]) {
      framework.pushEvent({ type: 'api:message', participant, content: text } as never);
    }
    // The control: a text-named event pushed after them is stored, so they were handled before it.
    const control = 'and then one whose participant is text';
    framework.pushEvent({ type: 'api:message', participant: 'alice', content: control } as never);
    await waitFor('the control message is stored', () => stored(framework, control).length > 0);
    assert.deepEqual(stored(framework, text), []);
  });
});

test("an API event's metadata is kept with its message, and so is an author it carries", async () => {
  await withFramework(async ({ framework, membrane }) => {
    const text = 'from a host that names the sender';
    framework.pushEvent({
      type: 'api:message', participant: 'alice', content: text,
      metadata: { channelId: 'c9', author: { id: 'h1', name: 'Host Person' } },
    } as never);
    assert.equal((await compiled(membrane, text)).participant, 'alice (API)');
    const [row] = stored(framework, text);
    assert.equal(row?.metadata?.channelId, 'c9');
    assert.deepEqual(row?.metadata?.author, { id: 'h1', name: 'Host Person' });
  });
});

test("an API event's author that isn't an object is replaced by the caller's plain name", async () => {
  await withFramework(async ({ framework, membrane }) => {
    const text = 'from a host whose author is a bare string';
    framework.pushEvent({ type: 'api:message', participant: 'alice', content: text, metadata: { author: 'someone' } } as never);
    const nullText = 'from a host whose author is null';
    framework.pushEvent({ type: 'api:message', participant: 'alice', content: nullText, metadata: { author: null } } as never);
    await compiled(membrane, text);
    assert.deepEqual(stored(framework, text)[0]?.metadata?.author, { name: 'alice' });
    await waitFor('the null-author message is stored', () => stored(framework, nullText).length > 0);
    assert.deepEqual(stored(framework, nullText)[0]?.metadata?.author, { name: 'alice' });
  });
});

test("history's author filter finds a Discord author by name in rows stored before the change and after it, and by id in rows stored after", async () => {
  await withFramework(async ({ framework, membrane, discord }) => {
    const cm = framework.getAgent(AGENT)!.getContextManager();
    // A row as the Discord module stored it before: the plain name, no author.
    cm.addMessage('alice', [{ type: 'text', text: 'stored before' }], { external: { source: 'discord', id: 'old1' }, channelId: 'c1', timestamp: 500 } as never);
    await discord.onMessageHandler!({
      id: 'new1', channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'alice', isBot: false, content: 'stored after',
      isReply: false, mentionedUserIds: ['bot'], attachments: [], timestamp: new Date(1_000),
    });
    await compiled(membrane, 'stored after');
    assert.equal(stored(framework, 'stored after')[0]?.participant, 'alice (Discord)');
    assert.equal(stored(framework, 'stored before')[0]?.participant, 'alice');
    const history = new HistoryModule();
    history.bind(cm);
    const extract = async (author: string): Promise<string[]> => {
      const r = await history.handleToolCall({ id: 't', name: 'extract', input: { author, channelId: 'c1', format: 'text' } } as ToolCall);
      assert.equal(r.success, true, r.error);
      return (r.data as { messages: Array<{ text?: string; content?: string }> }).messages.map((m) => String(m.text ?? m.content));
    };
    const byName = await extract('alice');
    assert.equal(byName.length, 2, byName.join(' | '));
    assert.ok(byName.some((t) => t.includes('stored before')) && byName.some((t) => t.includes('stored after')), byName.join(' | '));
    const byId = await extract('u1');
    assert.equal(byId.length, 1, byId.join(' | '));
    assert.ok(byId[0]!.includes('stored after'), byId.join(' | '));
  });
});

test("history's author filter finds an API caller by name in rows stored before the change and after it", async () => {
  await withFramework(async ({ framework, membrane }) => {
    const cm = framework.getAgent(AGENT)!.getContextManager();
    // A row as ApiModule stored it before: the plain name, no author.
    cm.addMessage('bob', [{ type: 'text', text: 'sent before' }], { channelId: 'c2' } as never);
    framework.pushEvent({ type: 'api:message', participant: 'bob', content: 'sent after', metadata: { channelId: 'c2' } } as never);
    await compiled(membrane, 'sent after');
    const history = new HistoryModule();
    history.bind(cm);
    const r = await history.handleToolCall({ id: 't', name: 'extract', input: { author: 'bob', channelId: 'c2', format: 'text' } } as ToolCall);
    assert.equal(r.success, true, r.error);
    const found = (r.data as { messages: Array<{ text?: string; content?: string }> }).messages.map((m) => String(m.text ?? m.content));
    assert.equal(found.length, 2, found.join(' | '));
    assert.ok(found.some((t) => t.includes('sent before')) && found.some((t) => t.includes('sent after')), found.join(' | '));
  });
});
