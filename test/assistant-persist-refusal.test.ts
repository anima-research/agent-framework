/**
 * A turn whose entire output is thinking blocks produced NOTHING — no speech,
 * no tool call. That is what a refusal looks like on the wire (the provider
 * returns signed thinking, often with empty text under the fable-5 hidden-CoT
 * packaging, and no content). Storing it records an action that never
 * happened, and two such records landing ADJACENT are toxic: formatters merge
 * consecutive same-role messages, yielding one assistant message that carries
 * signed thinking from two different responses — which the provider cannot
 * verify. labclaude went hard down ~4h on exactly that pair (2026-07-27).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
import type { ContextManager } from '@animalabs/context-manager';
import type { Membrane } from '@animalabs/membrane';

function agentRecording(stored: Array<{ participant: string; content: unknown[] }>): Agent {
  const cm = {
    addMessage: (participant: string, content: unknown[]) => {
      stored.push({ participant, content });
      return 'id';
    },
    compile: async () => ({ messages: [], systemInjections: [] }),
  } as unknown as ContextManager;
  return new Agent(
    { name: 'tester', model: 'test-model', systemPrompt: 'sys' },
    cm,
    {} as Membrane,
  );
}

describe('assistant persist: refusals are not stored', () => {
  it('refuses to store a thinking-only assistant message', () => {
    const stored: Array<{ participant: string; content: unknown[] }> = [];
    agentRecording(stored).addAssistantResponse([
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
    ]);
    assert.equal(stored.length, 0, 'nothing persisted for a turn with no output');
  });

  it('refuses a multi-block thinking-only message (thinking + redacted_thinking)', () => {
    const stored: Array<{ participant: string; content: unknown[] }> = [];
    agentRecording(stored).addAssistantResponse([
      { type: 'thinking', thinking: '', signature: 'sig-a' },
      { type: 'redacted_thinking', data: 'zzz' },
    ]);
    assert.equal(stored.length, 0);
  });

  it('stores thinking that accompanies real output (text)', () => {
    const stored: Array<{ participant: string; content: unknown[] }> = [];
    agentRecording(stored).addAssistantResponse([
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'text', text: 'hello' },
    ]);
    assert.equal(stored.length, 1, 'a real turn keeps its thinking block');
    assert.equal((stored[0]!.content as Array<{ type: string }>).length, 2);
  });

  it('stores thinking that accompanies a tool call', () => {
    const stored: Array<{ participant: string; content: unknown[] }> = [];
    agentRecording(stored).addAssistantResponse([
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
    ]);
    assert.equal(stored.length, 1);
  });

  it('does not interfere with empty content (nothing to store either way)', () => {
    const stored: Array<{ participant: string; content: unknown[] }> = [];
    agentRecording(stored).addAssistantResponse([]);
    assert.equal(stored.length, 1, 'empty content is left to existing behavior');
  });
});
