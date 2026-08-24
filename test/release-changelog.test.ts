// Black-box coverage of scripts/release-changelog.mjs: each case runs the
// real script in a throwaway directory, so assembly, validation, and the
// deletion of consumed fragments are all exercised exactly as `npm version`
// would run them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/release-changelog.mjs", import.meta.url),
);

const BASE_CHANGELOG = [
  "# Changelog",
  "",
  "Intro that mentions ## Unreleased inline, which must not count as a heading.",
  "",
  "## Unreleased",
  "",
  "## 1.0.0 — 2026-01-01",
  "",
  "### Fixed",
  "",
  "- Old entry.",
  "",
].join("\n");

interface Fixture {
  version?: string;
  changelog?: string;
  fragments?: Record<string, string>;
}

function setup(f: Fixture): string {
  const dir = mkdtempSync(join(tmpdir(), "release-changelog-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: f.version ?? "1.1.0" }),
  );
  writeFileSync(join(dir, "CHANGELOG.md"), f.changelog ?? BASE_CHANGELOG);
  mkdirSync(join(dir, "changelog.d"));
  writeFileSync(join(dir, "changelog.d", "README.md"), "# Pending fragments\n");
  for (const [name, body] of Object.entries(f.fragments ?? {})) {
    const path = join(dir, "changelog.d", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

function run(dir: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function section(text: string, version: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${version} — `));
  assert.notEqual(start, -1, `no '## ${version}' section in:\n${text}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return rest.slice(0, end === -1 ? undefined : end).join("\n").trim();
}

const changelog = (dir: string) => readFileSync(join(dir, "CHANGELOG.md"), "utf8");
const pending = (dir: string) => readdirSync(join(dir, "changelog.d")).sort();

test("folds fragments into a versioned section in canonical order and deletes them", () => {
  const dir = setup({
    fragments: {
      "z-later.fixed.md": "- Fixed thing.\n",
      "a-first.added.md": "- Added thing,\n  continued on an indented line.\n",
      "m.breaking.md": "- **Module authors:** breaking thing.\n",
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const text = changelog(dir);
  assert.equal(
    section(text, "1.1.0"),
    [
      "### Breaking",
      "",
      "- **Module authors:** breaking thing.",
      "",
      "### Added",
      "",
      "- Added thing,",
      "  continued on an indented line.",
      "",
      "### Fixed",
      "",
      "- Fixed thing.",
    ].join("\n"),
  );
  assert.match(text, /^## Unreleased\n\n## 1\.1\.0 — \d{4}-\d{2}-\d{2}\n/m, "fresh empty Unreleased above the cut");
  assert.ok(text.startsWith("# Changelog\n\nIntro that mentions"), "file header preserved");
  assert.equal(section(text, "1.0.0"), "### Fixed\n\n- Old entry.", "older section untouched");
  assert.deepEqual(pending(dir), ["README.md"], "consumed fragments deleted, README kept");
});

test("merges fragments into directly-filed Unreleased entries, reordering subsections canonically", () => {
  const dir = setup({
    changelog: BASE_CHANGELOG.replace(
      "## Unreleased\n",
      "## Unreleased\n\n### Fixed\n\n- Manual fix.\n\n### Added\n\n- Manual add.\n",
    ),
    fragments: { "x.fixed.md": "- Fragment fix.\n" },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    section(changelog(dir), "1.1.0"),
    "### Added\n\n- Manual add.\n\n### Fixed\n\n- Manual fix.\n\n- Fragment fix.",
  );
});

test("breaking fragments join an audience-qualified Breaking heading", () => {
  const dir = setup({
    changelog: BASE_CHANGELOG.replace(
      "## Unreleased\n",
      "## Unreleased\n\n### Fixed\n\n- Manual fix.\n\n### Breaking (module authors only)\n\n- Manual break.\n",
    ),
    fragments: { "b.breaking.md": "- Fragment break.\n" },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    section(changelog(dir), "1.1.0"),
    "### Breaking (module authors only)\n\n- Manual break.\n\n- Fragment break.\n\n### Fixed\n\n- Manual fix.",
  );
});

test("accepts nested bullets and multi-line continuations", () => {
  const dir = setup({
    fragments: { "n.fixed.md": "- one\n  - nested\n  more text\n- two\n" },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(section(changelog(dir), "1.1.0"), "### Fixed\n\n- one\n  - nested\n  more text\n- two");
});

const refusals: Array<[string, Fixture, RegExp]> = [
  ["nothing to release", {}, /nothing to release as 1\.1\.0/],
  ["duplicate version section", { version: "1.0.0", fragments: { "a.fixed.md": "- x\n" } }, /'## 1\.0\.0' section already exists/],
  ["unrecognized category suffix", { fragments: { "oops.md": "- x\n" } }, /changelog\.d\/oops\.md: unrecognized file/],
  ["stray non-markdown file", { fragments: { "notes.txt": "hi\n", "a.fixed.md": "- x\n" } }, /changelog\.d\/notes\.txt: unrecognized file/],
  ["empty fragment", { fragments: { "e.fixed.md": "\n" } }, /changelog\.d\/e\.fixed\.md: empty fragment/],
  ["fragment nested under a branch-name directory", { fragments: { "fix/foo.fixed.md": "- x\n", "a.fixed.md": "- y\n" } }, /changelog\.d\/fix: not a file/],
  ["plain prose", { fragments: { "p.fixed.md": "prose only\n" } }, /offending line: 'prose only'/],
  ["prose after a valid bullet", { fragments: { "p.fixed.md": "- ok\nrogue prose\n" } }, /offending line: 'rogue prose'/],
  ["top-level heading after a bullet", { fragments: { "h.fixed.md": "- ok\n\n## 9.9.9 — fake\n" } }, /offending line: '## 9\.9\.9 — fake'/],
  ["indented ATX heading", { fragments: { "h.fixed.md": "- ok\n  ## 8.8.8 — injected\n  - beneath\n" } }, /offending line: '  ## 8\.8\.8 — injected'/],
  ["indented setext underline / rule", { fragments: { "s.fixed.md": "- ok\n  ---\n" } }, /offending line: '  ---'/],
  ["tab-indented continuation", { fragments: { "t.fixed.md": "- ok\n\tcontinued\n" } }, /offending line: '\tcontinued'/],
  ["no Unreleased heading", { changelog: "# Changelog\n\n## 1.0.0 — 2026-01-01\n\n- x\n", fragments: { "a.fixed.md": "- x\n" } }, /no '## Unreleased' section/],
  ["two Unreleased headings", { changelog: BASE_CHANGELOG + "\n## Unreleased\n\n- stranded\n", fragments: { "a.fixed.md": "- x\n" } }, /2 '## Unreleased' headings/],
];

for (const [name, fixture, message] of refusals) {
  test(`refuses ${name} without touching anything`, () => {
    const dir = setup(fixture);
    const before = { changelog: changelog(dir), pending: pending(dir) };
    const r = run(dir);
    assert.equal(r.status, 1, `expected refusal, got exit ${r.status}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, message);
    assert.equal(changelog(dir), before.changelog, "CHANGELOG.md must be untouched");
    assert.deepEqual(pending(dir), before.pending, "no fragment may be deleted on refusal");
  });
}
