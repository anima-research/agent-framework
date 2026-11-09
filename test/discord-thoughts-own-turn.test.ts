import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { ConversationContext, DiscordClientInterface } from '../src/modules/discord/types.js';
import type { SpeechContext } from '../src/types/index.js';

// On a turn with tool calls, the framework hands the Discord module the turn's
// text as `thoughts`, with the turn's id, and the module edits them, as a
// spoiler, into the message the same agent posted in that turn. A message of
// another agent's, or of an earlier turn, never takes them.

const trigger = { reason: 'test', source: 'test', timestamp: 0 };
const ends = (turnId: number | undefined): SpeechContext => ({
  turnComplete: true,
  trigger,
  thoughts: [{ type: 'text', text: 'why' }],
  ...(turnId !== undefined ? { turnId } : {}),
});

function setup(rateLimitPerMinute?: number) {
  let n = 0;
  const posted = new Map<string, string>();
  const edits: string[] = [];
  const failures = { send: false, dm: false };
  const client = {
    sendMessage: async (_channelId: string, content: string) => {
      if (failures.send) {
        failures.send = false;
        throw new Error('Missing Permissions');
      }
      const messageId = `M${++n}`;
      posted.set(messageId, content);
      return { messageId };
    },
    sendDM: async (_userId: string, content: string) => {
      if (failures.dm) {
        failures.dm = false;
        throw new Error('Cannot send messages to this user');
      }
      const messageId = `D${++n}`;
      posted.set(messageId, content);
      return { messageId };
    },
    fetchMessage: async (_channelId: string, messageId: string) => posted.get(messageId) ?? '',
    editMessage: async (_channelId: string, messageId: string, content: string) => {
      edits.push(`${messageId}: ${content}`);
    },
  } as unknown as DiscordClientInterface;
  const module = new DiscordModule(client, { token: 'test-token', rateLimitPerMinute });
  const replyContexts = (module as unknown as { replyContexts: Map<string, ConversationContext> }).replyContexts;
  replyContexts.set('default', { channelId: 'c1', userId: 'u1' } as ConversationContext);
  /** A tool call as the framework dispatches it: by `agent`, in turn `turnId`. */
  const tool = (agent: string, turnId: number | undefined, name: string, input: unknown) =>
    module.handleToolCall({
      id: `call-${name}` as never,
      name,
      input,
      callerAgentName: agent,
      ...(turnId !== undefined ? { callerTurnId: turnId } : {}),
    });
  const send = async (agent: string, turnId: number | undefined, content: string) =>
    assert.equal((await tool(agent, turnId, 'send', { channelId: 'c1', content })).success, true);
  return { module, edits, failures, replyContexts, tool, send };
}

