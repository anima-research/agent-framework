- A turn whose call failed into a provider hold (a provider's stated wait, a
  host's `providerHold`, or an organization-acceleration cooldown), or whose
  compile a conversation agent's recorded wait held with nothing sent, now
  counts as alive until the hold releases its retry, and so does a turn
  whose error-policy retry a provider wait holds at the last admission
  boundary before it starts (a conversation agent's own compression can
  record one during the policy's delay). The host used to report it
  `drained`, and a rollback, suppression or branch switch went through,
  after which the retry ran on the rewound store, answering again on history
  rewound under it. Now:
  - `getHostModeStatus()` lists the agent in `activeTurnAgents` and counts it
    in `activeTurns`, and `drained` reads `false`;
  - a rollback, suppression or branch switch refuses as `agent-busy`, naming
    the hold, its end (or `until released`) and its reason, and how to go on
    sooner: a quiesce with `abandon: true`, or, where a stated wait holds the
    turn, `release-provider-wait`;
  - a quiesce waits for the turn, up to its `timeoutMs` (at least 1 s),
    where it used to report drained at once, and lets the retry start when
    the hold ends and finish; wakes that arrive meanwhile park, as for any
    turn alive;
  - a quiesce with `abandon: true` (once its wait for the drain runs out, or
    at once on a host already quiesced), `stop()`, the inference policy, the
    agent's removal or a conversation agent's disposal drops the retry, and
    the turn ends with one `inference:aborted`, as a turn whose continuation
    is dropped does;
  - a closing conversation agent isn't disposed while a hold keeps its
    turn's retry, nor while a continuation of its turn (a budget restart or
    a tool-result guard's retry) waits in a hold, a park or a scheduler pass;
  - once `stop()` has closed admission, a failure reported then installs no
    hold, so no retry outlives the stop, and the turn ends with an
    `inference:aborted` after its `inference:failed`, as a retry a stop
    cancels does;
  - a puppet tool call is refused while the retry waits, as during any live
    turn, naming the hold and how to go on sooner;
  - `abortInference()` ends the turn, and a turn whose budget restart or
    tool-result guard's retry waits held or parked, where it reported
    nothing to stop and the turn ran once the hold ended: one
    `inference:aborted` with the stop's reason, and it returns `true`. Wakes
    the hold keeps beside the retry still run, and a hold of such wakes
    alone still has nothing to stop. From a listener of a failed stream's
    `inference:failed` it reports `false`, as before (a turn's start that
    fails still takes a listener's stop at its own check): every failure
    site now reports `inference:failed` before a hold takes the turn's
    retry, where a stream that throws, and the hold a conversation agent's
    compile meets, used to hold it first.

  A wake a hold keeps at admission, with no turn of its own begun, keeps no
  turn alive, as before.
