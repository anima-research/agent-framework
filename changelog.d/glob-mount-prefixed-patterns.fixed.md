- `workspace--glob` finds files from a mount-prefixed pattern, such as
  `notes/diary/2026-10-13.md` or `project/src/**/*.ts`, as every other
  workspace path is written and as its own results are returned. The pattern
  was matched only against paths relative to the mount (or to `path`), so a
  mount-prefixed one answered "no matches" for files that were there. When a
  pattern's first segment names a mount, its rest is now also matched within
  that mount. Every pattern is still matched relative to each mount (or to
  `path`) as well, so `notes/*.md` still finds `project/notes/todo.md` beside
  the `notes` mount's own files.
  `workspace--grep`'s `glob` filter takes a mount-prefixed pattern the same
  way. In both, a `**/` now matches zero or more directories, as in other glob
  tools, so `project/src/**/*.ts` also finds `project/src/main.ts` and
  `**/*.md` also finds the `.md` files at a mount's root; it used to need at
  least one directory there.
