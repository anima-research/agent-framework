/**
 * The admission stage (Dendrite §D; issue #232 §3.5).
 *
 * One decision per inbound event, taken before any side effect. Everything
 * downstream — storage, the recipient's view, the wake, the speech locus,
 * the gate's batching — consumes this decision instead of rediscovering the
 * policy at its own stage. The function is pure over the policy inputs it is
 * handed; the framework supplies them and applies the result.
 *
 * What is decided, in the proposal's words:
 *   1. captured   — always; an admitted event is stored where it arrived
 *   2. recipients — who is eligible (explicit targets, else the untargeted set)
 *   3. delivery   — a body in the recipients' view, or a hold
 *   4. wake       — may it start a turn
 *   5. locus      — may it count as "the latest delivered inbound" (never
 *                   under a hold); the channel registry records it under
 *                   either `speech.locus` setting, and makes it the fallback
 *                   locus only under `'latest-inbound'`
 *
 * A hold is a policy epoch over a channel (today: tune-out). Residents share
 * one message slot, so a hold applies to the slot: every resident recipient
 * gets the same disposition. A reader of the slot (the subconscious, or a
 * reader fork) sees held traffic through its own view; that is not a
 * delivery decision of this stage.
 *
 * Suppression is the other disposition: a suppress rule (a gate rule with
 * a `suppress` object) took the event, so it's stored and never rendered, for
 * any reader. It's decided first. A suppressed event is never held, never
 * shown to the gate, never woken for, and never the locus.
 */

export interface InboundEnvelope {
  /** Which MCPL lane carried it. */
  lane: 'channel' | 'push';
  serverId: string;
  /** Endpoint-qualified channel id when the event has one (a push event
   *  without channel provenance — heartbeat, timer — has none). */
  channelId?: string;
  /** Platform message id, or the push event id. */
  messageId: string;
  authorId?: string;
  tags?: string[];
  /** `chat:addressed` (mention / reply / DM) or the server's equivalent. */
  addressed: boolean;
  /**
   * The server-side veto: a per-server `shouldTriggerInference` said no, or
   * the event is a materialized coalesced delivery whose wake already
   * happened (`triggerInference: false`). A vetoed event wakes nobody and is
   * not shown to the gate as a fresh event.
   */
  vetoed: boolean;
  /** Explicit recipients named by the event, if any. */
  targetAgents?: string[];
  /** What the gate sees: the text and the metadata shape it has always matched on. */
  gateContent: string;
  gateMetadata: Record<string, unknown>;
  silentHeartbeat?: { eventId: string; serverId: string };
}

export interface HoldRecord {
  kind: 'tune-out';
  epochId: string;
  serverId: string;
  channelId: string;
}

export interface AdmissionPolicy {
  /** The recipients an untargeted event reaches. */
  untargetedRecipients(): string[];
  /** The hold in force over this channel, if any. */
  holdFor(serverId: string, channelId: string): HoldRecord | null;
  /**
   * The wake gate. `evaluate` may have side effects (debounce batching,
   * counters, traces) and is called only for an event that may reach the
   * recipients; `probe` is side-effect-free and answers "would the gate have
   * woken them" for a held event, which the hold's own policy needs.
   */
  gate?: {
    evaluate(env: InboundEnvelope): boolean;
    probe(env: InboundEnvelope): boolean;
  };
  /**
   * The suppress rule that takes this event, or null; null where the event
   * would land in a view that doesn't hide suppressed rows. Asked once per
   * event, since it commits (a rule's script keeps the state it leaves, the
   * gate's decideSuppression). Left out, nothing is suppressed.
   */
  suppressionFor?(env: InboundEnvelope): string | null;
}

/** The record a suppressed event's row carries: the rule that took it. */
export interface SuppressionRecord {
  rule: string;
}

export interface AdmissionDecision {
  recipients: string[];
  /** Null = delivered into the recipients' view; otherwise held, with the record to stamp. */
  held: HoldRecord | null;
  /** Null unless a suppress rule took the event: then it's stored, never rendered, and nothing else is decided for it. */
  suppressed: SuppressionRecord | null;
  /** Whether the recipients may be woken by this event. */
  wake: boolean;
  /**
   * The gate's verdict as a precondition for whatever reads the hold: true
   * when the gate would (or did) wake the recipients. For a held event this
   * comes from the side-effect-free probe; for a vetoed event it is false.
   */
  gatePass: boolean;
  /** Whether this arrival may count as the latest delivered inbound message. */
  locus: boolean;
}

export function admit(env: InboundEnvelope, policy: AdmissionPolicy): AdmissionDecision {
  const recipients = env.targetAgents ?? policy.untargetedRecipients();

  // Suppressed: stored where it arrived and never rendered, so nothing
  // downstream acts for anyone. Not held (a reader would see it), not shown
  // to the gate's evaluate (no batch forms; the passthrough rules ahead of its
  // rule have counted it), not a wake, not the locus.
  const rule = policy.suppressionFor?.(env) ?? null;
  if (rule !== null) {
    return { recipients, held: null, suppressed: { rule }, wake: false, gatePass: false, locus: false };
  }

  const held = env.channelId ? policy.holdFor(env.serverId, env.channelId) : null;

  if (held) {
    // Held: nothing downstream may act for the recipients. The gate is only
    // asked what it would have done — no batch forms, no counter moves.
    const gatePass = env.vetoed ? false : (policy.gate ? policy.gate.probe(env) : true);
    return { recipients, held, suppressed: null, wake: false, gatePass, locus: false };
  }

  if (env.vetoed) {
    return { recipients, held: null, suppressed: null, wake: false, gatePass: false, locus: true };
  }

  // Deliverable: now the gate may take its side effects (a debounce batch
  // is the gate's own deferred wake and is consumed later by the same rule).
  const gatePass = policy.gate ? policy.gate.evaluate(env) : true;
  return { recipients, held: null, suppressed: null, wake: gatePass, gatePass, locus: true };
}
