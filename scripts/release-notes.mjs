// Runs in the publish workflow's GitHub release job, for a pushed tag:
// `node scripts/release-notes.mjs <tag> <file>` writes the release's notes
// to <file>. They are the tag's CHANGELOG.md section, `## X.Y.Z — YYYY-MM-DD`,
// from its first line that isn't empty to the next `## ` heading, as the
// job's awk and sed cut it before this script.
//
// GitHub refuses a release body over 125,000 characters, as it refused
// v0.22.3's (run 39167578309, HTTP 422). So a section longer than LIMIT
// characters, counted as code points, is cut at a top-level entry's start
// (a `- ` or `* ` bullet at a line's start, as release-changelog.mjs takes
// them): the notes keep whole entries, with the `### ` headings they sit
// under, up to the last that fits with the closing sentence, which says how
// many entries it leaves out and links the whole section in CHANGELOG.md at
// the tag. LIMIT leaves room for a count of characters that isn't GitHub's.
//
// The link names the repository GITHUB_REPOSITORY gives, as in GitHub
// Actions, where the release is made. Any failure prints a workflow error
// command on stdout, as the job's own check did, and exits 1; a refusal,
// such as a tag with no section, writes no notes.
import { readFileSync, writeFileSync } from "node:fs";

const LIMIT = 120_000;

class NotesError extends Error {}

/** `version`'s section as the job's awk read it: the lines after a `## `
 *  line whose second blank-separated field is the version, up to the next
 *  `## ` line, less the empty lines it starts with (sed's `/./` keeps a line
 *  holding any character, a space or a CR included). */
function sectionOf(changelog, version) {
  const lines = changelog.split("\n");
  if (changelog.endsWith("\n")) lines.pop();
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("## ")) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (lines[i].split(/[ \t]+/)[1] === version) start = i + 1;
  }
  if (start < 0) return { heading: "", lines: [] };
  const section = lines.slice(start, end);
  while (section.length > 0 && section[0] === "") section.shift();
  return { heading: lines[start - 1].slice(3), lines: section };
}

/** A version heading's anchor as GitHub writes it: lower case, with every
 *  character but a letter, a combining mark, a digit, `_`, `-` or a space
 *  dropped, and each space a `-`. `0.22.3 — 2026-10-18` is `0223--2026-10-18`. */
function anchorOf(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "").replaceAll(" ", "-");
}

function codePoints(text) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Lines as awk prints them, each with its newline. */
const joined = (lines) => lines.map((line) => `${line}\n`).join("");

/** A section longer than LIMIT, cut before the last entry at which what
 *  comes before it fits with the closing sentence. A `### ` heading that
 *  would end what's kept, with none of its entries, goes with them. */
function cut(lines, version, link) {
  const entries = lines.flatMap((line, i) => (/^[-*] /.test(line) ? [i] : []));
  for (let kept = entries.length - 1; kept >= 0; kept--) {
    let end = entries[kept];
    for (let i = end - 1; i >= 0 && (/^\s*$/.test(lines[i]) || lines[i].startsWith("### ")); i--) {
      if (lines[i].startsWith("### ")) end = i;
    }
    const head = joined(lines.slice(0, end));
    const sentence =
      `This leaves out the section's last ${entries.length - kept} of its ${entries.length} entries, ` +
      `to keep these notes within ${LIMIT.toLocaleString("en-US")} characters, under GitHub's limit of 125,000 for a release. ` +
      `The whole section is in \`CHANGELOG.md\` at the tag: ${link}\n`;
    // After a blank line, so Markdown can't read it as the last entry's.
    const notes = head === "" || head.endsWith("\n\n") ? head + sentence : `${head}\n${sentence}`;
    if (codePoints(notes) <= LIMIT) return notes;
  }
  throw new NotesError(
    `The CHANGELOG.md section for ${version} is longer than ${LIMIT} characters, ` +
    "and no top-level entry starts early enough to cut it there.",
  );
}

function notesFor(tag, changelog) {
  const version = tag.replace(/^v/, "");
  const { heading, lines } = sectionOf(changelog, version);
  if (lines.length === 0) throw new NotesError(`No CHANGELOG.md section found for ${version}.`);
  const whole = joined(lines);
  if (codePoints(whole) <= LIMIT) return whole;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new NotesError(
      `The CHANGELOG.md section for ${version} is longer than ${LIMIT} characters, ` +
      "and GITHUB_REPOSITORY is unset, so the notes can't link the whole section.",
    );
  }
  return cut(lines, version, `https://github.com/${repository}/blob/${tag}/CHANGELOG.md#${anchorOf(heading)}`);
}

const [tag, file] = process.argv.slice(2);
try {
  if (!tag || !file) throw new NotesError("Usage: node scripts/release-notes.mjs <tag> <file>");
  writeFileSync(file, notesFor(tag, readFileSync("CHANGELOG.md", "utf8")));
} catch (error) {
  // A read or write that failed gets the error command too, and its stack
  // after it. process.exitCode rather than process.exit(), so a piped stdout
  // gets the whole line before the process ends.
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  if (!(error instanceof NotesError)) console.error(error);
  process.exitCode = 1;
}
