- `rollbackToMessage`'s result, and `previewSurgeryMarks` for a rollback, carry `returnedToArrivals` on a presented
  window (#291): the rows after the target in the agent's window that the cut keeps in the record. They leave the
  window as arrived and not presented, and enter it again at the agent's next presentation point, after the target
  (at once, for an idle agent, when the surgery releases the store). `SurgeryMarksPreview.neverPresented` counts the
  messages a rollback or suppression would remove that no live agent's window holds. Both are set only on a presented
  window; the host command's message-granular undo answers `returnedToArrivals` too.
- `ModuleContext.windowStatusOf(id, { forAgent })`: where a stored row stands with an agent's window, as
  context-manager's `WindowStatus` (`'in'`, `'out'`, `'undone'`, `'absent'`), for the delivery agent or a named one,
  which must be registered. `ModuleContext.observes(observer, observed)`: whether one agent reads another's own rows
  through an observe edge. Both optional, offered by the framework's module contexts.
- The history tools say which rows the caller isn't being shown (#291). With the framework's window lookup, each
  `extract`, `search` and `semantic_search` entry for a row not in the caller's window carries `window:
  'not-shown'` (never presented to it, or in a slot it doesn't read) or `window: 'undone'` (taken out by an undo or a
  refusal rewind), relative to the calling agent, or to the delivery agent for a call no agent made. Their
  descriptions say so in one more sentence. `stats` and `overview` stay aggregates over the record. Without the
  lookup (a context of an earlier framework, or a host's own) every tool and every answer is as it was.
- `PresentationRetractReason`, the reasons `presentation:retracted` gives: `hide`, `suppress`, `coalescer`, `module`,
  `resume`, `rewind`, `shed` and `boot`.
