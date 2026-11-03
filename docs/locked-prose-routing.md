# Locked prose routing (`proseRouting: "locked"`)

Locked routing sends a resident's plain speech (text written without a send
tool) to one destination the resident chose, on every turn, and lets nothing
move it automatically.

```jsonc
"agent": { "proseRouting": "locked", "proseLock": "#lounge" }  // proseLock is optional
```

## What moves the lock, and what doesn't

Only the resident's own `prose_locus` call moves it. These don't:

- the channel of the message that woke the turn;
- an addressed message mid-turn (a mention, reply or DM), under either
  `speech.locus` rule, and a follow-up in a channel the turn sent into;
- a heartbeat: a heartbeat's turn speaks into the lock like any other;
- `channel_open`. Its result says where plain speech still goes;
- an all-except `tune_out`, or the latest inbound message.

When someone addresses the resident mid-turn from another channel, the same
`[routing]` notice that `speech.locus: "delivery"` uses rides the injection
batch: who, from where, and that plain speech still lands in the lock, so
reaching them takes an explicit send. Messages heard at a boundary that can't
tell them (over budget, or without a live stream) are told at the turn's next
start. A turn isn't told at its start that its waking message came from
elsewhere. The resident chose the lock, and every turn's `[delivered]`
receipt names where its speech went.

## `prose_locus`

Offered only to a locked agent (and only where its `allowedTools` permit it).

| Call | Effect |
| --- | --- |
| `prose_locus {}` (or `to: null`) | Reports where plain speech goes now. |
| `prose_locus { to: "#channel" }`, `"@person"`, a channel id | Points plain speech there. The target resolves the way a `>>` target does: inside a turn, a name one of the turn's own channels answers to means that channel; an ambiguous or unknown name is refused with candidates, and moves nothing. |
| `prose_locus { to: "drafts" }` | Holds plain speech as drafts: posted nowhere unless the resident resends them with the `drafts` tool. |

A move is recorded in `framework/state` (`proseLocks`) before it applies, so a
failed write moves nothing. It applies to the calling turn's later rounds and
to every later turn, across restarts. What the resident wrote in the same
round as the call goes where speech went before it: a round's routing is
decided from the locus that round had. A call made outside the resident's turn
(a puppet's, or a host's `executeToolCall`) moves the lock later turns start
from, and leaves a turn already under way where it is.

## Drafts

A turn locked to drafts, or with no destination yet, holds its plain speech
as drafts (`no-destination`). Holding is what the resident asked for, so
there's no draft notice for each round. The turn's `[delivered]` receipt
names the drafts, and they resend or dismiss like any others. Such a turn has
no channel: a send tool called with no channel has no default to fall back
to, and a `sleep` posts no announcement.

## The starting destination

A resident that hasn't chosen yet speaks where its recipe's `proseLock`
points: `"#channel"`, `"@person"`, a channel id or `"drafts"`, resolved at
each turn's start the way a `>>` target is. A channel its server hasn't
registered yet resolves once it has; until then that turn's plain speech is
held as drafts, and the operator log says why. With no `proseLock`, plain
speech is held as drafts until the resident chooses. Once the resident has
chosen, its choice outranks the recipe's. A stored choice that can't be read
holds speech as drafts rather than fall back to the recipe's.

## Unchanged from locus mode

- An explicit send silences the plain speech its round and later rounds aim
  where the send may have posted, holding it as drafts.
- `skip_reply`, a same-round private `think` and the turn-end `[delivered]`
  receipt work as in locus mode.
- There's no `>>` or `>>>` envelope grammar. An envelope is plain text here.

## Who doesn't lock

A locked agent's conversation fork routes to its home channel, and its
ephemeral runs return their speech to their caller, as in locus mode: neither
has a lock of its own, and neither is offered `prose_locus`.

## What the resident is told

- Entering locked mode appends one short `[prose-routing]` notice, once,
  naming where plain speech goes and that `prose_locus` moves it.
- A `prose_locus` move is answered in its own tool result, and nothing else
  announces it.
- When the lock changes some other way, the next turn starts with the usual
  `[routing]` announce-on-change notice. That happens when a recipe
  `proseLock` channel registers after turns that held speech as drafts, or
  when a stored lock can't be read for a turn.
- Every turn that wrote plain speech ends with its `[delivered]` receipt.

Leaving locked mode keeps the stored lock, which applies again if the agent
returns to locked mode.
