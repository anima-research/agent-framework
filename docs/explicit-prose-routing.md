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
>>discord:guild:id       send by exact channel id
>>srv:discord:guild:id   the same channel id on the MCPL server `srv`, where more than one server registers it
>>skip_reply             do not send; text stays in context only (mirrors the skip_reply tool)
```

A channel id is unique only within one MCPL server's connection, so two
servers can register the same one. A target that more than one channel
answers to is refused, with its candidates named so each can be told apart:
by its id, or, where its id is shared, in the server-qualified form, or, where
that is shared too (ids hold colons), by its id and server, which no target
takes. The server-qualified form is looked up among the registered pairs,
never split at a colon. Within a turn, an id that one of the turn's own
channels has, a channel the turn has been in (the channel of the message it
answers, and any a mid-turn message or channel_open moved it to), means that
channel, on its server, even where another server registers the id, and is
refused once that server no longer registers it: the words go only where the
message came from, never through another server that has the id. Where two of
the turn's channels have that id, on two servers, it means neither, and is
refused with each named. The channel tools, tune_out and the subconscious's
cancel_tuneout, speak_in_channel and deliver_summary read a name the turn gives
them the same way.

- Body may start on the same line (`>>#ops deploy done`) or the next.
- **Sticky within the turn:** the latest resolved target applies to later
  unprefixed segments of the SAME turn, including those a later stream of it
  writes, such as a framework retry's, a budget restart's or the compile a
  provider-capacity hold defers the turn to. A round kept private (one that
  calls `skip_reply`, or has a same-round private think) sets no target. A
  target its server declared inbound-only is refused and clears the turn's
  target, so later unprefixed segments bounce until a new `>>` target.
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

In a round that calls `drafts`, with any action, what the round would bounce
or hold for lack of a destination is held as a draft with no notice instead of
bouncing: a later `drafts` listing shows it, and the turn's receipt or, in
`explicit` mode, which writes none, a later turn's catch-up notice names it,
but nothing offers it for resend while the turn runs. In a `locus` or `hybrid`
turn a send has silenced, the round's plain speech stays in the agent's
context instead, counted in the receipt as kept private, and what a `>>>`
envelope addressed is held with no notice. A round that also makes a send of
its own, other than a `drafts` resend, holds its prose and offers it as any
send's round does. Without this, an agent that writes a line beside each call
would resend its own narration round after round, inside one turn, where the
bounce-wake cap doesn't reach (#701). Outside a silenced turn, what the round
would deliver is delivered, an unprefixed line to the turn's sticky target
included, and a refused target, a malformed envelope or a failed delivery
still bounces. Only the framework's own `drafts` tool makes such a round, not
a module's or server's tool of that bare name. An envelope beside a script
whose code mentions `drafts` waits for the script. In XML tool mode, where a
turn's prose is routed once at its end with no notice mid-turn, a drafts round
is routed as any other: its unprefixed line still bounces, and the bounce-wake
cap ends a cycle of `drafts` resends after two wakes, counted from the last
turn with a cause of its own or the last delivered envelope.

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

Send tools (`send_message` etc.) and channel lifecycle work the same in
explicit mode as in the other modes. A `>>` send into a closed channel opens
it, with the usual `[channels]` notice, unless the agent closed or declined
that channel itself or a module closed it, or this host doesn't direct its
server's lifecycle: then it publishes there and leaves the channel as it is.
Explicit mode has no `[delivered]` receipt, so where a turn's `>>` speech
stayed in a channel the agent closed or declined, the turn ends with a
`[closed channel]` line that says so, as a send tool's answer does, unless the
agent has turned that note off (`agent_settings`' `closed_channel_note`).
Speech still being delivered when the turn ends gets the line once it has been
delivered. If another turn is under way by then, the line waits for that turn's
next tool call, where that turn is shown it, or for its end.

## Teaching the grammar (teach-by-bounce)

The grammar is never injected into context. The mode switch appends one short
durable notice (persisted per agent, so reboots never re-notice); the first
undelivered text produces a bounce notice carrying the exact resend syntax —
the model learns by doing, and the knowledge accretes into its own history.
The one place a first undelivered line doesn't bounce is a round that calls
`drafts` (above): there the line is held with no notice, and the agent is
told of it by a later `drafts` listing and a later turn's catch-up notice,
so a line written there teaches no syntax.
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
