- **Hosts and operators whose workspace mounts set `ignore` or `include`:**
  both lists now read one grammar, the gitignore forms a config copied from
  a `.gitignore` uses, each as gitignore reads it, and a pattern of any other
  form stops the module from being built, with an error naming the mount,
  the pattern and why. Before, `ignore` read only a name, `dir/**` and
  `*.ext`, and any other pattern matched only an entry of exactly that name,
  or nothing, without a word.

  **Who needs to act:** a config holding a pattern the lists now refuse,
  which loaded before:
  - in `ignore`, a leading `!` or `#`, a `[`, a trailing space, `**`
    anywhere but as the first segment before one name or in a trailing
    `/**`, or an empty, `.` or `..` segment;
  - in either list, a `\`, which `include` read as part of a name where `/`
    is the platform's separator;
  - in `include`, a `[`, which it read as part of a name, so `[id].tsx` named
    that file.

  Remove such a pattern, or write it in a form the lists read: a `?` stands
  for a `[` or `\` in a name, so `?id].tsx` names `[id].tsx`. An `ignore`
  that isn't a list, such as `null`, is refused too; `[]` still ignores
  nothing.

  **What `ignore` now covers that it didn't:**
  - `dir/`: a directory named `dir` at any depth, with what lies beneath it,
    and no file of that name;
  - `/dir` and `a/b`: that path from the mount's root;
  - `**/name`: `name` at any depth, as `name` alone;
  - `*` and `?` within a name, such as `npm-debug.log*`, `.env*` or
    `te?t.txt`. Before, a `*` anywhere but a leading `*.`, and every `?`,
    matched only itself.

  **What `ignore` no longer covers:** a file named like a `dir/**` pattern's
  directory. `node_modules/**` covers the root's `node_modules` directory
  and what lies beneath it, and no longer a file named `node_modules`.

  **`include`** reads the same forms for files: `fixtures/` covers every
  file beneath a directory named `fixtures`, at any depth, `/gate.json` only
  the root's `gate.json`, and `src/*.ts` the `.ts` files directly in the
  root's `src`. Each was refused before.
