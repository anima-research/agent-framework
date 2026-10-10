- A tool result the guard withholds now says where its original is. The
  guard's notice ("Tool result withheld by the guard. The tool has already
  executed.") is followed by the original's place: a workspace file under the
  first writable mount's `tool-results/` (named
  `<date>-withheld-<batch>-<index>-<toolUseId>`, one per result), or, with no
  writable workspace or a failed write, the guard's audit record
  (`framework/tool-result-guard`), for an operator. This holds for every
  withheld settlement: a refusal, an aborted stream, a batch that was never
  submitted, and one whose audit sync failed. The notice still names no
  refusal and no category. The stub is written before any request is compiled,
  including the refusal retry, and before stop closes the store. If the active
  branch changes while the originals are being written, no more are written
  and the stub stays as it was. The direct Agent API's refusal retry is now
  compiled afresh, as the framework's is, so its longer stubs fit the budget.
  Before this, a withheld result left only the notice, so the agent couldn't
  tell what the tool had done (agent-framework #277).
