- **Hosts:** a persistent agent's turn that ends exhausted on a transient
  failure (a server error, an overload, a rate limit, a network failure, or a
  timeout membrane marks retryable and not as a deadline it reports as run
  out, such as a 408 or a socket's ETIMEDOUT) is now sent again after 2, 8 and
  32 minutes (agent-framework#838). 0.28.0 sent nothing until another wake
  came, so a message that arrived during a provider outage could go unanswered
  for good. The re-armed trigger is a wake of its own, since the turn it came
  from has ended. It opens where that turn's plain speech was going: its
  locus, where a message mid-turn may have moved it, else its trigger channel.
  Carrying that channel, it ranks as addressed in a merged wake's choice of
  channel, so a newer ambient wake from elsewhere doesn't take it; an
  autoContinue continuation's still yields its channel to any wake's, as it
  does on main; a continuation's, such as a budget restart's, names no author.
  A re-arm that would have to guess a channel isn't sent again: one whose turn
  was woken for a channel id that names no one registered channel and never
  found one, and whose request names none of its own. Until one of its rounds
  has run or had its tool calls cut off, a re-armed turn's failure gets no
  retries from the error policy: on another transient failure the next delay
  follows, until the list runs out, and a failure of any other kind ends the
  re-arming. A wake for the agent while it waits starts its turn at once, with
  the re-armed trigger merged in. That turn is the wake's: the error policy
  retries its failures. A completed turn starts the count again, and so does a
  message said to the agent (not a system message, notice or system change;
  not an edit, reaction or deletion, unless an edit is the first version of a
  message the agent sees; not a message its own view leaves out, such as one a
  tune-out holds from it; and not the agent's own schedule: the heartbeat's
  tick or reminder, a self-wake timer it set, or a script's wake. A notice a
  module or an MCPL server stores as a message counts, and a message in the
  residents' shared slot counts for each resident that reads it), so each such
  message gets its own re-sends, over about 42 minutes after its turn first
  exhausts at the default delays; any other wake leaves the count going on. A
  heartbeat-mcpl server registered under another id stores its ticks as
  ordinary messages, so each of its ticks starts the count again too. A
  re-armed turn's transient failure writes no `[inference-failed]` marker
  unless it got partway, so the agent's context keeps the one the first
  exhaustion wrote; a failure of another kind writes its own. A judge rule's
  judge is told when the re-arm comes, and can make its calls while the agent
  waits. The health snapshot shows the wait under `providerAdmission`, with a
  `cooldownReason` that says the turn is sent again; a re-arm that comes while
  a provider hold is already on the agent waits for that hold instead, under
  its reason, and takes its count all the same. The wait and the count are
  kept in memory, so `stop()` or a restart drops them, and `abortInference()`
  doesn't end the wait. Set `exhaustedTurnRearmMs` to other delays, or to
  `false` to send nothing again. **Unchanged:** ephemeral runs and
  conversation forks, a failure the provider refuses, a compile refused over
  budget, a deadline, whether the host set it or membrane marks one as run out
  (the runtime's or undici's on a sent request, the Anthropic adapter's
  watchdogs, or the Anthropic SDK's timeout, which covers its connect timeout
  too), and a provider's stated wait, which the framework holds as before.
- **Operators:** each re-armed turn's failure counts toward the hard-down
  streak, so the hard-down alert now comes during an outage from a single
  wake, at the third exhaustion, about 10 minutes after the first at the
  default delays, where 0.28.0 needed three wakes. New `[inference-rearm]`
  stderr lines say when each re-send is coming, when it went, and, as "turn
  not re-armed", why none is: a failure that isn't transient once the agent's
  re-arming has begun and neither a turn has completed nor a message been said
  to it since, re-arms that are spent (until a turn completes or a message is
  said to the agent), or a turn that would have to guess a channel. A message
  said to the agent starts its count again, with a line saying so, so a `(1 of
  3)` can follow a `(2 of 3)`. With `exhaustedTurnRearmMs: false` they say
  nothing. A turn that a provider's stated waits, one after another, have held
  for more than an hour now raises the `provider-wait` ops alert, once for
  that run, saying how many waits and how long they span, and pointing to the
  account's rate limit or quota, or the host's load: at its first such hold
  that begins past the hour, or, if none does, when the run ends, if its
  latest wait ran past the hour, measured to the earlier of that wait's end
  and the run's end. A wait released early counts to its release. So the alert
  can come as late as the run's end. The run counts the holds of the turn's
  own failed calls whose stated wait still bound, whether held as a provider
  wait, an acceleration cooldown or a host's hold, from the first of them; it
  ends with the turn, or when one of the turn's rounds runs. 0.28.0 raised the
  alert only for one wait of more than an hour, which it still does, so a turn
  held by a long run of short waits left no alert and no `failures.log`
  record; a run whose wait raised that alert raises no second one. It doesn't
  count toward the hard-down streak.
