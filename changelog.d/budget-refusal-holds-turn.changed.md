- **Hosts and operators:** a turn held for its context budget (#304, under
  Fixed) is a turn alive until it runs or ends, as a turn a provider hold
  keeps for its retry is. Before, the refused compile ended the turn within
  seconds.
  - `getHostModeStatus()` reads `drained: false` while it waits and lists the
    agent in `activeTurnAgents`, and wakes that join it count in
    `gatedRequests`. A quiesce waits for it: once the hold releases it, the
    turn starts and finishes, as any turn alive at the quiesce does, while the
    wakes that joined it wait for `resume()`. A hold has no time limit, so a
    quiesce made while a turn is held drains only if the turn ends within the
    quiesce's window: released and finished, or ended by `abortInference()`. A
    quiesce with `abandon: true` ends it, as do `abortInference()`, `stop()`
    and a conversation agent's disposal, each with one `inference:aborted`.
    After an abandon or `abortInference()`, the wakes that joined it go back
    to the queue and run as a turn of their own.
  - The turn's terminal event comes when the held turn ends, however long it
    was held, rather than as an exhaustion within seconds. Wakes that arrive
    while it waits join it: the held list has no bound, and how large a long
    wait makes it hasn't been measured. The refused attempt emits
    `inference:failed`, as an attempt a provider hold keeps does, and then the
    new trace `inference:held`; `inference:hold_ended` follows when the hold
    ends, and the turn's next start emits `inference:started` again. A
    listener of the hold's `context-hold` alert that ends the turn at once
    puts its `inference:aborted` before `inference:held`.
    `healthSnapshot()` gives each agent's `budgetHold` (or null): since when
    it holds, when the hold last saw compression's own work change
    (`compressionChangedAt`: the summaries it has made and whether a call is
    in flight, as the strategy's progress snapshot gives them, or the whole
    snapshot from a strategy whose snapshot doesn't give those; the hold's
    start until then; messages arriving, and changes to settings or pins,
    don't move it for the autobiographical strategy), context-manager's
    description of its pending work now (`pending`, bounded to 2,000
    characters, or null), the held count, and the refusal's type and figures.
  - A held turn raises `context-hold` (under Added) rather than
    `context-refusal`, since it goes on. Before, the refused compile's
    exhaustion raised `context-refusal`; a hold that ends without a fit and
    whose turn's compile is refused again still does. The hold's start
    logs a `[budget-hold]` line, unless an `inference:held` listener has
    already ended it, saying the turn runs once a check finds its context fits
    its budget, followed by context-manager's own description of its pending
    work, and a turn held again after a release logs a line saying so. A
    compression call that fails in a tick the hold drives is reported as one
    that fails in a maintenance pass is, as `context-maintenance-failed` for
    the agent, under maintenance's rule for repeats; a drive that ends without
    a failure counts as a pass without one. The hold's first drive of
    compression logs a `[budget-hold]` line with its tick count unless a call
    fails in it, and a later drive logs one only when it stops early.
- **Agents:** the turn's next start once a check finds its context fits
  stores a note in the agent's history saying why it waited, where the turn
  reads it, as an `afterUser` context injection is stored (while the window is
  held, the compile places it instead): "[budget-hold] Your context didn't fit
  its budget (100,201 tokens against 48,568), so this turn waited 7 min for
  compression to make room." The note goes only where it fits too: where the
  plan's spare covers the note's price, by the strategy's own estimate
  (`estimateTokens`), or where a look at the budget less that price fits,
  a preview or, for a strategy whose preview gives no verdict, a dry compile.
  That dry compile, like the one that finds the fit, leaves out the module
  and MCPL injections a start gathers, since gathering them can run
  inference or call servers (`previewActivation`'s doc). Otherwise, where
  that look fails, and where the strategy gives no estimate or its estimate
  throws, the turn runs without this release's note, and its wait stays in
  `inference:hold_ended`'s trace; a note an earlier release of the same hold
  stored stays in the history. A hold that ends without a fit, because
  compression had nothing left to do or the check failed, stores no note.
  A message that addresses the agent from another channel while its turn is
  held is announced at the released start as having come "while your turn
  waited for compression". A smaller budget stands in for the stored row, so
  the edge of the recent window can differ from the compile's. A placed note doesn't make the picker
  fold deeper, so while the window is held, where only a deeper fold had room
  for the note, the request goes past its budget by up to the note's price,
  out of the reply's reserve; a placed injection can't refuse the compile.
  Before its compile, a released start can also store a clock row that has
  come due, messages deferred for the agent while the turn waited, deferred
  batches, and a module's changed context injection, none of which the check
  sees. Where those tip the compile into a refusal while compression is
  pending, the turn is held again; where compression has nothing left to do,
  the refusal takes the error policy's path, its reason saying that the
  context fit at the check that released it and the compile its start then
  ran didn't.
