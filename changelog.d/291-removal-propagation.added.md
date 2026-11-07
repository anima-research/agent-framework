- `rollbackToMessage`'s result, and `previewSurgeryMarks` for a rollback, carry `returnedToArrivals` on a presented
  window (#291): the rows after the target in the agent's window that the cut keeps in the record. They leave the
  window; the agent's own rows among them enter it again at the surgery's release, and the others wait outside it
  until the agent's next turn start, which presents them after what its window holds then, so for them the operator's
  cut is what the window holds until the agent speaks again. Both also carry `keptInWindowAfterTarget`: the rows after
  the target that one write presented together with it (such as two messages that entered at the turn's end), which
  stay in the window after the target, since a branch cut can't separate them from it. Neither set is removed or
  marked. `SurgeryMarksPreview.neverPresented` counts the messages a rollback or suppression would remove that no live
  agent is shown: no window holds them, or only windows whose view leaves them out (a row a tune-out holds, another
  agent's stored context injection); one that may be in a window that couldn't be read isn't counted, and is logged.
  All three are set only on a presented window; the operator log records the first two, and the host command's
  message-granular undo answers them too.
- `ModuleContext.windowStatusOf(id, { forAgent })`: where a stored row stands with an agent's window, as
  context-manager's `WindowStatus` (`'in'`, `'out'`, `'undone'`, `'absent'`), for the delivery agent or a named,
  registered one. `ModuleContext.observes(observer, observed)`: whether one agent reads another's own rows through an
  observe edge. `ModuleContext.viewKeeps(row, { forAgent })`: whether an agent's view keeps a stored row, so its
  requests carry it while its window holds it (`windowStatusOf` can read `'in'` for a row a resident's view leaves
  out). `ModuleContext.agentNameOf(contextManager)`: the live agent whose context a context manager is. All optional,
  offered by the framework's module contexts.
- With the framework's window lookup, the history tools' `extract`, `search` and `semantic_search` mark each row the
  calling agent isn't shown (#291) (the delivery agent, for a call no agent made): `window: 'not-shown'` (never
  presented to it, in a slot it doesn't read, or held by its window and left out by its view) or `window: 'undone'`
  (taken out by an undo or a refusal rewind). Their descriptions say so in one more sentence, and `overview`'s says
  when its summaries' text is left out, so the tool block changes and the first request after the upgrade misses the
  prompt cache. `stats` and `overview`'s counts stay aggregates over the record. Without the lookup (an earlier
  framework's context, or a host's own) every tool and answer is as it was.
- `PresentationRetractReason`, the reasons `presentation:retracted` gives: `hide`, `suppress`, `coalescer`, `module`,
  `resume`, `rewind`, `shed`, `boot` and `elsewhere` (rows stamped for other agents, taken out of an agent's window
  when it is taken on or rebased).
