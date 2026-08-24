// Runs as npm's `version` lifecycle hook (see package.json): at that point
// package.json already carries the new version, and files staged here are
// included in the release commit that `npm version` then creates and tags.
//
// Folds the pending fragments in changelog.d/ (one file per change,
// `<slug>.<breaking|added|changed|fixed>.md`) together with anything filed
// directly under the standing `## Unreleased` section into a new
// `## X.Y.Z — YYYY-MM-DD` section, deletes the consumed fragments, and
// leaves a fresh empty `## Unreleased` above it. Refuses to release when
// there is nothing to release, or when the input's shape is ambiguous.
import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const CHANGELOG = "CHANGELOG.md";
const FRAGMENT_DIR = "changelog.d";
// Canonical subsection order; a fragment's category must be one of these.
const CATEGORIES = ["breaking", "added", "changed", "fixed"];
const HEADINGS = {
  breaking: "Breaking",
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
};

// Refusals throw and are reported at the entry point, which then lets the
// process end on its own with exitCode 1. process.exit() would race the
// stderr write when stderr is a pipe (asynchronous on macOS), leaving the
// caller a bare failure status with no reason attached.
class ReleaseError extends Error {}
const fail = (msg) => {
  throw new ReleaseError(msg);
};

// Fragment grammar: every non-blank line starts a bullet or continues one
// (indented two or more spaces; nested bullets included). Headings and
// thematic breaks are refused wherever they appear — at top level a '## '
// line would splice a fake section boundary into the released changelog,
// and as item content ('- ## x', '  ## x') they still render as headings.
const isBulletStart = (l) => /^[-*] /.test(l);
const isContinuation = (l) => /^ {2,}\S/.test(l);
const itemContent = (l) => l.replace(/^\s*(?:[-*]\s+)?/, "");
const isHeading = (s) => /^#{1,6}(\s|$)/.test(s);
// Thematic breaks may carry interior whitespace ('- - -', '* * *').
const isRule = (s) => /^([-*_=])(\s*\1){2,}\s*$/.test(s);
const isBlockConstruct = (l) => isRule(l.trim()) || isHeading(itemContent(l));

// The directory is scanned fail-closed: anything that is not README.md or
// a well-formed fragment file aborts the release, so an entry can never be
// silently left out (e.g. a fragment created under a 'fix/' subdirectory
// because the slug was taken verbatim from a branch name).
function collectFragments() {
  const fragments = [];
  if (!existsSync(FRAGMENT_DIR)) return fragments;
  const entries = readdirSync(FRAGMENT_DIR, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const entry of entries) {
    const { name } = entry;
    if (name === "README.md") continue;
    if (!entry.isFile()) {
      fail(
        `${FRAGMENT_DIR}/${name}: not a file. Fragments are flat files directly ` +
          `in ${FRAGMENT_DIR}/ — a slug cannot contain '/'; use the PR number, ` +
          "or the branch name with '/' replaced by '-'.",
      );
    }
    const m = name.match(/\.(breaking|added|changed|fixed)\.md$/);
    if (!m) {
      fail(
        `${FRAGMENT_DIR}/${name}: unrecognized file — name fragments ` +
          `'<slug>.<${CATEGORIES.join("|")}>.md' so the entry is not silently stranded.`,
      );
    }
    const body = readFileSync(join(FRAGMENT_DIR, name), "utf8").trim();
    if (!body) fail(`${FRAGMENT_DIR}/${name}: empty fragment.`);
    const offending = body
      .split("\n")
      .find(
        (l) =>
          l.trim() !== "" &&
          (!(isBulletStart(l) || isContinuation(l)) || isBlockConstruct(l)),
      );
    if (offending !== undefined) {
      fail(
        `${FRAGMENT_DIR}/${name}: a fragment is one or more markdown bullets ` +
          "('- …'; continuation lines indented two spaces; no headings or " +
          `rules) — offending line: '${offending}'.`,
      );
    }
    fragments.push({ name, category: m[1], body });
  }
  return fragments;
}

