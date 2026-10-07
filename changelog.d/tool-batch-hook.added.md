- **`Module.onToolBatchComplete(agentName)`**: called once an agent's tool batch completes,
  when the round's last pending result arrives and before it is provided. It therefore runs
  before anything that continues the turn: re-inference, stream resume or the end of the turn.
  The framework awaits every module's hook in parallel, each bounded at 30 s and fail-open; a
  hook that throws (before returning its promise or after) or times out is traced as
  `module:batch_hook_failed` and the round goes on.
  The agent's state is checked again afterwards, so a turn cancelled during the hook has the
  result dropped (traced as `tool:result_dropped`). Script-inner tool calls don't trigger it.
- Workspace: `materialize` accepts `applyDeletions`, `WorkspaceConfig` accepts
  `agentActionScanDeadlineMs` (default 20000), and `workspace:deleted` events carry `conflicts`
  when a disk deletion met a newer workspace edit.
