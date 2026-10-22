- The workspace's `delete`, `edit` and `edit_many`, and its `readBinary`
  method, no longer answer "File not found" for a path the workspace doesn't
  hold when the check of disk before them decided nothing, because the
  selected branch kept changing while it ran. Each now says that disk
  couldn't be checked, with that reason, and to make the same call again.
  Before, they answered "File not found" even when disk held the file
  (#552). `readBinary` also gives `delete`'s answer for every other path the
  workspace doesn't hold, such as one whose disk copy couldn't be read, where
  it said "File not found" whatever the reason.
