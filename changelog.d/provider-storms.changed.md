- A retryable overloaded error (HTTP 529) on an agent's turn call now starts
  a capacity storm on that model, held for every agent calling it, where the
  error policy used to retry it in the turn and then end the turn. Each
  agent on the model, residents, the subconscious and conversation agents
  alike, is held until its own point in the storm's current step, and a
  turn arriving meanwhile is held without a call. The steps follow
  membrane's retry decision (`@animalabs/membrane/retry`) for the overloaded
  class, on membrane's own overloaded settings: 10 s, doubling to at most 5
  minutes, each agent released at its own draw of the class's equal jitter,
  in the step's second half, so the agents' tries are spread through it
  rather than sent together. A 529 from a call sent in the current step
  starts the next one, and the others' 529s join it. The model's first
  answer to a turn call ends the storm and releases every agent it holds. A
  storm nothing steps lapses 5 minutes after the later of its step's end and
  the last call sent into it, so a 529 after that starts a storm of its own
  from the first step. A turn the storm holds waits through it rather than
  ending, so an error policy of the host's own no longer sees a turn call's
  529, except one from a call sent before a storm armed and ended (the
  model has answered since, or the storm lapsed) with no newer storm
  standing, which arms nothing and is taken as before
  storms; once released, its call's other failures are the error policy's,
  as before. A 529 that states a wait is recorded as any stated wait is, and
  the agent is held until the later of the two. A held turn tries again as
  a new start of its open turn, as a turn a 429's hold took did: it
  assembles what the coalescer holds pending for it, such as the batch of a
  wake merged into it, and counts its tool calls and takes its undo
  checkpoint from there. An ephemeral run sleeps the storm in its turn,
  before its first call too, up to 10 minutes of storm in all, and then
  ends, saying so; a run asleep in a storm tries again within its turn,
  keeping its tool count and its checkpoint, as membrane's retries did; a turn the storm defers before its call
  writes no inference-log record, since no call is made. A compression
  call's 529 starts no storm, and a storm doesn't hold compression: the
  context strategy paces its own calls. A storm is kept in memory, so after
  a restart, or `stop()`, the first turn tries at once.
  `release-provider-wait` (and `releaseProviderWait`) also takes the named
  agent out of a storm on the model that holds it: it tries at once, unless
  a host hold or the organization's acceleration hold also binds it, listed
  with `release: 'storm'`. `healthSnapshot()` lists storms as
  `providerStorms`, with each one's model, start, step, next release (the
  earliest end among the holds on the model, stated waits included, and the
  runs asleep in it; null while none has one), the agents held on the model
  or asleep in the storm, and the provider's words, and a 529 that joins a
  storm standing over an hour raises one `provider-storm` ops alert for it.
- The default error policy is now membrane's retry decision on the turn
  path's settings, with the same tries as before: a rate-limited or other
  retryable failure is tried 4 times in all, retried at 1, 2 and 4 s. Where
  the policy decides (an ephemeral run's retryable failure; a resident's or
  conversation agent's stated wait is held as a provider wait, as before), a
  provider's stated wait now only lengthens a retry's wait, where it
  replaced it: a 429 stating 200 ms is retried after 1 s on its first retry,
  where it was retried after 200 ms, and a stated wait of 0 or a negative
  one waits the backoff, where it was retried at once (an ephemeral run's
  NaN one still ends it, as a wait it can't sleep to). A stated wait that no
  one can wait out (Infinity, from a `retry-after` too long to be a number)
  ends the turn, where the policy waited it until `stop()`; it reaches the
  policy only when no provider-wait hold took it.
- The turn calls and the compression calls the framework makes now ask
  membrane for no retries (`retry: false`): their failures are the
  framework's, held by a storm or a provider wait, or retried by the error
  policy or the context strategy's lane, which then see each one. In 0.26.0
  membrane 0.7 also sent each up to several times inside the call, retrying
  it: a turn call's 529 7 times, its 429 5 times and another retryable
  failure 3 times inside each of the error policy's 4 tries, and a
  compression call the same way inside each call the lane resends. Now each
  try is sent once. An ephemeral run's
  context manager asks for none too, taking no admission. A transition
  summary that a context manager the framework made generates
  (`resetHeadWindow()` with no text) is sent once too: its failure comes
  back to the caller, who can call again. An `Agent` driven without the
  framework keeps membrane's own retries, since the framework asks for none
  only for the turns it drives (`ActivationRequestOptions.membraneRetries`),
  and `Agent.runInference` and the inference router keep them too. A call's
  `retry: false` wins over the retry config a host builds its `Membrane`
  with, so under a host that sets one, as connectome-host 0.13.0 does
  (`hostMembraneRetry`, with a recipe's `agent.retry` laid over it), the
  framework's turn and compression calls no longer use it: the storm hold,
  provider waits, the error policy and the context strategy's lane pace them
  instead. The host's config still governs every call the framework doesn't
  mark, the host's own calls included.
- A provider hold, a capacity storm's included, whose held wakes are all
  withdrawn by coalescing (a later occurrence of their subject cancels them)
  now releases without starting a turn: it starts nothing, as a hold whose
  continuations were dropped does. It used to start a turn in their place,
  with nothing asking for one. A hold a failed turn began keeps that turn's
  retry as before.
- `abortInference()` now stops a turn a provider hold keeps for its retry (a
  capacity storm's hold, a stated wait's or a host's, after the turn's call
  failed), and a turn whose continuation is on its way: the retry and the
  continuation are taken, one `inference:aborted` carries the stop's reason,
  and it returns `true`. Wakes that arrived during the hold stay, and start a
  turn when it ends. It used to return `false`, and the turn ran when the
  hold ended. A host sees that turn's `inference:failed` and then the stop's
  `inference:aborted`. A hold of fresh wakes alone keeps no turn, and a stop
  of it still returns `false`.
- A turn whose call failed is alive until its retry starts, wherever the
  retry waits (a provider hold, a storm's included, or the queue its release
  sends it to): `getHostModeStatus()` reads `drained: false`, lists the
  agent among `activeTurnAgents` and doesn't count its retry among
  `gatedRequests`, `puppetToolCall()` refuses with the agent `idle+turn-
  alive`, live surgery (`rollbackToMessage`, `suppressMessages`,
  `switchBranch`) refuses as `agent-busy`, naming the hold and how to end
  the turn now, and a quiesce's abandon or `stop()` ends the turn, its retry
  dropped. A wake the scheduler merges with the retry is one of that turn's
  causes, and a stop of the turn takes it too. Under a quiesce the retry is
  let through admission, as a turn's continuation is, so the turn finishes
  when its hold ends. On 0.26.0 such a turn read as drained while a stated
  wait or a host's hold kept its retry, and surgery then went through, the
  retry running on the rewound store.
- A turn whose call fails while `stop()` runs, with a failure a provider
  hold would take (a capacity storm's 529, a stated wait's, a host's hold),
  ends as `stop()` ends a held turn: one `inference:aborted` with
  `shutdown`, with no exhaustion marker and no failure streak. A hold was
  installed then, which kept the turn and the hold's timer past the stop. A
  stopping framework arms and steps no storm.
- A turn's continuation (a budget restart, a tool-result guard's retry, tool
  results) held at admission by a provider hold, a storm's included, now
  closes the event gate's window while it waits, and its start takes the
  window again. Every agent's gate events used to wait behind it until the
  hold ended. A gate delivery to the held agent is stored, and its
  continuation's compile reads it.
