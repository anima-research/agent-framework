/**
 * The admission decision, in isolation: held events never wake and never
 * reach the gate's side effects; vetoed events never wake; deliverable
 * events wake iff the gate says so.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admit, type InboundEnvelope, type AdmissionPolicy } from '../src/admission/admit.js';

const env = (over: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
  lane: 'channel', serverId: 'disc', channelId: 'noisy', messageId: 'm1', addressed: false, vetoed: false,
  gateContent: 'hi', gateMetadata: {}, ...over,
});

function policy(opts: { held?: boolean; gateEvaluate?: boolean; gateProbe?: boolean } = {}) {
  const calls = { evaluate: 0, probe: 0 };
  const p: AdmissionPolicy = {
    untargetedRecipients: () => ['mira', 'nell'],
    holdFor: (serverId, channelId) => opts.held ? { kind: 'tune-out', epochId: 'e1', serverId, channelId } : null,
    gate: {
      evaluate: () => { calls.evaluate++; return opts.gateEvaluate ?? true; },
      probe: () => { calls.probe++; return opts.gateProbe ?? true; },
    },
  };
  return { p, calls };
}

describe('admit', () => {
  it('a deliverable event reaches the untargeted recipients and wakes when the gate passes', () => {
    const { p, calls } = policy();
    const d = admit(env(), p);
    assert.deepEqual(d.recipients, ['mira', 'nell']);
    assert.equal(d.held, null);
    assert.equal(d.wake, true);
    assert.equal(d.locus, true);
    assert.deepEqual(calls, { evaluate: 1, probe: 0 });
  });

  it('explicit targets replace the untargeted set', () => {
    const d = admit(env({ targetAgents: ['fork-1'] }), policy().p);
    assert.deepEqual(d.recipients, ['fork-1']);
  });

  it('a gate that says no leaves the event delivered but unwoken', () => {
    const d = admit(env(), policy({ gateEvaluate: false }).p);
    assert.equal(d.held, null);
    assert.equal(d.wake, false);
    assert.equal(d.gatePass, false);
    assert.equal(d.locus, true, 'a delivered-but-quiet message is still the latest inbound');
  });

  it('a held event never wakes, never moves the locus, and only probes the gate', () => {
    const { p, calls } = policy({ held: true, gateProbe: true });
    const d = admit(env({ addressed: true }), p);
    assert.deepEqual(d.held, { kind: 'tune-out', epochId: 'e1', serverId: 'disc', channelId: 'noisy' });
    assert.equal(d.wake, false);
    assert.equal(d.locus, false);
    assert.equal(d.gatePass, true, 'the hold learns the gate would have woken them');
    assert.deepEqual(calls, { evaluate: 0, probe: 1 }, 'no batch forms, no counter moves');
  });

  it('a held event the gate would have suppressed carries gatePass=false', () => {
    const d = admit(env(), policy({ held: true, gateProbe: false }).p);
    assert.equal(d.gatePass, false);
  });

  it('a vetoed event wakes nobody and is not shown to the gate; held or not', () => {
    const open = policy();
    const d1 = admit(env({ vetoed: true }), open.p);
    assert.equal(d1.wake, false);
    assert.equal(d1.gatePass, false);
    assert.deepEqual(open.calls, { evaluate: 0, probe: 0 });
    const heldP = policy({ held: true });
    const d2 = admit(env({ vetoed: true }), heldP.p);
    assert.ok(d2.held);
    assert.equal(d2.gatePass, false);
    assert.deepEqual(heldP.calls, { evaluate: 0, probe: 0 });
  });

  it('an event without a channel cannot be held', () => {
    const d = admit(env({ lane: 'push', channelId: undefined }), policy({ held: true }).p);
    assert.equal(d.held, null);
    assert.equal(d.wake, true);
  });

  it('without a gate every deliverable event wakes', () => {
    const p: AdmissionPolicy = { untargetedRecipients: () => ['mira'], holdFor: () => null };
    assert.equal(admit(env(), p).wake, true);
  });
});
