- **`WorkspaceModule.readFileFromDisk(mountPath, { maxBytes })`** — a
  workspace-owned filesystem read for peer modules that enforces the mount
  boundary on disk, not just on the path string (#129). Honors the mount's
  `followSymlinks` policy (default: refuse), requires the canonical target to
  stay beneath the canonical mount root when symlinks are allowed (so an
  intermediate symlinked directory or a sibling-prefix root cannot escape), and
  performs a bounded prefix read when `maxBytes` is set, reporting `truncated`
  alongside the full `size`, `mtimeMs` and canonical `realPath`. Refusals throw
  the exported `WorkspaceReadError` with a `code` distinguishing unknown mount,
  lexical traversal, unavailable mount, missing file, directory, policy-denied
  symlink, outside-mount target and file-changed-during-read.
  `resolveAbsolutePath()` is now documented as lexical-only and deprecated for
  direct reads; `read_image` shares the same containment core with its error
  wording unchanged.