/** Attempts to post in a turn that leave no message of their own for its thoughts. */
const attempts: Array<{
  name: string;
  rateLimitPerMinute?: number;
  attempt: (s: ReturnType<typeof setup>, agent: string, turnId: number) => Promise<void>;
}> = [
  {
    name: 'a send that throws',
    attempt: async ({ tool, failures }, agent, turnId) => {
      failures.send = true;
      assert.equal((await tool(agent, turnId, 'send', { channelId: 'c1', content: 'second' })).success, false);
    },
  },
  {
    name: 'a send refused by the rate limit',
    rateLimitPerMinute: 1,
    attempt: async ({ tool }, agent, turnId) => {
      assert.match((await tool(agent, turnId, 'send', { channelId: 'c1', content: 'second' })).error ?? '', /^Nothing was sent: channel c1 has reached this host's limit/);
    },
  },
  {
    name: 'a reply that throws',
    attempt: async ({ tool, failures }, agent, turnId) => {
      failures.send = true;
      assert.equal((await tool(agent, turnId, 'reply', { content: 'second' })).success, false);
    },
  },
  {
    name: 'a reply refused by the rate limit',
    rateLimitPerMinute: 1,
    attempt: async ({ tool }, agent, turnId) => {
      assert.match((await tool(agent, turnId, 'reply', { content: 'second' })).error ?? '', /^Nothing was sent: this conversation's channel \(c1\) has reached this host's limit/);
    },
  },
  {
    name: 'a reply refused for want of a conversation context',
    attempt: async ({ tool, replyContexts }, agent, turnId) => {
      replyContexts.delete('default');
      assert.match((await tool(agent, turnId, 'reply', { content: 'second' })).error ?? '', /^Nothing was sent: there's no conversation to reply in\./);
    },
  },
  {
    name: 'a DM that posts',
    attempt: async ({ tool }, agent, turnId) => {
      assert.equal((await tool(agent, turnId, 'dm', { userId: 'u1', content: 'second' })).success, true);
    },
  },
  {
    name: 'a DM that throws',
    attempt: async ({ tool, failures }, agent, turnId) => {
      failures.dm = true;
      assert.equal((await tool(agent, turnId, 'dm', { userId: 'u1', content: 'second' })).success, false);
    },
  },
];

for (const { name, rateLimitPerMinute, attempt } of attempts) {
  test(`after ${name} in the same turn, the turn's thoughts are edited into the turn's own post`, async () => {
    const s = setup(rateLimitPerMinute);
    await s.send('A', 1, 'first');
    await attempt(s, 'A', 1);
    await s.module.onAgentSpeech('A', [], ends(1));
    assert.deepEqual(s.edits, ['M1: ||why||\nfirst']);
  });

  test(`after ${name} in a later turn, that turn's thoughts are edited into no earlier turn's message`, async () => {
    const s = setup(rateLimitPerMinute);
    await s.send('A', 1, 'first');
    await attempt(s, 'A', 2);
    await s.module.onAgentSpeech('A', [], ends(2));
    assert.deepEqual(s.edits, []);
  });
}

test('a send that posts takes its own turn\'s thoughts', async () => {
  const s = setup();
  await s.send('A', 1, 'first');
  await s.module.onAgentSpeech('A', [], ends(1));
  assert.deepEqual(s.edits, ['M1: ||why||\nfirst']);
});

test('a reply that posts takes its own turn\'s thoughts', async () => {
  const s = setup();
  assert.equal((await s.tool('A', 1, 'reply', { content: 'first' })).success, true);
  await s.module.onAgentSpeech('A', [], ends(1));
  assert.deepEqual(s.edits, ['M1: ||why||\nfirst']);
});

test('the module\'s own speech that posts takes thoughts that come later in its turn', async () => {
  const s = setup();
  await s.module.onAgentSpeech('A', [{ type: 'text', text: 'first' }], { turnComplete: true, trigger, turnId: 1 });
  await s.module.onAgentSpeech('A', [], ends(1));
  assert.deepEqual(s.edits, ['M1: ||why||\nfirst']);
});

test('a turn that posts nothing has its thoughts edited into no message of the agent\'s earlier text turn', async () => {
  const s = setup();
  await s.module.onAgentSpeech('A', [{ type: 'text', text: 'first' }], { turnComplete: true, trigger, turnId: 1 });
  await s.module.onAgentSpeech('A', [], ends(2));
  assert.deepEqual(s.edits, []);
});

test('another agent\'s post doesn\'t take an agent\'s thoughts, and each agent\'s thoughts go into its own post', async () => {
  const s = setup();
  await s.send('A', 1, 'from A');
  await s.send('B', 2, 'from B');
  await s.module.onAgentSpeech('A', [], ends(1));
  await s.module.onAgentSpeech('B', [], ends(2));
  assert.deepEqual(s.edits, ['M1: ||why||\nfrom A', 'M2: ||why||\nfrom B']);
});

test('an agent that posted nothing has its thoughts edited into no other agent\'s post', async () => {
  const s = setup();
  await s.send('A', 1, 'from A');
  await s.module.onAgentSpeech('B', [], ends(2));
  assert.deepEqual(s.edits, []);
});

test('thoughts edited into a post aren\'t edited into it again', async () => {
  const s = setup();
  await s.send('A', 1, 'first');
  await s.module.onAgentSpeech('A', [], ends(1));
  await s.module.onAgentSpeech('A', [], ends(1));
  assert.deepEqual(s.edits, ['M1: ||why||\nfirst']);
});

test('a later turn\'s post leaves the earlier turn\'s late thoughts no message, and takes its own', async () => {
  const s = setup();
  await s.send('A', 1, 'first');
  await s.send('A', 2, 'second');
  await s.module.onAgentSpeech('A', [], ends(1));
  assert.deepEqual(s.edits, [], 'the earlier turn\'s thoughts edit nothing');
  await s.module.onAgentSpeech('A', [], ends(2));
  assert.deepEqual(s.edits, ['M2: ||why||\nsecond']);
});

test('an earlier turn\'s post that finishes after a later turn\'s leaves the later turn\'s post to take its thoughts', async () => {
  const s = setup();
  await s.send('A', 2, 'second');
  // The module's own speech for turn 1 posts only after turn 2 has posted.
  await s.module.onAgentSpeech('A', [{ type: 'text', text: 'late first' }], { turnComplete: true, trigger, turnId: 1 });
  await s.module.onAgentSpeech('A', [], ends(2));
  assert.deepEqual(s.edits, ['M1: ||why||\nsecond']);
});

test('an agent\'s later post in a turn takes the turn\'s thoughts', async () => {
  const s = setup();
  await s.send('A', 1, 'first');
  await s.send('A', 1, 'second');
  await s.module.onAgentSpeech('A', [], ends(1));
  assert.deepEqual(s.edits, ['M2: ||why||\nsecond']);
});

test('the module keeps the latest posts of at most 1,024 agents, and the agent that posted longest ago goes first', async () => {
  const s = setup(10_000);
  for (let i = 0; i < 1024; i++) await s.send(`agent-${i}`, i + 1, `post ${i}`);
  await s.send('agent-0', 2000, 'again 0');
  await s.send('agent-1024', 3000, 'post 1024');
  await s.module.onAgentSpeech('agent-1', [], ends(2));
  await s.module.onAgentSpeech('agent-0', [], ends(2000));
  await s.module.onAgentSpeech('agent-1024', [], ends(3000));
  assert.deepEqual(s.edits, ['M1025: ||why||\nagain 0', 'M1026: ||why||\npost 1024']);
});

test('a post made with no turn takes no thoughts, neither a turn\'s nor thoughts with no turn', async () => {
  const s = setup();
  await s.send('A', undefined, 'no turn');
  await s.module.onAgentSpeech('A', [], ends(undefined));
  await s.module.onAgentSpeech('A', [], ends(1));
  assert.deepEqual(s.edits, []);
});

test('a post made with no turn leaves the turn\'s own post to take the turn\'s thoughts', async () => {
  const s = setup();
  await s.send('A', 1, 'first');
  await s.send('A', undefined, 'no turn');
  await s.module.onAgentSpeech('A', [], ends(1));
  assert.deepEqual(s.edits, ['M1: ||why||\nfirst']);
});

test('thoughts with no turn go into no post, and leave it for its own turn\'s thoughts', async () => {
  const s = setup();
  await s.send('A', 1, 'first');
  await s.module.onAgentSpeech('A', [], ends(undefined));
  assert.deepEqual(s.edits, []);
  await s.module.onAgentSpeech('A', [], ends(1));
  assert.deepEqual(s.edits, ['M1: ||why||\nfirst']);
});
