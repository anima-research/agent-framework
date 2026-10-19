// Black-box coverage of scripts/release-notes.mjs: each case writes a
// CHANGELOG.md into a throwaway directory and runs the real script there, as
// the publish workflow's GitHub release job runs it for a pushed tag. GitHub
// refused v0.22.3's release notes, its whole changelog section, for being
// over its 125,000-character limit (run 39167578309, HTTP 422).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/release-notes.mjs", import.meta.url));
const LIMIT = 120_000;
const LINK = "https://github.com/owner/repo/blob/v1.2.3/CHANGELOG.md#123--2026-01-02";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  /** The tag, `v1.2.3` unless given. */
  tag?: string;
  /** The environment, GITHUB_REPOSITORY=owner/repo unless given. */
  env?: Record<string, string>;
  /** The arguments, `<tag> notes.md` unless given. */
  args?: string[];
}

/** The script run beside `changelog` (none, for null): its exit code, its
 *  stdout, and the notes it wrote, or null where it wrote none. */
function run(
  changelog: string | null,
  { tag = "v1.2.3", env = { GITHUB_REPOSITORY: "owner/repo" }, args = [tag, "notes.md"] }: Run = {},
): Promise<{ code: number; stdout: string; notes: string | null }> {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  made.push(dir);
  if (changelog !== null) writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: dir, env: { PATH: process.env.PATH ?? "", ...env } }, (error, stdout) => {
      const file = join(dir, "notes.md");
      resolve({
        code: error ? Number(error.code ?? 1) : 0,
        stdout,
        notes: existsSync(file) ? readFileSync(file, "utf8") : null,
      });
    });
  });
}

const codePoints = (text: string): number => [...text].length;

/** A CHANGELOG.md with `section` as 1.2.3's, under `heading`, between a
 *  newer and an older one. */
const changelog = (section: string, heading = "## 1.2.3 — 2026-01-02"): string =>
  `# Changelog\n\n## Unreleased\n\n## 1.2.30 — 2026-01-03\n\n### Fixed\n\n- Not 1.2.3's.\n\n${heading}\n\n${section}## 1.2.2 — 2026-01-01\n\n### Fixed\n\n- An older entry.\n`;

/** An entry of `size` code points, a `- ` bullet (or `bullet`) with a
 *  continuation line indented as a fragment's is and a nested bullet, and
 *  the blank line after it. */
function entry(i: number, size: number, bullet = "-"): string {
  const head = `${bullet} Entry ${i}.\n  - nested ${i}.\n  `;
  return `${head}${"x".repeat(size - codePoints(head) - 2)}\n\n`;
}

const sentence = (left: number, of: number, link = LINK): string =>
  `This leaves out the section's last ${left} of its ${of} entries, to keep these notes within 120,000 characters, under GitHub's limit of 125,000 for a release. The whole section is in \`CHANGELOG.md\` at the tag: ${link}\n`;

const keptEntries = (notes: string): number => notes.split("\n").filter((line) => /^[-*] /.test(line)).length;

test("a section within the limit is the notes as it stands, from its first non-empty line to the next version", async () => {
  const section = "\n### Added\n\n- An entry\n  with a continuation line,\n  - and a nested bullet.\n\n### Fixed\n\n- Another entry.\n\n";
  const result = await run(changelog(section), { env: {} });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.notes, section.slice(1), "and without GITHUB_REPOSITORY, which only a cut needs");
  // Its version field may be set off by more than one blank, a tab among them.
  const spaced = await run(changelog(section, "##  1.2.3\t— 2026-01-02"));
  assert.equal(spaced.notes, section.slice(1));
  // The file's last section ends where the file does, with or without a
  // final newline, and gets one, as awk printed it.
  const last = await run(changelog(section), { tag: "v1.2.2" });
  assert.equal(last.notes, "### Fixed\n\n- An older entry.\n");
  const unended = await run(changelog(section).replace(/\n$/, ""), { tag: "v1.2.2" });
  assert.equal(unended.notes, "### Fixed\n\n- An older entry.\n");
  // CR line ends stay, and a line holding a CR isn't empty, as sed read it.
  const crlf = changelog(section).replaceAll("\n", "\r\n");
  const start = crlf.indexOf("## 1.2.3 — 2026-01-02\r\n") + "## 1.2.3 — 2026-01-02\r\n".length;
  const cr = await run(crlf);
  assert.equal(cr.notes, crlf.slice(start, crlf.indexOf("## 1.2.2")));
  // A section of exactly the limit is still whole.
  const full = `### Added\n\n- ${"x".repeat(LIMIT - 15)}\n\n`;
  assert.equal(codePoints(full), LIMIT);
  assert.equal((await run(changelog(full))).notes, full);
});

