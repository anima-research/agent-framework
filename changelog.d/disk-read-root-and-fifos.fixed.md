- **The workspace's disk reads refuse a mount root that isn't the mount's
  directory.** `readFileFromDisk`, `readBinaryFromDisk` and `read_image` read
  whatever was at a mount's root path, so a root renamed away and replaced by
  a link to another directory, or by another directory, was read as the
  mount. Once the workspace has recorded the root's identity, with the first
  evidence it gathers there, such a root is refused as `mount_unavailable`,
  in the words a sync uses for it, until a sync with `acceptRoot` takes it.
  A root that is gone, or is a file, is `mount_unavailable` too, with errno
  ENOENT or ENOTDIR, where it was "File not found". A root that changes
  during a read, until the file has been opened and checked, gets the same
  code and errno as one changed before the read.
- **`readBinaryFromDisk`'s `maxBytes` bounds the read itself.** A file that
  grows past it after the read's size check is refused as "File too large",
  having loaded at most `maxBytes` bytes and one more, where it was read
  whole.
- **Two opens no longer wait on a FIFO.** A directory's sync after a push
  opened the directory blocking, so a FIFO put at its path held the sync
  until something opened it for writing. The tool presentation file's read
  did the same, synchronously, holding the whole process. Each now opens
  without waiting, and refuses what isn't a directory or a regular file.
