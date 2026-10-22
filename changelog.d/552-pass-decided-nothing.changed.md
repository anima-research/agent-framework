- The workspace's `edit` and `edit_many` refuse a file the workspace holds
  when the check of disk before them decided nothing, because the selected
  branch kept changing while it ran. They store nothing, and say so, with
  that reason and to make the same call again. Before, they applied to the
  workspace's copy without a word, so where disk had changed they edited
  text disk had moved past and left the path in conflict, and they committed
  on whichever branch was selected when the check gave up. Where disk's copy
  couldn't be read, an `edit` or `edit_many` still applies to the
  workspace's copy and says so.