test("a section past the limit is cut at an entry's start, keeping every entry that fits whole, and says how many it leaves out", async () => {
  // Every third entry a `* ` bullet, as release-changelog.mjs takes them,
  // after an operator note, as 0.22.2's section has.
  const entries = Array.from({ length: 150 }, (_, i) => entry(i, 1_000, i % 3 === 2 ? "*" : "-"));
  const note = "**Operators upgrading:** a note.\n\n";
  const section = `${note}### Added\n\n${entries.join("")}`;
  const result = await run(changelog(section));
  assert.equal(result.code, 0, result.stdout);
  const notes = result.notes!;
  assert.ok(codePoints(notes) <= LIMIT, `${codePoints(notes)} code points`);
  const kept = keptEntries(notes);
  assert.ok(kept > 0 && kept < 150);
  assert.equal(notes, `${note}### Added\n\n${entries.slice(0, kept).join("")}${sentence(150 - kept, 150)}`);
  // The next entry wouldn't have fitted.
  const more = `${note}### Added\n\n${entries.slice(0, kept + 1).join("")}${sentence(149 - kept, 150)}`;
  assert.ok(codePoints(more) > LIMIT);
});

test("the closing sentence counts toward the limit, which the notes may reach exactly", async () => {
  // Eleven entries, the first nine of which fit with the sentence to the
  // code point, or, with one more code point, don't.
  const tail = Array.from({ length: 2 }, (_, i) => entry(9 + i, 20_000));
  const fit = (extra: number) => {
    const budget = LIMIT + extra - codePoints(`### Added\n\n`) - codePoints(sentence(2, 11));
    const first = Array.from({ length: 8 }, (_, i) => entry(i, 1_000));
    return [...first, entry(8, budget - codePoints(first.join("")))];
  };
  const exact = fit(0);
  const atLimit = await run(changelog(`### Added\n\n${[...exact, ...tail].join("")}`));
  assert.equal(atLimit.notes, `### Added\n\n${exact.join("")}${sentence(2, 11)}`);
  assert.equal(codePoints(atLimit.notes!), LIMIT);
  const over = fit(1);
  const pastIt = await run(changelog(`### Added\n\n${[...over, ...tail].join("")}`));
  assert.equal(pastIt.notes, `### Added\n\n${over.slice(0, 8).join("")}${sentence(3, 11)}`);
});

test("the closing sentence follows a blank line, where the entries have none between them", async () => {
  const entries = Array.from({ length: 150 }, (_, i) => entry(i, 1_000).replace(/\n\n$/, "\n"));
  const result = await run(changelog(`### Added\n\n${entries.join("")}\n`));
  assert.equal(result.code, 0, result.stdout);
  const kept = keptEntries(result.notes!);
  assert.equal(result.notes, `### Added\n\n${entries.slice(0, kept).join("")}\n${sentence(150 - kept, 150)}`);
});

test("a heading whose entries all fall past the cut is left out with them", async () => {
  // The added entries fit with the sentence; the first fixed one doesn't.
  const added = Array.from({ length: 110 }, (_, i) => entry(i, 1_000));
  const fixed = [entry(110, 20_000), entry(111, 1_000)];
  const result = await run(changelog(`### Added\n\n${added.join("")}### Fixed\n\n${fixed.join("")}`));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.notes, `### Added\n\n${added.join("")}${sentence(2, 112)}`);
  // So it is with a line of spaces between the heading and its entry.
  const spaced = await run(changelog(`### Added\n\n${added.join("")}### Fixed\n  \n${fixed.join("")}`));
  assert.equal(spaced.notes, `### Added\n\n${added.join("")}${sentence(2, 112)}`);
  // A first entry longer than the limit leaves the sentence alone, after
  // whatever comes before its heading, such as an operator note.
  const alone = await run(changelog(`### Added\n\n${entry(0, LIMIT + 5_000)}${entry(1, 1_000)}`));
  assert.equal(alone.notes, sentence(2, 2));
  const noted = await run(changelog(`**Operators upgrading:** a note.\n\n### Added\n\n${entry(0, LIMIT + 5_000)}${entry(1, 1_000)}`));
  assert.equal(noted.notes, `**Operators upgrading:** a note.\n\n${sentence(2, 2)}`);
});

