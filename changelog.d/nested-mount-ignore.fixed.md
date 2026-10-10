- A mount's ignore patterns now apply to its watcher, and a mount that
  contains another mount leaves it out at any depth.
  - The watcher handed the patterns to chokidar as strings, which chokidar
    takes as exact paths, so on a watched mount (`watch` defaults to
    `'always'`) every change under an ignored path, `node_modules` included,
    was synced. The watcher now applies the walk's own rule: a path is passed
    over when it or a directory above it matches. Chokidar also no longer
    descends into ignored directories. Files the old watcher already took in
    from under an ignored path stay tracked and stop updating. Each bare sync
    lists them under `skipped` ("disk could not be checked: ignored by the
    mount"), with their directory under `incomplete`, for as long as disk
    can't show them gone. For a file the pattern matches itself, such as
    `app.log` under `*.log`, that's until the file is removed. For a file
    inside an ignored directory, such as `node_modules/`, it's until that
    directory is removed, since the walk doesn't look inside it. Deleting
    such a file from the workspace doesn't end the listing either, and there
    is no way yet to stop tracking a file and keep it on disk.
  - The overlap guard said it was "auto-ignoring" the inner mount's directory,
    but it added the bare relative path, which the walk reads only as an
    entry name: a mount nested two or more levels deep (`a/b`) was still
    synced by the outer mount, and a mount nested one level deep (`sub`) also
    hid every other directory named `sub`. It now adds `a/b/**`, which
    matches that path and what is under it, and nothing else. An inner mount
    in a directory whose name starts with `..` (such as `..cache`) is now
    recognized as nested (agent-framework #280).
