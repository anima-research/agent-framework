- **`workspace--status` names a mount whose root a sync can't use**, where
  it said nothing while `sync` and `materialize` skipped every file of the
  mount. Asked for that mount, its entry carries `root`: `unavailable`, the
  words `sync` lists under `incomplete` for the mount's root; `recorded`,
  the root identity disk last agreed under (`dev`, `ino`, and `born` where
  one was recorded), or null, and left out where the store's record of disk
  can't be read back; and `now`, the identity of the directory at the root's
  path, or null where no directory could be checked there. That covers
  nothing at the path, something there that isn't a directory, another
  directory, and the recorded inode on another device. A root this process
  can resolve but not list is named by `sync`'s and `ls`'s walk, as before,
  and not by `status`. `canMaterialize` is false wherever that entry's
  `root` has `unavailable`, since `materialize` writes nothing there.
  `status` for one mount checks its root on disk, so a root on a network
  mount that doesn't answer holds that call, as it holds that mount's
  `sync`, `ls` and reads. `status` for every mount reads no disk: an entry
  whose mount's last pass couldn't use the root carries `root` with
  `unavailable`, the words that pass listed, and `lastPassAt`, when it ran.
  An entry with no `root` is one whose last pass used the root, or a mount
  with no pass since start: one watched `always` runs a pass when its
  watcher is ready, and others when a call does.
- **A directory made again where the mount root was removed, born after it,
  is another directory** where the root's filesystem keeps a birth time
  fixed: on Linux, ext2/3/4, xfs, btrfs, tmpfs, f2fs or zfs, as `statfs`
  names it. It passed as the root when it had the old one's inode, as ext4
  gives it, and is now refused in the replaced-root words. On any other
  filesystem, overlayfs included, and off Linux, the rule before this change
  decides: the same device and inode, or on another device the same birth
  time below the second: overlayfs gives a directory it copies up from a
  lower layer a later birth time under the same device and inode. A birth
  time earlier than the recorded one still passes on its device. A birth
  time equal to the ctime counts as none, so it is neither recorded nor
  compared: Node reports one where `statx` is unavailable, such as under a
  seccomp filter that blocks it, and a directory nothing has changed since
  it was made has one too. So where either side has no birth time, a
  directory with the old device and inode still passes, as before: anywhere
  `statx` is unavailable; where the record has none, as releases before 0.28
  left it; and for a directory just made in the root's place until something
  changes in it after the clock's first tick.
- **A mount root with the inode disk last agreed with, on another device
  number, is named as that** where the birth times can't tell the two apart
  (either side has none, as releases before 0.28 recorded roots; or the
  root's is no later than the recorded one, or its filesystem doesn't keep a
  birth time fixed, without both being the same time to below the second):
  "the mount root has the inode disk last agreed with, but another device
  number: a reboot can renumber a volume, and another volume mounted at the
  same place can have a root with the same inode; whoever runs this host can
  say which, and if it is the same directory, a sync of the mount with
  acceptRoot takes it as it is now; if not, they can mount the right
  volume". It was named as an unmounted drive or a replaced directory.
  `status`, `sync`, `ls`, `materialize` and `read` give the new words, and
  so does `readFileFromDisk`'s `Mount unavailable:` message, whose code is
  unchanged.
- **The replaced-root refusal says who can act on it**: "the mount root is
  not the directory disk last agreed with (an unmounted drive, a directory
  moved aside, or a replaced one); whoever runs this host can say which: a
  drive they can reconnect, a directory moved aside they can put back, and a
  replaced directory a sync of the mount with acceptRoot takes as it is
  now", where it ended "reconnect it; if it was replaced on purpose, sync
  the mount with acceptRoot to take it as it is now". Its code and fields
  are unchanged.