test("the limit counts code points, not UTF-16 units", async () => {
  // 100,000 code points of emoji are 200,000 UTF-16 units.
  const section = `### Added\n\n- ${"😀".repeat(100_000)}\n\n`;
  const result = await run(changelog(section));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.notes, section, "within the limit, the notes as they stand");
  // 26 entries of 5,000 emoji: 23 fit by code points, 11 by UTF-16 units.
  const entries = Array.from({ length: 26 }, (_, i) => `- ${i}: ${"😀".repeat(5_000)}\n\n`);
  const long = await run(changelog(`### Added\n\n${entries.join("")}`));
  assert.equal(long.notes, `### Added\n\n${entries.slice(0, 23).join("")}${sentence(3, 26)}`);
});

test("the link names the tag and the heading's anchor as GitHub writes it", async () => {
  const entries = Array.from({ length: 150 }, (_, i) => entry(i, 1_000));
  const result = await run(changelog(`### Added\n\n${entries.join("")}`, "## 1.2.3-RC.1 — 2026-01-02"), { tag: "v1.2.3-RC.1" });
  assert.equal(result.code, 0, result.stdout);
  assert.ok(result.notes!.endsWith(" https://github.com/owner/repo/blob/v1.2.3-RC.1/CHANGELOG.md#123-rc1--2026-01-02\n"), result.notes!.slice(-200));
});

test("a failure exits 1 and says why in a workflow error, and a refusal writes no notes", async (t) => {
  const long = `### Added\n\n${Array.from({ length: 150 }, (_, i) => entry(i, 1_000)).join("")}`;
  const refusals: Array<[string, string | null, Run, string]> = [
    ["no section", changelog("### Added\n\n- An entry.\n\n"), { tag: "v9.9.9" }, "No CHANGELOG.md section found for 9.9.9."],
    ["an empty section", changelog("\n\n"), {}, "No CHANGELOG.md section found for 1.2.3."],
    ["a long section with no entry", changelog(`### Added\n\n  ${"x".repeat(LIMIT)}\n\n`), {},
      `The CHANGELOG.md section for 1.2.3 is longer than ${LIMIT} characters, and no top-level entry starts early enough to cut it there.`],
    ["a long section whose first entry starts too late", changelog(`### Added\n\n  ${"x".repeat(LIMIT)}\n\n- An entry.\n\n`), {},
      `The CHANGELOG.md section for 1.2.3 is longer than ${LIMIT} characters, and no top-level entry starts early enough to cut it there.`],
    ["a long section and no repository to link", changelog(long), { env: {} },
      `The CHANGELOG.md section for 1.2.3 is longer than ${LIMIT} characters, and GITHUB_REPOSITORY is unset, so the notes can't link the whole section.`],
    ["an empty tag", changelog(long), { args: ["", "notes.md"] }, "Usage: node scripts/release-notes.mjs <tag> <file>"],
    ["no file to write to", changelog(long), { args: ["v1.2.3"] }, "Usage: node scripts/release-notes.mjs <tag> <file>"],
  ];
  for (const [name, text, options, message] of refusals) {
    await t.test(name, async () => {
      const result = await run(text, options);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, `::error::${message}\n`);
      assert.equal(result.notes, null);
    });
  }
  await t.test("no CHANGELOG.md to read", async () => {
    const result = await run(null);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^::error::ENOENT: no such file or directory, open 'CHANGELOG\.md'\n$/);
  });
  await t.test("a file it can't write", async () => {
    const result = await run(changelog("### Added\n\n- An entry.\n\n"), { args: ["v1.2.3", "missing/notes.md"] });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^::error::ENOENT: no such file or directory, open 'missing\/notes\.md'\n$/);
  });
});
