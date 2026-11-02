# Contributing to agent-framework

agent-framework is part of the Connectome ecosystem
([membrane](https://github.com/antra-tess/membrane),
[context-manager](https://github.com/anima-research/context-manager),
[chronicle](https://github.com/anima-research/chronicle),
[connectome-host](https://github.com/anima-research/connectome-host)). These
conventions describe how work actually lands here — they codify existing
practice rather than aspiration. When in doubt, recent merged PRs are the best
reference.

Everything below applies to every change however it lands — external PR or
maintainer direct push — and to human and AI authors identically. There is
no separate rulebook for either.

## How changes land

- External contributions come as PRs against `main`, from a fork or a repo
  branch. Maintainers also land small changes directly on `main`; don't be
  surprised by history that never saw a PR.
- Branch names: `feat/<kebab-case>`, `fix/<kebab-case>`, `docs/`, `chore/`.
  Including the issue number is welcome (`fix/43-scope-module-injections`).
- PRs are merged as **true merge commits** — no squash, no rebase-merge.
  Because nothing is squashed, keep individual commits coherent.
- To update a stale branch, rebase onto `main` or merge `main` in; both are
  accepted.
- Stacked PRs and cross-repo companion PRs are fine, but **declare them** in
  the body with merge-order guidance ("stacked on #7 — review that first";
  "safe to merge in either order because …"). This repo sits directly on
  membrane, context-manager and chronicle and is consumed by
  connectome-host, so companion PRs are common; say which side is safe to
  land first and what happens if only one does.

## What a PR should contain

Body shape (the PR template mirrors this): **Problem / Changes / Tests**,
plus, when applicable, **Not verified**, **Out of scope**, and
**Companion PRs**. The conventions that matter:

- **Evidence over assertion.** State the test baseline numerically:
  "`npm test`: N pass / M fail, failure count identical to `main` baseline."
  A claim like "all tests pass" without the count will be re-verified anyway,
  so save the reviewer the trip.
- **Say what you did NOT verify.** An honest "not exercised end-to-end
  against a live provider" is respected; a silent gap that review uncovers
  is not.
- **Tests accompany behavior changes.** Review scrutinizes test substance,
  not mere presence — a test that can't fail on the unfixed code will be
  called out.
- **Changelog fragment** in `changelog.d/` for anything behavior-affecting
  (see below).

Conventional-commit-style titles (`feat(modules): …`, `fix(streaming): …`) are
the house default; plain descriptive titles are accepted.

## Review process — what to expect

- Review arrives as **ordinary PR comments**, not GitHub review approvals —
  the comment thread is the gate. Reviews are frequently AI-generated and
  explicitly labeled as such, with a severity verdict and itemized findings.
- The reviewer will typically **run your branch** (typecheck, test suite,
  sometimes exercising a module against a real store) and paste transcripts.
  Claims are checked, not trusted.
- **Greptile** doesn't review new PRs. It reviews only PRs labelled
  `greptile` (`.greptile/config.json`), so don't add that label to a new PR.
- Respond by pushing fix commits and replying per finding — "Addressed in
  `<sha>`" — rather than force-pushing a rewritten branch. A re-review then
  flips the verdict.
- Maintainers may push small review fixes **directly to your branch** to keep
  things moving. Say so in the PR body if you'd rather they didn't.
- PRs are never closed silently: a closed PR gets a one-line disposition
  comment (usually supersession by another PR).

## AI-assisted contributions

AI-written code is the norm in this ecosystem, welcome from everyone, and
held to exactly the same evidence standards as anything else. Declare it the
way we do:

- the `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  footer (or equivalent for your tooling) in the PR body, and
- a `Co-Authored-By:` trailer naming the model in commits.

What earns an automated contribution a changes-requested review is not being
AI-generated — it's arriving without the suite having been run, with tests
that don't fail on unfixed code, or with claims the branch itself disproves.

## Changelog

Changelog entries land as **fragment files** in
[`changelog.d/`](changelog.d/) — one file per change — and are folded into
`CHANGELOG.md` (loosely [Keep a Changelog](https://keepachangelog.com/)) at
release time. One file per change is what keeps concurrent work from
conflicting: when every PR edited the same `## Unreleased` section, any PR
that outlived another merge hit a conflict in `CHANGELOG.md`; distinct files
never do.

- **Format:** `changelog.d/<slug>.<breaking|added|changed|fixed>.md`, a flat
  file directly in `changelog.d/`, containing one or more markdown bullets
  (`- …`) written exactly as they should appear in `CHANGELOG.md`:
  continuation lines indent two spaces, nested bullets are fine, headings
  and horizontal rules are refused (even indented — a heading inside a
  fragment would corrupt the section structure). The slug just has to be
  unique among pending fragments and filesystem-safe — the PR number works,
  and so does the branch name with `/` replaced by `-`
  (`115-tune-out.added.md`, `fix-locus-routing.fixed.md`). The release
  script scans the directory fail-closed: a subdirectory, an unrecognized
  category suffix, or any other stray file aborts the release rather than
  silently stranding an entry.
- **The fragment lands with the change** — same commit, or at least the same
  PR. This binds direct pushes to `main` just as much as PRs. On PRs, CI
  enforces it softly: touching `src/` fails the `changelog` check unless the
  PR adds a fragment, edits a pending one or edits `CHANGELOG.md`, or carries
  the `no-changelog` label.
- **What needs an entry:** anything a module developer, host, or downstream
  consumer would notice — behavior, event/trace surfaces, tool namespacing,
  config schema, agent state machine, public exports, defaults. Internal
  refactors, test-only, and docs-only changes don't.
- **Breaking entries are audience-scoped.** Open the bullet by naming who
  needs to act (`- **Module authors:** …`) and cover: **who needs to act**,
  **migration**, and **unchanged** (what readers might fear broke but
  didn't). A breaking change goes out in a new minor version before 1.0
  (see **Breaking changes** below), so a host's caret range doesn't take
  it until the host raises that range in a change of its own, which is
  where these entries are read — spell out the minimum sibling versions it
  requires.
- **Editing `## Unreleased` in `CHANGELOG.md` directly still works** and is
  merged with the fragments at release time — it remains the right place to
  restructure pending entries, and the escape hatch for anything the
  fragment format can't express (e.g. an audience-qualified
  `### Breaking (module authors only)` heading, which `breaking` fragments
  will then join). Keep one `## Unreleased` heading — the release script
  refuses more than one, since only the first is ever cut.
- **Releases** (maintainers): `npm version <patch|minor|major>` does the
  whole cut — the `version` hook folds the pending fragments plus any
  entries filed directly under `Unreleased` into `## X.Y.Z — YYYY-MM-DD`
  (subsections emitted in `### Breaking` / `### Added` / `### Changed` /
  `### Fixed` order), deletes the consumed fragments, keeps a fresh empty
  `Unreleased` above, and refuses to release when there is nothing to
  release; npm then commits and tags. `git push --follow-tags` triggers CI,
  which refuses a tag with no matching changelog section, checks in a job
  of its own that the packed release installs on its own, publishes
  `@animalabs/agent-framework` to npm once that check has passed, and
  creates the GitHub release with that section as its notes, cut at an
  entry's start, with a link to the whole section, when it's longer than
  120,000 characters, under GitHub's limit of 125,000. The check,
  `node scripts/pack-installs-alone.mjs`, packs the release and installs
  the tarball alone into an empty directory with its dependencies from
  npm. The install is linked, so each package reaches only the
  dependencies it declares. It then checks the installed package, as the
  script's header lists. To run it by hand, run `npm run build` first,
  for example before `git push --follow-tags`, or dispatch the workflow on
  a branch, where it publishes nothing. The two
  release jobs are independent: some consumers run github-clone checkouts,
  so release notes must exist even when npm publish fails. Both need the
  build job, so a failed build stops both; past it, so do a tag with no
  changelog section, which neither can release, and an open release hold
  (below), which each checks. Version bumps are a maintainer release-time
  action, not part of feature PRs.
- **Breaking changes.** A dependent's caret range takes the later
  versions of its line (0.22.x before 1.0, 1.x from 1.0, and 0.0.z alone),
  so a breaking change released as a patch reaches each dependent whose
  range takes it at its next fresh install. Before 1.0, a breaking change
  goes out in a new minor version (0.22.x to 0.23.0), and from 1.0 in a
  new major. File it as breaking, as a `breaking` fragment or under a
  `### Breaking` subsection of `Unreleased`: that is what `npm version`
  reads. While such an entry is pending, `npm version` refuses a version
  that doesn't open a line no release has reached, before it bumps or
  writes anything, and says where each entry is filed and the bump to run
  instead. A prerelease counts as the release it leads to, so one in the
  current line is refused too. One that opens the next line (a preminor
  before 1.0, a premajor from 1.0) isn't, and nor is any later version of
  that line. A version below the current line is refused as well. npm's
  `--ignore-scripts` skips this check, but it also skips the fold, and the
  publish workflow refuses a tag whose version has no changelog section.
- **Release holds.** When releasing `main` as it stands would harm
  someone running it, open an issue that says what has to happen first
  and label it `release-hold`, or ask a maintainer to label it. Close it
  once that's happened, or if it no longer applies. When what has to
  happen is a fix that this package itself must release, close the hold
  once the fix is merged, then release. While one is open, `npm version`
  stops before it bumps anything, `npm publish` refuses, and the publish
  workflow refuses both its npm publish and its GitHub release notes,
  each checking when it runs. The check also stops a release when it
  can't read the holds from GitHub, and says why. Closing the hold is
  the way past it. npm's `--ignore-scripts` skips the check, but on
  `npm version` it skips the changelog fold too, so the tag lands
  without its changelog section and the publish workflow's changelog
  check fails it. Publishing a tarball made earlier with `npm pack` runs
  no lifecycle script, so no check sees it. A hold stops releases, not
  merges, so when the hazard is in an open pull request, say so on that
  pull request, naming what has to happen first: its comment thread is
  the gate (see Review process).

## Building and testing

```bash
npm install
npm run build         # tsc; tests run from dist/, so build first
npm test              # node --test --test-force-exit [--test-concurrency=$AF_TEST_CONCURRENCY] --test-timeout=600000 dist/test/*.test.js, with test/helpers/force-exit-blocking-stdout loaded first
npx tsc --noEmit      # typecheck
```

`npm test` runs the compiled output, so a stale `dist/` will happily test
code you no longer have — always build before testing, and after switching
branches. The `pretest` hook copies `test/fixtures/*.mjs` and code_execution's
`quickjs.wasm` into `dist/`.

`--test-timeout=600000` bounds each test file as a whole under Node
22.12, as it did under Node 20, and each test under Node 24, at ten
minutes; the slowest file, `mcpl-runtime-lifecycle`, takes about three.
Each job in `ci.yml` also has a `timeout-minutes` limit, which ends a hang
the test timeout doesn't reach.

CI (`ci.yml`'s Build & Test, and `publish.yml`) runs twice as many test files
at once as the runner has cores, by setting `AF_TEST_CONCURRENCY`; `npm test`
passes it on as `--test-concurrency` only when it's set. Unset, as it is
locally, Node's default of one file fewer than the cores applies. To run the
suite as CI schedules it, for example to chase a failure that shows only
under load, set it: `AF_TEST_CONCURRENCY=$(node -p "2 * require('node:os').cpus().length") npm test`.

Push-time CI (`ci.yml`) builds, typechecks and runs the whole suite once on
every pull request and every push to main, on ubuntu at the engines floor
(Node 22.12.0). Every other leg, macOS at 22.12.0, 24 and the newest Node
and ubuntu at 24 and the newest Node, only installs the package and loads
it: it builds and runs `node scripts/pack-installs-alone.mjs`, the pack
check below, which loads the package's entry points and each bin's imports
without running a bin. macOS runners queue, so a PR takes Install & start's
macOS leg at the engines floor only, and code_execution's Bun macOS legs
only when it changes source, `tsconfig.json`, `package.json`, their tests,
the test helpers or `ci.yml` (the `changes` job decides). A push to main
runs all of them. Lockfiles are deliberately gitignored in this repo, so CI
installs with `npm install` rather than `npm ci`, and there is no lock to
keep in sync. The pack check, which the publish workflow runs before
publishing, also runs on ubuntu with bun set up (`pack-check`), so a file
`package.json` names that's left out of the package, or an import only
`devDependencies` supply, fails the PR.

When working against local sibling checkouts rather than published versions,
see the ecosystem workspace setup — `bun install` at the `rust-connectome`
root links the four packages together.


CI check contexts follow the workflow matrices. When a matrix changes, a
maintainer should check that the repository's required-status list matches
it; workflow edits do not change branch-protection settings themselves. The
macOS legs a PR may leave out (Install & start on Node 24 and the newest
Node, the Bun macOS legs) report no check on that PR, so a required check
must not name them, or such a PR waits on a check that never comes.
