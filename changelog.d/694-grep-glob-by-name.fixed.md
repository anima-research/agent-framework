- `workspace--grep`'s `glob` filter matches a file's name at any depth when
  it holds no `/`, as ripgrep's `--glob` does, so `*.ts` or `*.{ts,tsx}`
  finds those files wherever they lie in what's searched (#694). It was
  tested only against the path from the mount's root, so with no `path` it
  let through only the files at a mount's root, and with a `path` below the
  root, a directory or a file, it let through none, answering "no matches"
  for files that were there. The path is still tried too, so every file a
  filter let through before still passes. A filter with a `/` is still
  matched from the mount's root, whatever the `path`, or read mount-prefixed
  in the mount its first segment names.
- Where a `path` and the directory a `workspace--grep` filter with a `/`
  names before its first wildcard or brace lie apart, neither holding the
  other, as `path: "project/src"` and `glob: "components/*.tsx"` do, the
  grep is now refused, saying how the filter is read, where it answered
  "no matches". `workspace--glob` is refused the same way where its
  pattern is read mount-prefixed, as `path: "project/src"` and
  `pattern: "project/lib/*.ts"` are, unless the `path` lies in another
  mount's directory, which is said to be that mount's, as grep says it.
  Where the `path` isn't a file, the refusal also names the filter or
  pattern that reaches beneath it, mount-prefixed
  (`project/src/components/*.tsx`), unless it has an empty, `.` or `..`
  segment.
