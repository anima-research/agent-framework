- `AgentFramework.switchBranch(name)` switches the store to an existing
  branch, starts the delivery of the Discord awareness marks the move
  changes, re-materializes the config mount, and then resolves. It doesn't
  wait for Discord, as the surgeries don't. If the mount fails, it rejects
  with the branch already moved. The branch moves under every agent
  sharing the store, so, as for `rollbackToMessage()`, every agent must be
  idle: during a live turn it refuses with `OperatorActionError`
  (`agent-busy`), and no turn starts until it's done. Once `stop()` has
  begun it refuses, and `stop()` waits for one already running.
  - The API server's branch switch used to run these steps itself, on the
    store, and now calls `switchBranch()`. So it refuses during a live turn
    instead of moving the branch beneath it. Its current branch follows the
    store from the moment it moves, and clients hear of a move even when a
    later step fails, but not of a refused switch. A branch create with
    `switchTo` creates the branch first, so during a live turn it creates
    it and answers the switch's refusal.
