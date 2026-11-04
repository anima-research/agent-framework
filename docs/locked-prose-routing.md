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
| `prose_locus { to: "#channel" }`, `"@person"`, a channel id | Points plain speech there. The target resolves the way a `>>` target does: inside a turn, an id one of the turn's own channels has means that channel; a name that is ambiguous or matches nothing is refused, naming its candidates where there are any, and moves nothing. Pointing it where the turn already speaks moves and holds nothing; if that destination was only the recipe's default, it's recorded as the resident's own choice, so a later change to the recipe's `proseLock` no longer moves it. |
| `prose_locus { to: "drafts" }` | Holds plain speech as drafts: posted nowhere unless the resident resends them with the `drafts` tool. |

A move is recorded in `framework/state` (`proseLocks`) before it applies, so a
failed write moves nothing. It applies to the calling turn's later rounds and
to every later turn, across restarts once the store has synced (the move syncs
it; a sync that fails is logged, and the write stays in the store's log). What the resident wrote in the same
round as the call goes where speech went before it: a round's routing is
decided from the locus that round had.

A call made outside the resident's turn (a puppet's, or a host's
`executeToolCall`) moves the lock later turns start from, and leaves a turn
already under way where it is. Its result says so. The resident may never read
that result, so the move isn't counted as told: the next turn starts with a
`[routing]` notice of where its speech goes.

On a turn whose prose is routed only when it ends (membrane's XML tool path,
which has no per-round content), the words written before a move and after it
can't be told apart. A move during such a turn holds the rest of the turn's
plain speech as drafts, every later stream of it included (a budget restart's,
a retry's), sending none of it to either destination, and the move's result
says so. Later turns speak at the new destination.

## Drafts

A turn locked to drafts, or with no destination yet, holds its plain speech
as drafts (`no-destination`). Holding is what the resident asked for, so
there's no draft notice for each round. The turn's `[delivered]` receipt
names the drafts, and they resend or dismiss like any others. Such a turn has
no outgoing channel: `channel_publish` called with no channel has no default
to fall back to, and a `sleep` posts no announcement. A module's own send
tool that keeps a reply context of its own, such as the in-process Discord
module's `discord--reply`, isn't governed by the lock (see below). It can still answer an
incoming message: servers are told which message woke it, and a refusal
reaction marks that one.

## The starting destination

A resident that hasn't chosen yet speaks where its recipe's `proseLock`
points: `"#channel"`, `"@person"`, a channel id or `"drafts"`, resolved at
each turn's start the way a `>>` target is, except that no turn's own channels
take precedence: an id two servers register is ambiguous here, and holds
speech as drafts until the recipe names one. A channel its server hasn't
registered yet resolves once it has; until then that turn's plain speech is
held as drafts, and the operator log says why. With no `proseLock`, plain
speech is held as drafts until the resident chooses. Once the resident has
chosen, its choice outranks the recipe's. A stored choice that can't be
read, or whose stored entry names no destination, holds speech as drafts
rather than fall back to the recipe's.

## Module speech handlers

Locked routing governs plain speech routed through the channel registry
(MCPL channels). A module that handles a turn's final speech itself
(`onAgentSpeech`), such as the in-process Discord module in
`src/modules/discord`, receives it in locked mode as it does in every other
mode, `disabled` and `explicit` included. Hosts that rely on locked routing
should reach channels through MCPL servers rather than such a module.

## Unchanged from locus mode

- An explicit send silences the plain speech its round and later rounds aim
  where the send may have posted, holding it as drafts.
- `skip_reply`, a same-round private `think` and the turn-end `[delivered]`
  receipt work as in locus mode.
- There's no `>>` or `>>>` envelope grammar. An envelope is plain text here.

## Who doesn't lock

Neither a locked agent's conversation fork nor its ephemeral run has a lock
of its own, and neither is offered `prose_locus`. A fork routes to its home
channel, as in locus mode. A run routes as `disabled`: it publishes no plain
speech, as a `disabled` resident's run doesn't, since in locus mode its
narration between tool calls would post to the channel inferred for its turn.
connectome-host launches a locked resident's subagents as `disabled` for the
same reason.

## What the resident is told

- Entering locked mode appends one short `[prose-routing]` notice, once,
  naming where plain speech goes and that `prose_locus` moves it.
- A `prose_locus` move is answered in its own tool result, and the next turn
  starts with the usual `[routing]` announce-on-change notice of where its
  speech lands. So a rewind or a branch move that takes the exchange out of
  the window still leaves the resident told.
- The same notice follows a move made from outside the turn, unless the next
  turn is the agent's first in locked mode, whose primer names the lock
  instead, and a recipe `proseLock` channel that registers after turns that
  held speech as drafts.
- Notices name `prose_locus`, and the `drafts` tool, only where the
  resident's `allowedTools` let it call them.
- A turn whose plain speech was delivered or held ends with its `[delivered]`
  receipt. One whose delivery failed gets the failure marker, and a receipt
  only for a place a module named.

Leaving locked mode keeps the stored lock, which applies again if the agent
returns to locked mode.
