- Workspace tools check nested-mount boundaries before and inside each mount's turn, and disk operations check again before their effects. A mount's ignore patterns now apply to its watcher.
  - The watcher handed the patterns to chokidar as strings, which chokidar
    takes as exact paths, so on a watched mount (`watch` defaults to
    `'always'`) every change under an ignored path, `node_modules` included,
    was synced. The watcher now applies the walk's own rule: a path is passed
    over when it or a directory above it matches. Chokidar also no longer
    descends into ignored directories.
  - Files the old watcher already took in from under an ignored path stay
    tracked, and the watcher and a sync without a path no longer update them.
    A sync that names such a path still takes disk's copy, and says the
    mount ignores it. Each sync without a path lists them under `skipped`
    ("disk could not be checked: ignored by the mount"). It also lists, under
    `incomplete`, the ignored entry that hides them: the file itself for a
    pattern it matches, such as `app.log` under `*.log`, or the ignored
    directory above it, such as `node_modules`. That lasts as long as disk
    can't show them gone. For a file the pattern matches itself, that's until
    the file is removed. For a file inside an ignored directory, it's until
    that directory is removed, since the walk doesn't look inside it. On a
    mount without `autoMaterialize`, deleting such a file from the workspace
    doesn't end the listing either. On one with it, the delete removes the
    disk copy, which ends it. There is no way yet to stop tracking a file and
    keep it on disk, except for nested paths and outer links into nested mounts (below).
  - A pattern with a trailing slash (`node_modules/`, `build/cache/`) or a
    slash inside it (`build/cache`) matched nothing. Now a trailing slash is
    dropped, so `node_modules/` reads as `node_modules` (gitignore would
    match only a directory so named; here a file so named is passed over
    too). A pattern with a slash is a path from the mount root, with
    everything under it.
  - The overlap guard said it was "auto-ignoring" the inner mount's
    directory, but it added the bare relative path, which the walk reads only
    as an entry name. A mount nested two or more levels deep (`a/b`) was
    still synced by the outer mount, and a mount nested one level deep
    (`sub`) also hid every other directory named `sub`. It now adds `a/b/**`,
    which matches that path from the outer mount's root and what is under it,
    and nothing else. A sync without a path counts the inner mount's
    directory under `passedOver`, as it counts any ignored directory.
  - Nesting is read from the mounts' canonical roots. A mount configured
    through a symlink, or spelled in another case on a case-insensitive
    filesystem, is still nested, and the rule is spelled as disk spells it.
    An inner mount in a directory whose name starts with `..` (such as
    `..cache`) is now recognized as nested.
    A root that doesn't exist yet is its configured path, resolved as
    `path.resolve` resolves it, then read as the filesystem will read it:
    through the directories that exist, with a link on the way that leads
    to nothing yet read as what it names. A `..` in such a link's target
    counts after any link before it in that target, as the filesystem
    counts it. So a mount configured at `via/child`, where `via` links into
    another mount, or at a link to that mount's `child`, is nested there
    before `child` is made. Each pass and each tool call also reads
    nesting afresh, so a mount that comes to lie inside another after
    startup (its root made later, or a symlinked parent created) is treated
    like one found at startup: the outer mount's tools refuse its paths before anything
    reaches the outer mount's workspace, and the checks below refuse it
    however it is reached.
  - The outer mount's tools refuse a path inside a nested mount, naming the
    mount to use: `outer/a/b/x.txt` is "inside mount "inner", which is nested
    in "outer" at a/b/: use "inner/x.txt"". That covers `read`, `write`,
    `edit`, `ls`, `glob`, `grep`, and a `sync` or `materialize` that names the
    path. Before, a named sync took the inner mount's files into the outer
    one. `write`, `edit` and `writeBinary` also read where the
    path leads on disk at their checks, so existing case variants and links inside the mount, dangling or not, are checked too. A link changed after the store check can leave an outer draft at a now-nested path; materialize refuses the later disk write.
    - `delete` can stop tracking an old outer copy at a nested path. It removes the exact stored key and its intent and agreement; the disk entry, if any, stays untouched.
    - A `materialize` without a path skips writes of such copies, with a note saying that disk was left untouched and the copy can be deleted here to stop tracking it. An already-pending deletion at a nested path is untracked once instead of receiving that advice again.
  - Every check that a canonical path lies inside the mount, when reading,
    walking or writing, also refuses one inside a nested mount. So a symlink
    that a `followSymlinks` mount follows into a nested mount reaches nothing
    there, and a write through it is refused.
    `readFileFromDisk` and `read_image` refuse a file there, naming the
    mount to use, and so does `readBinaryFromDisk`. That reader now keeps the
    boundary the other readers keep, checked against the file it opens: it
    still follows a symlink that stays within the mount, and it now refuses
    one that leads outside the mount ("Symlink escape detected"), which it
    used to read. Under a size limit, a file the boundary refuses is refused
    as such, and its size isn't reported.
  - Every workspace tool reads a path in one spelling: `a/./b`, `a//b` and
    `a/b/` are `a/b`.
  - A mount whose configured path has `.` or `..` segments is read the way
    `path.resolve` reads it, by nesting and by every operation alike. Before,
    its own sync did that, while its tools refused its files as path
    traversal, and so did registering a generated file in it, such as an
    agent's tool catalogue. Where a link came before a `..`, the disk readers
    checked its files against a different root, the one reached by following
    that link first, and refused them. Its watcher reported none of its
    changes.
  - (agent-framework #280)

- Nested refusals name the innermost mount, even when several mounts contain the path. A lexical refusal includes its directory, such as `"outer/a/b/x.txt" is inside mount "inner", which is nested in "outer" at a/b/: use "inner/x.txt"`. A path reached through disk spelling omits that location clause: `"outer/via/x.txt" is inside mount "inner", which is nested in "outer": use "inner/x.txt"`. The public tool wrapper prefixes thrown lexical errors with `Error:`.
- Path spelling and comparison are separate. Existing components use disk's spelling, and unmade components keep their written spelling, including in generated ignore rules. On macOS and Windows, a nesting comparison ignores case only when one of the compared components was unmade. This uses platform defaults without a filesystem probe: non-default case-sensitive volumes can receive conservative refusals, while case-insensitive filesystems elsewhere are outside the missing-component rule.
- After classification, nested deletion uses the outer store rather than listing or statting the inner directory. It removes only an exact supplied key or an exact derived key contained in the identified nested mount. A differently cased tracked key is named in a refusal so the caller can request it exactly; case folding never chooses a key to remove. This also prevents a path through an inner link back out from forgetting an outer-owned entry.
- An outer link into a nested mount is untracked rather than assigned a disk deletion the outer mount cannot perform. Its stored copy, intent, and disk agreement are removed, and the result says the file or link on disk, if any, was left untouched. The disk unlink boundary itself is unchanged. Path-less materialize also clears legacy pending deletions at nested paths or for such links, independently of `force` and `applyDeletions`. It reports cleanup once, including if remaining physical writes are blocked by branch divergence, and leaves no pending action to report on the next call.
- Disk readers check containment and nested boundaries before answering a target's kind, including a directory reached through a link. They also check the opened file's path and identity.
- Classification still makes synchronous realpath, lstat, and readlink calls on the event loop for roots and target paths; untracking adds no post-classification directory lookup. Materialize resolves the nested roots once for its selection and shares that snapshot across selected paths. Disk effects obtain their own fresh view. A mounted filesystem that does not answer can still block the synchronous reads, as tracked in #311.
