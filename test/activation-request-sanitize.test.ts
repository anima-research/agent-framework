/**
 * Live-path empty-text sanitize (PR #58, 8a89da0): the Anthropic API rejects
 * empty text blocks with a 400, and one such block in the compiled window used
 * to mute the agent entirely — [inference-failed] on every activation until
 * the offending message aged out (field-observed 2026-07-10). The sanitize in
 * buildActivationRequest strips empty/whitespace/non-string text blocks and
 * drops messages left with no content, BEFORE the trailing-assistant check.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
import type { ContextManager } from '@animalabs/context-manager';
import type { Membrane } from '@animalabs/membrane';

/** buildActivationRequest only needs compile(); membrane is never touched. */
function agentCompiling(messages: unknown[]): Agent {
  const cm = {
    compile: async () => ({ messages, systemInjections: [] }),
  } as unknown as ContextManager;
  return new Agent(
    { name: 'tester', model: 'test-model', systemPrompt: 'sys' },
    cm,
    {} as Membrane,
  );
}

describe('buildActivationRequest empty-text sanitize', () => {
  it('strips empty and whitespace-only text blocks, keeps real text', async () => {
    const agent = agentCompiling([
      {
        participant: 'human',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '   \n\t ' },
          { type: 'text', text: 'hello' },
        ],
      },
    ]);
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.messages.length, 1);
    assert.deepEqual(request.messages[0]!.content, [{ type: 'text', text: 'hello' }]);
  });

  it('strips text blocks whose `text` is not a string (untyped history from disk)', async () => {
    const agent = agentCompiling([
      {
        participant: 'human',
        content: [
          { type: 'text', text: null },
          { type: 'text', text: 42 },
          { type: 'text', text: 'kept' },
        ],
      },
    ]);
    const request = await agent.buildActivationRequest([]);
    assert.deepEqual(request.messages[0]!.content, [{ type: 'text', text: 'kept' }]);
  });

  it('drops a message left with no content at all', async () => {
    const agent = agentCompiling([
      { participant: 'human', content: [{ type: 'text', text: '' }] },
      { participant: 'human', content: [{ type: 'text', text: 'still here' }] },
    ]);
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.messages.length, 1);
    assert.deepEqual(request.messages[0]!.content, [{ type: 'text', text: 'still here' }]);
  });

  it('passes non-text blocks through untouched — tool pairing is unaffected', async () => {
    const toolUse = { type: 'tool_use', id: 't1', name: 'shell', input: {} };
    const toolResult = { type: 'tool_result', toolUseId: 't1', content: 'ok' };
    const agent = agentCompiling([
      { participant: 'human', content: [{ type: 'text', text: 'run it' }] },
      // Tool-only assistant turn whose accompanying text block is empty: the
      // exact shape that produced the field incident.
      { participant: 'tester', content: [{ type: 'text', text: '' }, toolUse] },
      { participant: 'user', content: [toolResult] },
      { participant: 'human', content: [{ type: 'text', text: 'and?' }] },
    ]);
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.messages.length, 4);
    assert.deepEqual(request.messages[1]!.content, [toolUse]);
    assert.deepEqual(request.messages[2]!.content, [toolResult]);
  });

  it('runs BEFORE the trailing-assistant check: a sanitize-exposed trailing assistant still gets [Continue]', async () => {
    const agent = agentCompiling([
      { participant: 'human', content: [{ type: 'text', text: 'hi' }] },
      { participant: 'tester', content: [{ type: 'text', text: 'ok' }] },
      // Empty trailing user message: dropped by the sanitize, which leaves the
      // assistant turn last — the [Continue] guard must see THAT shape.
      { participant: 'human', content: [{ type: 'text', text: '  ' }] },
    ]);
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.messages.length, 3);
    const last = request.messages[request.messages.length - 1]!;
    assert.equal(last.participant, 'user');
    assert.deepEqual(last.content, [{ type: 'text', text: '[Continue]' }]);
  });
});
