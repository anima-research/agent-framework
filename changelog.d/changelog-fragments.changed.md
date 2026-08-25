- Changelog entries now land as per-change fragment files in `changelog.d/`
  (`<slug>.<breaking|added|changed|fixed>.md`), folded into the version
  section at release time — concurrent PRs no longer conflict in
  `CHANGELOG.md`. Editing `## Unreleased` directly still works and is merged
  at the same point.
