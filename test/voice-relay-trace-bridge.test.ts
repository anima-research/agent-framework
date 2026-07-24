/**
 * InferenceTraceBridge — the trace-to-relay translation table.
 *
 * Synthetic framework traces in, relay wire messages out: identity
 * resolution, visible derivation (text chunks are voiced, thinking is not),
 * block-content accumulation for block_complete, terminal-trace mapping to
 * activation_end reasons, channel-less drops, and unsubscribe on stop().
 *
 * The module-level behavior around the bridge (socket delivery, interruption
 * addressing, staleness guard) is covered in voice-relay-client.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InferenceTraceBridge } from '../src/modules/voice-relay/index.js';
import type { BotStreamMessage, RelayLogger } from '../src/modules/voice-relay/types.js';
import type { TraceEvent } from '../src/types/trace.js';
import type { ModuleContext } from '../src/types/module.js';

const silentLogger: RelayLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeBridge(
  identity?: { userId?: string; username?: string },
  agentFilter?: (agentName: string) => boolean,
) {
  const sent: Array<{ msg: BotStreamMessage }> = [];
  let listener: ((e: TraceEvent) => void) | null = null;
  const ctx = {
    onTrace: (l: (e: TraceEvent) => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  } as unknown as ModuleContext;

  const bridge = new InferenceTraceBridge(
    (msg) => sent.push({ msg }),
    () => identity,
    silentLogger,
    agentFilter,
  );
  bridge.start(ctx);
  const emit = (e: Partial<TraceEvent> & { type: string }) =>
    listener!({ timestamp: 1710900000000, ...e } as TraceEvent);
  return { bridge, sent, emit };
}

test('bridge: started → activation_start with resolved identity', () => {
  const { sent, emit } = makeBridge({ username: 'Opus 4.5' });
  emit({ type: 'inference:started', agentName: 'opus45', channelId: 'chan-1' } as never);

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    msg: {
      type: 'activation_start',
      botId: 'opus45',
      userId: 'opus45',
      username: 'Opus 4.5',
      channelId: 'chan-1',
      timestamp: 1710900000000,
    },
  });
});

test('bridge: agent filter drops other agents\' traces entirely', () => {
  const { sent, emit } = makeBridge(undefined, (name) => name === 'mine');
  emit({ type: 'inference:started', agentName: 'mine', channelId: 'c' } as never);
  emit({ type: 'inference:started', agentName: 'other', channelId: 'c' } as never);
  emit({ type: 'inference:tokens', agentName: 'other', channelId: 'c', content: 'x', blockType: 'text', blockIndex: 0 } as never);

  assert.equal(sent.length, 1, 'only the filtered-in agent is translated');
  assert.equal((sent[0].msg as { botId: string }).botId, 'mine');
});

test('bridge: tokens → chunk with visible derived from blockType', () => {
  const { sent, emit } = makeBridge();
  emit({
    type: 'inference:tokens',
    agentName: 'a',
    channelId: 'c',
    content: 'Hello ',
    blockType: 'text',
    blockIndex: 0,
  } as never);
  emit({
    type: 'inference:tokens',
    agentName: 'a',
    channelId: 'c',
    content: 'hmm...',
    blockType: 'thinking',
    blockIndex: 1,
  } as never);

  const [text, thinking] = sent.map((s) => s.msg as { visible: boolean; text: string; type: string });
  assert.equal(text.type, 'chunk');
  assert.equal(text.visible, true, 'text chunks are voiced');
  assert.equal(thinking.visible, false, 'thinking chunks are not voiced');
});

test('bridge: block_complete carries content accumulated from chunk traces', () => {
  const { sent, emit } = makeBridge();
  emit({ type: 'inference:content_block', agentName: 'a', channelId: 'c', phase: 'block_start', blockType: 'text', blockIndex: 0 } as never);
  emit({ type: 'inference:tokens', agentName: 'a', channelId: 'c', content: 'Hello ', blockType: 'text', blockIndex: 0 } as never);
  emit({ type: 'inference:tokens', agentName: 'a', channelId: 'c', content: 'world', blockType: 'text', blockIndex: 0 } as never);
  emit({ type: 'inference:content_block', agentName: 'a', channelId: 'c', phase: 'block_complete', blockType: 'text', blockIndex: 0 } as never);

  const complete = sent.at(-1)!.msg as { type: string; content: string };
  assert.equal(complete.type, 'block_complete');
  assert.equal(complete.content, 'Hello world');
});

test('bridge: terminal traces map to activation_end reasons; accumulator clears', () => {
  for (const [type, reason] of [
    ['inference:completed', 'complete'],
    ['inference:turn_ended', 'complete'],
    ['inference:aborted', 'abort'],
    ['inference:failed', 'error'],
  ] as const) {
    const { sent, emit } = makeBridge();
    emit({ type: 'inference:tokens', agentName: 'a', channelId: 'c', content: 'x', blockType: 'text', blockIndex: 0 } as never);
    emit({ type, agentName: 'a', channelId: 'c', durationMs: 5, error: 'boom' } as never);

    const end = sent.at(-1)!.msg as { type: string; reason: string };
    assert.equal(end.type, 'activation_end', `${type} ends the activation`);
    assert.equal(end.reason, reason, `${type} → ${reason}`);

    // Accumulator cleared: a new block 0 must not inherit old text.
    emit({ type: 'inference:tokens', agentName: 'a', channelId: 'c', content: 'fresh', blockType: 'text', blockIndex: 0 } as never);
    emit({ type: 'inference:content_block', agentName: 'a', channelId: 'c', phase: 'block_complete', blockType: 'text', blockIndex: 0 } as never);
    const complete = sent.at(-1)!.msg as { content: string };
    assert.equal(complete.content, 'fresh', `accumulator reset after ${type}`);
  }
});

test('bridge: stream_restarted closes the abandoned activation with abort', () => {
  const { sent, emit } = makeBridge();
  emit({ type: 'inference:tokens', agentName: 'a', channelId: 'c', content: 'x', blockType: 'text', blockIndex: 0 } as never);
  emit({ type: 'inference:stream_restarted', agentName: 'a', channelId: 'c', reason: 'context_budget_restart', inputTokens: 1, budget: 1 } as never);

  const end = sent.at(-1)!.msg as { type: string; reason: string };
  assert.equal(end.type, 'activation_end', 'restart pairs the dangling activation_start');
  assert.equal(end.reason, 'abort', 'the partial utterance was cut off, not finished');

  // A channel-less restart has nothing to close on the wire.
  const before = sent.length;
  emit({ type: 'inference:stream_restarted', agentName: 'a', reason: 'r', inputTokens: 1, budget: 1 } as never);
  assert.equal(sent.length, before);
});

test('bridge: traces without channelId are dropped; unrelated traces ignored', () => {
  const { sent, emit } = makeBridge();
  emit({ type: 'inference:started', agentName: 'a' } as never);
  emit({ type: 'inference:tokens', agentName: 'a', content: 'x', blockType: 'text', blockIndex: 0 } as never);
  emit({ type: 'message:added', messageId: 'm1', source: 's' } as never);
  emit({ type: 'inference:usage', agentName: 'a', tokenUsage: { input: 1, output: 1 } } as never);

  assert.equal(sent.length, 0, 'nothing fans out without a channel');
});

test('bridge: stop() unsubscribes', () => {
  const { bridge, sent, emit } = makeBridge();
  bridge.stop();
  assert.throws(() => emit({ type: 'inference:started', agentName: 'a', channelId: 'c' } as never));
  assert.equal(sent.length, 0);
});
