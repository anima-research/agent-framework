- `workspace--glob` finds files from a mount-prefixed pattern, such as
  `notes/diary/2026-10-13.md` or `project/src/**/*.ts`, as every other
  workspace path is written and as its own results are returned. The pattern
  was matched only against paths relative to the mount (or to `path`), so a
  mount-prefixed one answered "no matches" for files that were there. When a
  pattern's first segment names a mount, that mount now matches its rest from
  the mount's root, in place of the pattern as written. Every other mount
  still matches the pattern relative to the mount (or to `path`), so
  `notes/*.md` still finds `project/notes/todo.md` beside the `notes` mount's
  own files. In a mount holding a directory named like itself, this narrows
  what a pattern written relative to the mount finds (see Breaking).
  `workspace--grep`'s `glob` filter takes a mount-prefixed pattern the same
  way. In both, a `**/` at the start of a path segment now matches zero or
  more directories, as in other glob tools, so `project/src/**/*.ts` also finds `project/src/main.ts` and
  `**/*.md` also finds the `.md` files at a mount's root; it used to need at
  least one directory there. After a brace group whose alternatives each end a
  directory, a `**/` matches zero or more directories, and so does a `**`
  that ends an alternative before a `/`, so `{src/,lib/}**/*.ts` and
  `{src/**,lib}/*.ts` find `src/main.ts`, as `src/**/*.ts` does. `glob`'s description and its `pattern`
  parameter's description changed, and so did `grep`'s `glob` parameter's
  description, so the first request after the upgrade that carries the
  workspace's tools misses the prompt cache from its tool block on.
