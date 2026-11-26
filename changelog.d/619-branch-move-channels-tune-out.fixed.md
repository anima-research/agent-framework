- A branch move is `rollbackToMessage`, `switchBranch`, or a suppression's
  fork. After a branch move, the host now reads each channel's lifecycle
  decision from the new branch (#619). The host also reads each tune-out
  from the new branch, as after a restart. Before, the host kept the old
  branch's state until a restart. So after a rollback to before a tune-out,
  that channel's messages were still held.
  - After the move, each tune-out of the new branch runs with its timers, as
    after a restart. It ends at once if its end time passed, or if its wake
    budget is spent. The same tune-out on both branches keeps its running
    timers and any pending wake. On a host with no reader, the move releases
    the new branch's tune-outs, as a restart does.
  - Each registered channel gets its label and its default decision from the
    new branch, as at registration. The legacy recipe policy's migration
    runs on the new branch too. If the subscription policy opens a channel,
    the agent gets a notice, as at registration.
  - Some servers let the host open and close their channels. For such a
    server, the host asks it to open or close each channel that doesn't
    match the new branch. The move doesn't wait for the answer.
  - A message can arrive while the move is under way. Whether the host holds
    it now depends on the tune-outs of the new branch.
  - If the move can't read the channel logs, the channels and tune-outs stay
    as they were. The move goes on, and the host logs the error.
  - After a move, the subconscious now reads its standing notes from the new
    branch.