// Merge fragment bullets into the Unreleased body's subsection structure.
// Directly-filed entries are kept; a fragment joins the first subsection
// whose title starts with its category (so audience-qualified headings like
// '### Breaking (module authors only)' still attract 'breaking' fragments),
// or a new canonical subsection. Output is emitted in canonical order.
function mergeFragments(body, frags) {
  const preamble = [];
  const parts = [];
  let current = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^###\s+(.*)$/);
    if (h) {
      current = { title: h[1].trim(), lines: [] };
      parts.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  for (const f of frags) {
    let part = parts.find((p) => p.title.toLowerCase().startsWith(f.category));
    if (!part) {
      part = { title: HEADINGS[f.category], lines: [] };
      parts.push(part);
    }
    part.lines.push("", ...f.body.split("\n"));
  }
  const rank = (t) => {
    const i = CATEGORIES.findIndex((c) => t.toLowerCase().startsWith(c));
    return i === -1 ? CATEGORIES.length : i;
  };
  const chunks = [];
  const pre = preamble.join("\n").trim();
  if (pre) chunks.push(pre);
  for (const p of [...parts].sort((a, b) => rank(a.title) - rank(b.title))) {
    const content = p.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    chunks.push(content ? `### ${p.title}\n\n${content}` : `### ${p.title}`);
  }
  return chunks.join("\n\n");
}

function main() {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const text = readFileSync(CHANGELOG, "utf8");
  const fragments = collectFragments();

  // Exactly one Unreleased heading. A second one silently strands entries:
  // only the first is ever cut, so anything filed under a later heading is
  // never released and never reaches the GitHub release notes.
  const headings = [...text.matchAll(/^## Unreleased[ \t]*$/gm)];
  if (headings.length === 0) {
    fail(`no '## Unreleased' section in ${CHANGELOG} — add one before releasing.`);
  }
  if (headings.length > 1) {
    const lines = headings.map((m) => text.slice(0, m.index).split("\n").length);
    fail(
      `${headings.length} '## Unreleased' headings (lines ${lines.join(", ")}). ` +
        "Only the first is released; fold them into one before releasing.",
    );
  }
  const [header] = headings;

  const escaped = version.replace(/[.]/g, "\\.");
  if (new RegExp(`^## ${escaped}([^0-9]|$)`, "m").test(text)) {
    fail(`a '## ${version}' section already exists.`);
  }

  const afterHeader = text.slice(header.index + header[0].length);
  const nextSection = afterHeader.search(/^## /m);
  const oldBody = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
  const rest = nextSection === -1 ? "" : afterHeader.slice(nextSection);

  const merged = mergeFragments(oldBody, fragments);
  if (!/^[ \t]*[-*] /m.test(merged)) {
    fail(
      `nothing to release as ${version} — no fragments in ${FRAGMENT_DIR}/ ` +
        "and no entries under '## Unreleased'.",
    );
  }

  // Spliced by index rather than string-replaced: `text.replace("## Unreleased", …)`
  // would hit the first *substring* occurrence, which is not necessarily the
  // heading the regex matched (an inline mention of `## Unreleased` in prose
  // comes first) and would inject the version heading into the wrong place.
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    CHANGELOG,
    text.slice(0, header.index) +
      `## Unreleased\n\n## ${version} — ${date}\n\n${merged}\n\n` +
      rest,
  );
  for (const f of fragments) unlinkSync(join(FRAGMENT_DIR, f.name));
  console.log(
    `${CHANGELOG}: released '## ${version} — ${date}' from ${fragments.length} ` +
      "fragment(s) plus the Unreleased section.",
  );
}

try {
  main();
} catch (e) {
  if (!(e instanceof ReleaseError)) throw e;
  console.error(`release-changelog: ${e.message}`);
  process.exitCode = 1;
}
