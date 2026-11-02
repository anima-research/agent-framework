- `switchBranch(name, { requester?, note? })` writes the switch to the operator log as a `checkout`, with its source
  and target branches, or with its error when it is refused or fails (#291); the API server's `branch.switch` logs
  one with requester `{ via: 'api' }`. Before, a branch switch was the one branch move the operator log didn't
  record.
- `PresentationOccasion` gains `'rebase'`: the store's branch moved under a live agent, and its window was written
  down on the new branch, or couldn't be (`presentation:presented` and `presentation:failed`).
