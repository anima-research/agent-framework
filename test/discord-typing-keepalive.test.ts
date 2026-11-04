import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { ConversationContext, DiscordClientInterface } from '../src/modules/discord/types.js';
import type { ModuleContext, TraceEvent, TraceEventListener } from '../src/types/index.js';

// Discord's typing indicator expires after about 10 s, so the module refreshes
// it within that, from a turn's inference:started until an event that ends
// the turn.
const INDICATOR_LIFE_MS = 10_000;
const agentName = 'assistant';

const turnEnds: TraceEvent[] = [
  // The normal end: the turn's stream completed.
  { type: 'inference:completed', agentName, durationMs: 5, timestamp: 0 },
  { type: 'inference:turn_ended', agentName, timestamp: 0 },
  { type: 'inference:aborted', agentName, durationMs: 5, timestamp: 0 },
  { type: 'inference:failed', agentName, error: 'provider error', timestamp: 0 },
  { type: 'inference:exhausted', agentName, error: 'provider error', timestamp: 0 },
];

async function startModule(): Promise<{
  module: DiscordModule;
  emit: TraceEventListener;
  typings: () => number;
}> {
  let typings = 0;
  const client = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    getBotUserId: () => undefined,
    onMessage: () => {},
    onMessageEdit: () => {},
    onMessageDelete: () => {},
    sendTyping: async () => {
      typings += 1;
    },
  } as unknown as DiscordClientInterface;
  let listener: TraceEventListener | undefined;
  const ctx = {
    isRestart: false,
    getState: () => undefined,
    setState: () => {},
    registerSpeechHandler: () => {},
    onTrace: (subscriber: TraceEventListener) => {
      listener = subscriber;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as ModuleContext;
  const module = new DiscordModule(client, { token: 'test-token' });
  await module.start(ctx);
  // Where the agent's reply goes, as an incoming Discord message would set it.
  (module as unknown as { replyContexts: Map<string, ConversationContext> }).replyContexts.set('default', {
    channelId: 'channel-1',
    userId: 'user-1',
  } as ConversationContext);
  return { module, emit: (event) => listener?.(event), typings: () => typings };
}

for (const end of turnEnds) {
  test(`the typing keepalive a turn started stops at ${end.type}`, async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const { module, emit, typings } = await startModule();
      try {
        emit({ type: 'inference:started', agentName, timestamp: 0 });
        assert.equal(typings(), 1, 'typing shows as the turn starts');
        mock.timers.tick(INDICATOR_LIFE_MS);
        assert.ok(typings() >= 2, "and is refreshed within the indicator's life while the turn runs");
        const shown = typings();

        emit(end);
        mock.timers.tick(INDICATOR_LIFE_MS * 3);
        assert.equal(typings(), shown, `no refresh after ${end.type}`);
      } finally {
        await module.stop();
      }
    } finally {
      mock.timers.reset();
    }
  });
}
