// Runs as npm's `version` lifecycle hook (see package.json): at that point
// package.json already carries the new version, and files staged here are
// included in the release commit that `npm version` then creates and tags.
//
// Cuts the standing `## Unreleased` section into `## X.Y.Z — YYYY-MM-DD` and
// leaves a fresh empty `## Unreleased` above it. Refuses to release when
// there is nothing to release, or when the file's shape is ambiguous.
import { readFileSync, writeFileSync } from "node:fs";

const path = "CHANGELOG.md";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const text = readFileSync(path, "utf8");

const fail = (msg) => {
  console.error(`CHANGELOG.md: ${msg}`);
  process.exit(1);
};

// Exactly one Unreleased heading. A second one silently strands entries:
// only the first is ever cut, so anything filed under a later heading is
// never released and never reaches the GitHub release notes.
const headings = [...text.matchAll(/^## Unreleased[ \t]*$/gm)];
if (headings.length === 0) {
  fail("no '## Unreleased' section — add one before releasing.");
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
const body = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
if (!/^[ \t]*[-*] /m.test(body)) {
  fail(`'## Unreleased' has no entries — nothing to release as ${version}.`);
}

// Spliced by index rather than string-replaced: `text.replace("## Unreleased", …)`
// would hit the first *substring* occurrence, which is not necessarily the
// heading the regex matched (an inline mention of `## Unreleased` in prose
// comes first) and would inject the version heading into the wrong place.
const date = new Date().toISOString().slice(0, 10);
writeFileSync(
  path,
  text.slice(0, header.index) +
    `## Unreleased\n\n## ${version} — ${date}` +
    text.slice(header.index + header[0].length),
);
console.log(`CHANGELOG.md: cut Unreleased into '## ${version} — ${date}'.`);
