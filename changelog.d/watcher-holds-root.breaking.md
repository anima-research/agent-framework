- **Operators:** on Linux, a workspace mount's watcher holds the mount's root
  directory open while it watches it, so it can tell whether that directory
  has been removed whatever has since been made at its path.
  - **What stops working:** `umount` of the file system under a watched
    root fails with "target is busy" while the host watches it. Stop the host
    first, or use `umount -l`, which still detaches it.
  - **What gets slower:** a root removed, or replaced by a rename over it, is
    found at the watcher's next root poll (`watchRootPollMs`, 2 s by default)
    rather than at once.
  - **Unchanged:** where the watcher can't hold the root (macOS, Windows, or
    on Linux a root it can't open as a directory), it holds nothing open, as
    before. On WSL 2, Windows programs can still rename or remove a watched
    folder on a Windows drive.
