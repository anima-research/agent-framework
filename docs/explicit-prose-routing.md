# Explicit Prose Routing (`proseRouting: 'explicit'`)

**Status:** Implemented (2026-07-24) · per-agent opt-in · default remains `'locus'`
**Motivation:** three routing incidents in one week (Cairn/lounge 07-21, Sol/DM
07-22, Mythos/laria 07-24) — all the same class: bare prose delivered to a
host-inferred locus the model wasn't attending to. Locus-mode fixes (turn-frozen
pin, announce-on-change, addressed-preference) reduced but cannot eliminate the
class, because the destination lives in host state the model can ignore.
Explicit mode moves the destination INTO the model's own output, adjacent to
the words, where coherence pressure enforces it. Failure inverts from
misdelivery (leak, unrecoverable) to non-delivery (bounce, cheap retry).

## The grammar

A prose segment's FIRST line may carry a routing prefix:

```
>>#channel-name          send to the channel with this label
>>@person                send to the DM with this person
>>discord:guild:id       send by exact channel id (always unambiguous)
>>skip_reply             do not send; text stays in context only (mirrors the skip_reply tool)
```

- Body may start on the same line (`>>#ops deploy done`) or the next.
- **Sticky within the turn:** the first resolved target applies to later
  unprefixed segments of the SAME turn. Cross-turn, nothing is implicit.
- **Continuation modifier:** ` !` immediately after the target
  (`>>#ops !` / `>>skip_reply !`) requests an immediate re-wake after this turn
  ends, instead of the default pause-until-next-event. Gives prose the same
  "keep going" ability tool turns have — wanted for robotics-like loops where
  an end-of-turn pause is undesirable.
- `{{unsent}}` anywhere in the body is replaced at delivery with the
  retained undelivered text (see below), enabling verbatim resend without retyping.

## The bounce (unprefixed prose)

Unprefixed prose with no sticky target is **never delivered**. It is retained
per-agent (latest-wins) and a system notice is appended telling the
agent how to resend: `>>#channel {{unsent}}`. The notice requests inference so
the resend can happen immediately — capped at 2 consecutive bounce-wakes per
agent (then notices append without waking, breaking any loop).

## What explicit mode retires (for that agent)

- The turn-frozen locus, announce-on-change notices, and all locus-capture
  policy (addressed-preference, ambient tiers) — no locus exists.
- Explicit-send prose suppression (`turnSilenced`): redundant, since
  unprefixed prose bounces and prefixed prose is deliberate.
- The entire "which event may move the agent's voice" question.

Explicit send tools (`send_message` etc.) are unchanged. Channel lifecycle
invariants (send-opens-channel, subscribed⇒open) are unchanged — a `>>` send
into a closed channel opens it, with the usual `[channels]` notice.

## Teaching the grammar (system role only)

The grammar is appended to the agent's SYSTEM prompt at construction
(`EXPLICIT_PROSE_GRAMMAR`). Mode switches append only a one-line durable
notice pointing at it (persisted per agent, so reboots never re-notice).
This split is load-bearing, not stylistic: the 2026-07-24 Fable ablation
showed the full grammar as a user-role message draws a deterministic
`reasoning_extraction` refusal ("instruct the assistant to redirect/withhold
output" is injection-shaped from the user role), while the identical text in
the system role — and short event-style bounce notices from the user role —
pass cleanly. Symmetric: switching back to locus mode announces that plain
text auto-routes again.

## KV / wire notes

Assistant messages keep the prefix and `{{unsent}}` token verbatim in the
window (KV-stable); substitution and prefix-stripping happen only on the
outbound wire at the delivery boundary. Membrane, chronicle, and MCPL servers
are untouched: this is an af parser + fkm recipe flag + system-prompt/primer
convention.

## Recipe

```jsonc
"agent": { "proseRouting": "explicit" }   // default: "locus"
```
