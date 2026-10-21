- The workspace's `delete` writes the deletion's tombstone before it removes
  the file's entry, and puts the tombstone back if the removal doesn't land
  (#553). A store that failed between the two had left the entry gone with
  no tombstone, so the deletion read as a file the branch doesn't have: no
  materialize deleted the disk copy, and a second `delete` found nothing to
  delete. Now a deletion whose tombstone can't be written is refused before
  anything is removed, and can be sent again. A tombstone beside an entry
  that's still there is no longer counted by `status` as a pending deletion,
  or a reason for a bare `materialize` to take its path up, which forced
  could write the entry over a newer disk copy.
