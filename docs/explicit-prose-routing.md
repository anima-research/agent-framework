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
- **Sticky within the turn:** the latest resolved target applies to later
  unprefixed segments of the SAME turn, including those a later stream of it
  writes, such as a framework retry's, a budget restart's or the compile a
  provider-capacity hold defers the turn to. A round kept private (one that
  calls `skip_reply`, or has a same-round private think) sets no target.
  Cross-turn, nothing is implicit.
- **Continuation modifier:** ` !` immediately after the target
  (`>>#ops !` / `>>skip_reply !`) requests an immediate re-wake after this turn
  ends, instead of the default pause-until-next-event. Gives prose the same
  "keep going" ability tool turns have — wanted for robotics-like loops where
  an end-of-turn pause is undesirable.
- `{{unsent}}` anywhere in the body is replaced at delivery with the
  latest bounced text, held as a draft (see below), enabling verbatim resend
  without retyping.

## The bounce (unprefixed prose)

Unprefixed prose with no sticky target is **never delivered**. It is held as a
draft (src/prose-drafts.ts) — never published except by the agent's own
resend — and a system notice naming the draft tells
the agent how to resend: `>>#channel {{unsent}}`, or the `drafts` tool by id.
The notice requests inference so the resend can happen immediately — capped at
2 consecutive bounce-wakes per agent (then notices append without waking,
breaking any loop).

`{{unsent}}` means the latest bounce while that draft is open (latest-wins, as
the clipboard it replaced was), and `>>skip_reply {{unsent}}` dismisses it.
Earlier bounces stay in the agent's drafts, by id, until resent, dismissed or
let go (an agent's 100 newest drafts are always kept, and an older one for 7
days after anything last happened to it); drafts survive restarts and branch
moves, and a delivery through `{{unsent}}` is recorded on the draft like any
resend.

When the latest bounce may already have been posted (an attempt's outcome is
unknown), or is being sent or queued in a resend right now, what happens
depends on the route:
- **Delivery** (`>>#channel … {{unsent}} …`): nothing is sent. The agent is
  told. While the bounce is being sent or queued, it is told to wait for that
  result; once the bounce may already have been posted, it can resend it with
  the `drafts` tool's `confirmDuplicate`, though that could post it twice.
  The envelope's own words are held as a new bounce draft, with `{{unsent}}`
  written out and the risk carried, so that draft too can be resent only
  with `confirmDuplicate`. A bare `{{unsent}}` holds nothing new: its words
  already are the bounce.
- **Hold** (an envelope that bounces, or one an explicit send held back): the
  bounce's words are copied into the new draft with `{{unsent}}` written out,
  and the draft carries the same risk (`inheritedRisk`), so it reads
  unconfirmed until a confirmed delivery.

## What explicit mode retires (for that agent)

- The turn-frozen locus, announce-on-change notices, and all locus-capture
  policy (addressed-preference, ambient tiers) — no locus exists.
- Explicit-send prose suppression (`turnSilenced`): redundant, since
  unprefixed prose bounces and prefixed prose is deliberate.
- The entire "which event may move the agent's voice" question.

Explicit send tools (`send_message` etc.) are unchanged. Channel lifecycle
invariants (send-opens-channel, subscribed⇒open) are unchanged — a `>>` send
into a closed channel opens it, with the usual `[channels]` notice.

## Teaching the grammar (teach-by-bounce)

The grammar is never injected into context. The mode switch appends one short
durable notice (persisted per agent, so reboots never re-notice); the first
undelivered text produces a bounce notice carrying the exact resend syntax —
the model learns by doing, and the knowledge accretes into its own history.
When the agent's `allowedTools` permits `prose_help`, the full reference is
available on demand through that tool. Its result is model-requested content. The system prompt is never touched: those
bytes belong to the recipe, and the deepest KV prefix must not vary with
framework code.

Why this shape is load-bearing (2026-07-24 Fable ablation): the full grammar
as a user-role message draws a deterministic `reasoning_extraction` refusal
("instruct the assistant to redirect/withhold output" is injection-shaped from
the user role), while short event-style notices pass cleanly. Symmetric:
switching back to locus mode announces that plain text auto-routes again.

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
