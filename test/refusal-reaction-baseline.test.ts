/**
 * The exported REFUSAL_REACTION_BASELINE must be exactly the set of markers
 * reactToRefusal can emit — every category's emoji plus the unknown-category
 * fallback, nothing more, nothing less. Host composition serializes this
 * export into DISCORD_SUPPRESSED_REACTIONS_BASELINE; if the emitted set and
 * the export could drift, a framework annotation could re-enter a resident's
 * context as a reaction event (the 8/3 Mythos self-amplifying refusal loop).
 * The implementation shares one constant; these tests pin the contract so a
 * refactor that splits them fails here first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';
import {
  REFUSAL_REACTIONS,
  REFUSAL_REACTION_FALLBACK,
  REFUSAL_REACTION_BASELINE,
} from '../src/refusal-reactions.js';

/** Drive the private reactToRefusal against a Discord locus, capturing the
 *  emoji it stamps. */
async function emittedFor(category: string): Promise<string> {
  const calls: Array<{ tool: string; args: { emoji: string } }> = [];
  const fakeThis = {
    channelRegistry: {
      buildChannelContext: () => ({
        incoming: { channelId: 'discord:g1:c1', messageId: 'm1' },
      }),
      getChannelServerId: () => 'srv1',
    },
    mcplServerRegistry: {
      getServer: () => ({
        sendToolsCall: (tool: string, args: { emoji: string }) => {
          calls.push({ tool, args });
          return Promise.resolve({});
        },
      }),
    },
  };
  const react = (
    AgentFramework.prototype as unknown as {
      reactToRefusal: (agentName: string, category: string) => Promise<void>;
    }
  ).reactToRefusal;
  await react.call(fakeThis, 'tester', category);
  assert.equal(calls.length, 1, `exactly one reaction for category "${category}"`);
  assert.equal(calls[0].tool, 'add_reaction');
  return calls[0].args.emoji;
}

describe('refusal-reaction baseline export', () => {
  it('baseline = category map values + fallback, deduplicated, no empties', () => {
    const expected = new Set([...Object.values(REFUSAL_REACTIONS), REFUSAL_REACTION_FALLBACK]);
    assert.deepEqual(new Set(REFUSAL_REACTION_BASELINE), expected);
    assert.equal(REFUSAL_REACTION_BASELINE.length, expected.size, 'no duplicates');
    assert.ok(REFUSAL_REACTION_BASELINE.every((e) => e.length > 0), 'no empty entries');
    assert.ok(REFUSAL_REACTION_BASELINE.includes(REFUSAL_REACTION_FALLBACK));
  });

  it('every emitted annotation is in the baseline — known categories and unknown fallback', async () => {
    const emitted = new Set<string>();
    for (const category of Object.keys(REFUSAL_REACTIONS)) {
      emitted.add(await emittedFor(category));
    }
    emitted.add(await emittedFor('some_future_category'));

    for (const emoji of emitted) {
      assert.ok(
        REFUSAL_REACTION_BASELINE.includes(emoji),
        `emitted ${emoji} must be suppressible via the exported baseline`,
      );
    }
    // Exactness both ways: the framework can emit everything the baseline
    // names — no stale entries suppressing markers nothing stamps anymore.
    assert.deepEqual(emitted, new Set(REFUSAL_REACTION_BASELINE));
  });

  it('serialized baseline survives the Discord adapter env round-trip (comma-join)', () => {
    // Host composition joins with ','; discord-mcpl's parseSuppressionEnvTokens
    // splits on ',' and trims. Entries therefore must not contain commas or
    // leading/trailing whitespace, or the round-trip changes the set.
    for (const e of REFUSAL_REACTION_BASELINE) {
      assert.ok(!e.includes(','), `"${e}" would split under comma-join`);
      assert.equal(e, e.trim(), `"${e}" would change under trim`);
    }
    const roundTripped = REFUSAL_REACTION_BASELINE.join(',').split(',').map((s) => s.trim());
    assert.deepEqual(roundTripped, [...REFUSAL_REACTION_BASELINE]);
  });
});
