// Runs as npm's `preversion` lifecycle hook (see package.json), before
// `npm version` bumps anything; as `prepublishOnly`, before `npm publish`;
// and in both of the publish workflow's releasing jobs for the pushed tag.
// Stops the release while the repository has an open issue labelled
// `release-hold`: someone found that releasing `main` as it stands would harm
// whoever runs it, and the issue says what has to happen first.
//
// The repository is the GitHub repository package.json names, as a URL or in
// npm's shorthand, so a fork or a copy asks the package's home;
// GITHUB_REPOSITORY (as in GitHub Actions) is used only when package.json
// names none. A token in GH_TOKEN or GITHUB_TOKEN is sent when present; the
// issues of a public repository read without one. If the holds can't be read,
// the release stops too, since an open hold can't be ruled out.
import { readFileSync, writeSync } from "node:fs";

const LABEL = "release-hold";
const PAGE = 100;
const MAX_PAGES = 50;

function fail(message) {
  // Written synchronously, so a piped stderr has the whole message before
  // the exit.
  writeSync(2, `${message}\n`);
  process.exit(1);
}

/** owner/repo from package.json's repository field: a github.com URL, or
 *  npm's shorthand (github:owner/repo, or owner/repo alone). */
function githubRepository(field) {
  const value = typeof field === "string" ? field : field?.url;
  if (typeof value !== "string" || value.trim() === "") return {};
  const url = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(value);
  if (url) return { repo: url[1] };
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(value);
  if (shorthand) return { repo: shorthand[1] };
  return { unreadable: value };
}

/** The repository to ask, and where it was named, for a message that has to
 *  send a maintainer to the setting that named it. */
function repository() {
  const fromEnvironment = { repo: process.env.GITHUB_REPOSITORY, namedBy: "GITHUB_REPOSITORY" };
  let pkg;
  try {
    pkg = JSON.parse(readFileSync("package.json", "utf8"));
  } catch (error) {
    if (fromEnvironment.repo) return fromEnvironment;
    fail(`release-holds: can't read package.json (${error.message}), and GITHUB_REPOSITORY is unset`);
  }
  const named = githubRepository(pkg.repository);
  if (named.repo) return { repo: named.repo, namedBy: "package.json's repository field" };
  if (named.unreadable) {
    fail(`release-holds: package.json's repository field (${named.unreadable}) names no GitHub repository this check can ask`);
  }
  if (fromEnvironment.repo) return fromEnvironment;
  fail("release-holds: package.json names no repository, and GITHUB_REPOSITORY is unset");
}

const { repo, namedBy } = repository();
const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const where = `https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3A${LABEL}`;

/** What a maintainer can do about an answer other than the list. */
function refusal(status) {
  if (status === 401) {
    return "GitHub doesn't accept the token in GH_TOKEN or GITHUB_TOKEN; replace it, or unset it for a public repository";
  }
  if (status === 403 || status === 429) {
    return token
      ? "the token in GH_TOKEN or GITHUB_TOKEN can't read this repository's issues, or its rate limit is spent; use one that can, or try again later"
      : "this address has used up GitHub's rate limit for requests without a token; set GH_TOKEN to a token that can read the repository's issues, or try again later";
  }
  if (status === 404) {
    return token
      ? `no repository ${repo} is visible to the token in GH_TOKEN or GITHUB_TOKEN; check ${namedBy} and the token's access`
      : `no repository ${repo} is visible without a token; check ${namedBy}, or set GH_TOKEN if the repository is private`;
  }
  if (status >= 500) return "GitHub had an error; run this again once it answers normally";
  return "this check doesn't know that answer; see what GitHub shows";
}

/** One page of the repository's open issues and pull requests with the label. */
async function page(number) {
  let response;
  try {
    response = await fetch(
      `${api}/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=${PAGE}&page=${number}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    const why = error.name === "TimeoutError"
      ? "no answer within 30 s"
      : error.cause?.code ?? error.cause?.message ?? error.message;
    fail(`release-holds: couldn't reach GitHub to read the release holds (${why}). Check ${where}, and run this again once GitHub can be reached.`);
  }
  if (!response.ok) {
    fail(`release-holds: GitHub answered ${`${response.status} ${response.statusText}`.trim()} when asked for the release holds: ${refusal(response.status)}. ${where}`);
  }
  let items;
  try {
    items = await response.json();
  } catch (error) {
    fail(`release-holds: couldn't read GitHub's answer (${error.name === "TimeoutError" ? "no answer within 30 s" : error.message}). Check ${where}, and run this again.`);
  }
  if (!Array.isArray(items)) {
    fail(`release-holds: GitHub's answer wasn't a list of issues. Check ${where}, and run this again.`);
  }
  return items;
}

// The issues endpoint lists pull requests too. A hold is an issue: a pull
// request isn't on main until it merges.
const holds = [];
for (let number = 1; ; number++) {
  if (number > MAX_PAGES) {
    fail(`release-holds: more than ${MAX_PAGES * PAGE} open items are labelled ${LABEL} in ${repo}, more than this check reads. ${where}`);
  }
  const items = await page(number);
  holds.push(...items.filter((item) => !item.pull_request));
  if (items.length < PAGE) break;
}

if (holds.length > 0) {
  const again = process.env.GITHUB_ACTIONS === "true"
    ? "then re-run this workflow for the tag"
    : process.env.npm_lifecycle_event === "preversion"
      ? "then run npm version again"
      : process.env.npm_lifecycle_event === "prepublishOnly"
        ? "then run npm publish again"
        : "then run this again";
  fail(
    [
      `Release held: ${holds.length === 1 ? "an open issue is" : `${holds.length} open issues are`} labelled ${LABEL} in ${repo}.`,
      ...holds.map((hold) => `  #${hold.number} ${hold.title}`),
      `Resolve each one, or close it if it no longer applies, ${again}. ${where}`,
    ].join("\n"),
  );
}
