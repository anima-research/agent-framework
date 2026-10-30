- `rollbackToMessage`'s result, and `previewSurgeryMarks` for a rollback, carry `returnedToArrivals` on a presented
  window (#291): the rows after the target in the agent's window that the cut keeps in the record. They leave the
  window as arrived and not presented, and wait outside it until the agent's next turn start, which presents them
  after what its window holds then: the surgery's release, a resume, a turn's end and a row stored for the agent
  while it is idle don't bring them back, so the operator's cut is what the agent's window holds until it speaks
  again. A restart before then presents them at its pass at rest. Both also carry `keptInWindowAfterTarget`: the
  rows after the target that one write presented together with it (a batch, such as two messages that arrived while
  the agent was busy and entered at its turn's end), which stay in the window after the target, since a branch cut
  can't separate them from it. Neither is removed or marked. `SurgeryMarksPreview.neverPresented` counts the
  messages a rollback or suppression would remove that no live agent's window holds. All three are set only on a
  presented window, and the operator log records the first two; the host command's message-granular undo answers
  `returnedToArrivals` and `keptInWindowAfterTarget` too.
- `ModuleContext.windowStatusOf(id, { forAgent })`: where a stored row stands with an agent's window, as
  context-manager's `WindowStatus` (`'in'`, `'out'`, `'undone'`, `'absent'`), for the delivery agent or a named one,
  which must be registered. `ModuleContext.observes(observer, observed)`: whether one agent reads another's own rows
  through an observe edge. `ModuleContext.viewKeeps(row, { forAgent })`: whether an agent's view keeps a stored row,
  so its requests carry it while its window holds it (a resident's view leaves out held traffic and the other
  agents' stored context injections, which `windowStatusOf`, read before the view, can still read `'in'`).
  `ModuleContext.agentNameOf(contextManager)`: the live agent whose context a context manager is. All optional,
  offered by the framework's module contexts.
- The history tools say which rows the caller isn't being shown (#291). With the framework's window lookup, each
  `extract`, `search` and `semantic_search` entry for a row the caller isn't shown carries `window: 'not-shown'`
  (never presented to it, in a slot it doesn't read, or held by its window and left out by its view) or `window:
  'undone'` (taken out by an undo or a refusal rewind), relative to the calling agent, or to the delivery agent for a
  call no agent made. Their descriptions say so in one more sentence, and `overview`'s says when its summaries' text
  is left out. `stats` stays an aggregate over the record, as do `overview`'s counts. Without the lookup (a context
  of an earlier framework, or a host's own) every tool and every answer is as it was.
- `PresentationRetractReason`, the reasons `presentation:retracted` gives: `hide`, `suppress`, `coalescer`, `module`,
  `resume`, `rewind`, `shed`, `boot` and `elsewhere` (rows stamped for other agents, taken out of an agent's window
  when it is taken on or rebased).
