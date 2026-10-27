- **Hosts and operators whose workspace mounts set `ignore` or `include`:**
  both lists now read one grammar, the gitignore forms a config copied from
  a `.gitignore` uses, and a pattern of any other form stops the module from
  being built, with an error naming the mount, the pattern and why. Each form
  covers the files git's reading of it covers, with three differences: names
  compare exactly, as git's do with `core.ignorecase` off (its default folds
  case on macOS and Windows); a `?` matches one character where git's
  matches one byte, so the two differ on names outside ASCII; and on a mount
  that follows links, a link to a directory counts as a directory, where git
  reads every link as a file. Before,
  `ignore` read only a name, `dir/**` and `*.ext`, and any other pattern
  matched only an entry of exactly that name, or nothing, without a word.

  **Who needs to act:** a config holding a pattern the lists now refuse,
  which loaded before:
  - in either list, a leading `!` or `#`, a trailing space, or a `\`.
    `include` read each of these as part of a name (a `\` only where `/` is
    the platform's separator);
  - in `ignore`, also a `[`, `**` anywhere but as the first segment before
    one name or in a trailing `/**`, or an empty, `.` or `..` segment, which
    `include` already refused, apart from the `[`. `include` still reads a
    `[` as itself, so `[id].tsx` names that file.

  Remove such a pattern, or write it in a form the lists read. A `?` matches
  any one character, so it can stand for a `[` or `\` in a name: in `ignore`,
  `?id].tsx` covers `[id].tsx`, and any other name that differs from it only
  in that character. An `ignore` that isn't a list, such as `null`, is
  refused too; `[]` still ignores nothing.

  **What `ignore` now covers that it didn't:**
  - `dir/`: a directory named `dir` at any depth, with what lies beneath it,
    and no file of that name;
  - `/dir` and `a/b`: that path from the mount's root;
  - `**/name`: `name` at any depth, as `name` alone, and `**/name/**` as
    `name/`;
  - `*` and `?` within a name, such as `npm-debug.log*`, `.env*` or
    `te?t.txt`. Before, a `*` anywhere but a leading `*.`, and every `?`,
    matched only itself.

  **What `ignore` no longer covers:** a file named like a `dir/**` pattern's
  directory. `node_modules/**` covers the root's `node_modules` directory
  and what lies beneath it, and no longer a file named `node_modules`.

  **`include`** reads the same forms for files: `fixtures/` covers every
  file beneath a directory named `fixtures`, at any depth, `/gate.json` only
  the root's `gate.json`, and `src/*.ts` the `.ts` files directly in the
  root's `src`. Each was refused before. A `?` in an include pattern, which
  it read as itself, now matches any one character, so such a pattern covers
  more files than before.
