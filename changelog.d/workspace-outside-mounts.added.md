- The workspace's `read`, `read_image` and `write` can take a file outside
  every mount. `WorkspaceConfig.outsideMounts: 'read-only'` lets `read` and
  `read_image` take an absolute path, or one that starts with `~/`, and
  `'read-write'` lets `write` take one too. Left out, every path is a
  mount's, and nothing changes. Such a file is read and written as the
  host's own user, through no mount's boundary, include or symlink rule, up
  to 5 MB. Nothing of it is stored or watched, and an undo leaves a write to
  it on disk. An absolute path that lies in a mount's directory is that
  mount's file, by that mount's rules, so a read-only mount stays read-only.
  Where the setting is on, the descriptions of those tools say what they
  take, and so does the framework's own `read_image`, so setting it changes
  what the agent's tool list says.
