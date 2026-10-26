# Continuing until skip_reply (`autoContinue`)

`autoContinue` is a default-off per-agent setting. With it on, a turn the
model ends itself is followed by another turn straight away, instead of the
usual pause until the next event (a message, a heartbeat, a timer). The agent
keeps going until it says it's done: by calling `skip_reply`, or another tool
that ends the turn, such as `sleep`.

`true` turns it on with a cap of 3 continuations in a row:

```json
{ "agent": { "autoContinue": true } }
```

An object sets the cap, a whole number from 1 to 20:

```json
{ "agent": { "autoContinue": { "maxConsecutive": 5 } } }
```

## What it costs

An agent that answers and simply ends its turn gets at least one more full
inference per answer: the continuation it then ends with `skip_reply`. One
that never calls `skip_reply` gets up to `maxConsecutive` more, and in locus
and hybrid modes each of those turns' prose is published. Each continuation's
rows also stay in the window. Keep the cap low, and expect roughly one extra
inference per turn for an agent that does skip.

## Which turns continue

A turn continues when the model ended it (stop reason `end_turn` or
`stop_sequence`), whether its last response is prose or empty, unless:

- a tool ended it: `skip_reply`, `sleep`, any endTurn tool;
- its last prose envelope is a skip: `>>skip_reply` in explicit mode, or a
  `>>>skip_reply` in hybrid mode whose hold is still standing at the end;
- it asked for a ` !` continuation (`>>#ops !`), which runs instead, with no
  row, and counts toward nothing;
- its closing prose bounced (explicit or hybrid mode): the bounce, with the
  bounce-wake cap, is that turn's answer, and continuing once the cap is
  spent would restart the loop the cap breaks;
- it was a silent heartbeat tick;
- it ended with a refusal, a `max_tokens` cut-off, or the stall guard's
  `no_progress` / `round_limit`;
- the agent is an ephemeral run (a subagent) or a conversation fork, or the
  framework is stopping;
- the agent has no way to stop that it's offered: in locus or disabled mode,
  `skip_reply` must be offered (a channel registry provides it) and allowed
  (`allowedTools`). Explicit and hybrid agents can always end with a skip
  envelope.

A turn that sent with a send tool and then closed in prose (held, not sent,
because a send that turn may already have posted where they were going) still
continues: its closing words can't be told from unfinished work. The row tells
the agent those words were held.

## What the agent reads

As the continuation's turn starts, after every gate that could still stop it,
a short system row joins the window as the newest of the turn's inputs (after
the last turn's `[delivered]` receipt, outside explicit mode, whose envelopes
acknowledge themselves and write no receipt):

```
[continue] lena, another turn starts now. If you're done, call skip_reply; anything you write without it is sent as usual.
```

It names the agent, since residents read one shared message slot. For the
same reason it is never written while another resident's turn is alive: the
continuation waits for that turn to end, as a clock row does. When the
last turn's closing words were held because a send that turn may already have
posted where they were going, it adds `Your closing words last turn were held,
not sent: a send that turn may already have posted where they were going.` The
last continuation of a run adds `This is the last
continuation in a row: after this turn you wait for the next event either
way.` An agent that can't call `skip_reply` is told to end with a
`>>skip_reply` (explicit) or `>>>skip_reply` (hybrid) envelope instead.

The wording is neutral on purpose: a row that reads as a lapse ("you ended
without…") or as a budget ("2 of 3, one more left") invites an apology or a
"done here" reply, which in locus and hybrid modes would itself be published.
It is short and event-shaped: longer instruction blocks about output, sent as
user-role messages, have tripped provider classifiers.

The row is never written for a turn that doesn't run: a wake the inference
policy drops, or that a quiesce drops, writes none and gives back its count;
a row that can't be stored gives back its count, and withdraws a turn the
continuation alone caused. A continuation's wake queued beside a turn's
budget restart, or released beside a tool-result guard's retry by a provider
hold, waits for that turn, then writes its row as its own turn starts. A
write that throws after its row landed counts as written. It is appended
before the turn compiles and never retracted, so the prompt-cache prefix
stays stable.

## The next turn

The continuation's wake has source `framework` and reason `auto-continue`. In
locus and hybrid modes it carries the turn's locus, so the next turn's plain
prose lands in the same locus rather than the process-global last-inbound
channel. (A hybrid `>>>` destination is a pin within a turn: the next turn
starts with none, as any turn does.) A turn whose wake named a channel that
resolves to none (it had no channel and took no fallback) passes that channel
on, so its continuation takes no fallback either.

A message that arrives meanwhile joins the same turn, as any batched wake
does, and then that turn is the message's: its channel outranks the
continuation's (ambient included, though the continuation's wake was queued
later), no `[continue]` row is written, and the run's count starts again. A
silent heartbeat tick batched with a continuation is not a cause of its own:
the continuation keeps its row and its count.

A host quiesce drops a queued continuation: at resume, possibly hours later,
"another turn starts now" would no longer be true. The next real event wakes
the agent as usual.

## The cap

At most `maxConsecutive` continuations run in a row (default 3). The count
starts again when a turn starts with a cause of its own (anything but a
framework wake or a silent heartbeat tick), and when a tool ends a turn. A
silent tick batched with a continuation neither restarts the run nor takes
its row, so a resident whose ticks come faster than its turns still reaches
the cap.
