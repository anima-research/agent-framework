# Pending changelog fragments

One file per change, so concurrent branches never conflict the way shared
`CHANGELOG.md` edits do. At release time `npm version` folds every fragment
here into the new version section of `CHANGELOG.md` and deletes it.

**Name:** `<slug>.<breaking|added|changed|fixed>.md`, as a flat file directly
in this directory. The slug just has to be unique among pending fragments and
filesystem-safe: the PR number works, and so does the branch name with `/`
replaced by `-` (`115-tune-out.added.md`, `fix-locus-routing.fixed.md`). The
release script refuses subdirectories and any other stray file here, so a
misplaced entry fails the release loudly instead of being left out.

**Content:** one or more markdown bullets, exactly as they should appear in
`CHANGELOG.md`. Continuation lines indent two spaces (nested bullets are
fine); headings and horizontal rules are refused even when indented, since a
heading inside a fragment would corrupt the section structure:

```markdown
- `tune_out` diverts a channel's traffic to a subconscious summarizer
  instead of unsubscribing (#77). Continuation lines indent two spaces.
```

Breaking fragments open by naming who needs to act:
`- **Module authors:** …`.

See [CONTRIBUTING.md](../CONTRIBUTING.md#changelog) for what needs an entry.
