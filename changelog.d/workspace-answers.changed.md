- The workspace's tools word a call they refuse, or one that fails, one way:
  what didn't happen, what the agent gave, then the way on, or that calling
  again won't change it and who can. A path naming no mount lists the mounts
  and offers the closest, a leading `/` is named, a read-only mount names
  the mounts that take writes, a size refusal gives the size and the limit,
  `read_image` says what about the file stops it, and in these answers an
  errno reaches an agent in plain words rather than Node's message with the
  host's path, a store's I/O failure included. An error no handler threw on
  purpose names the call and its path, and for a call that changes files
  says whether the change was stored, that the files already held it, or
  that this isn't known; where the call leaves the store awaiting its
  reopening, the answer says only a restart ends that, a stored change's
  included. `ls` of a missing path or of a file, and `materialize` or `sync`
  of a path held nowhere, add a `note` saying so.
- **Hosts calling `readFileFromDisk`, `readBinary`, `readBinaryFromDisk` or
  `writeBinary`:** a refusal's code is unchanged. Its words have changed for
  a path that names no mount, climbs out of its mount or holds a lone
  surrogate; for the read-only and size refusals; for `readBinary`'s
  answers, but for a file neither the workspace nor disk has on a mount the
  workspace stores, which keeps `readFileFromDisk`'s words; for an errno
  `readFileFromDisk` gives from a link check, now in plain words; and for
  the reason after `Mount unavailable: <mount>:` while the store awaits
  reopening. An error `readFileFromDisk` meets while parsing a path that
  isn't a refusal is thrown as it is, not as a `traversal` refusal. Code
  that matches on those words needs updating.
