// Black-box coverage of scripts/release-holds.mjs: each case runs the real
// script against a local stand-in for GitHub's issues endpoint, in a
// throwaway directory with its own package.json. The last cases run npm
// itself with this repository's preversion and prepublishOnly entries, so
// the wiring that makes `npm version` and `npm publish` stop is tested too.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/release-holds.mjs", import.meta.url),
);
const PACKAGE_JSON = fileURLToPath(new URL("../../package.json", import.meta.url));
// preversion runs the bump check before the hold check.
const BUMP = fileURLToPath(new URL("../../scripts/release-bump.mjs", import.meta.url));

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

/** Answers every request with `status` and `body`, or with what `body`
 *  gives for the request's URL, recording each request. A `raw` body is
 *  sent as it is, not as JSON. */
async function github(
  status: number,
  body: unknown | ((url: string) => unknown),
  raw = false,
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    seen.push({ url, headers: req.headers });
    res.writeHead(status, { "content-type": "application/json" });
    const answer = typeof body === "function" ? (body as (url: string) => unknown)(url) : body;
    res.end(raw ? String(answer) : JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway directory with this package.json (or this raw text). */
function project(pkg: Record<string, unknown> | string): string {
  const dir = mkdtempSync(join(tmpdir(), "release-holds-"));
  made.push(dir);
  writeFileSync(join(dir, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
  return dir;
}

const PKG = {
  name: "fixture",
  version: "1.0.0",
  repository: { type: "git", url: "git+https://github.com/owner/repo.git" },
};

const HOLD = { number: 300, title: "DefaultErrorPolicy sleeps the provider's retryAfterMs uncapped" };

/** Runs `file` with `args` and only the environment given, so a CI
 *  runner's own GITHUB_REPOSITORY or token can't reach it. */
function exec(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env: { PATH: process.env.PATH ?? "", ...env } }, (error, _stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stderr });
    });
  });
}

const run = (cwd: string, env: Record<string, string>) => exec(process.execPath, [SCRIPT], cwd, env);

test("no open hold: the release goes ahead, asking for the repository package.json names", async () => {
  const gh = await github(200, []);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(gh.seen.length, 1);
    assert.equal(
      gh.seen[0]!.url,
      "/repos/owner/repo/issues?labels=release-hold&state=open&per_page=100&page=1",
    );
    assert.equal(gh.seen[0]!.headers.authorization, undefined);
  } finally {
    await gh.close();
  }
});

test("an open hold stops the release and names it; a labelled pull request isn't a hold", async () => {
  const gh = await github(200, [HOLD, { number: 301, title: "A pull request", pull_request: { url: "x" } }]);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Release held: an open issue is labelled release-hold in owner\/repo \(named by package\.json's repository field\)\./);
    assert.match(result.stderr, /\n  #300 DefaultErrorPolicy sleeps the provider's retryAfterMs uncapped\n/);
    assert.doesNotMatch(result.stderr, /#301/);
    assert.match(result.stderr, /then run this again\. https:\/\/github\.com\/owner\/repo\/issues\?q=/);
  } finally {
    await gh.close();
  }
});

test("only labelled pull requests: the release goes ahead, after asking", async () => {
  const gh = await github(200, [{ number: 301, title: "A pull request", pull_request: { url: "x" } }]);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(gh.seen.length, 1);
  } finally {
    await gh.close();
  }
});

test("several holds are each named", async () => {
  const gh = await github(200, [
    { number: 7, title: "first" },
    { number: 9, title: "second" },
  ]);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Release held: 2 open issues are labelled release-hold/);
    assert.match(result.stderr, /\n  #7 first\n  #9 second\n/);
  } finally {
    await gh.close();
  }
});

test("a hold behind a full page of labelled pull requests still stops the release", async () => {
  const pulls = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, title: "pr", pull_request: {} }));
  const gh = await github(200, (url: string) => (url.endsWith("&page=1") ? pulls : [HOLD]));
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 1);
    assert.deepEqual(gh.seen.map((s) => s.url.replace(/.*&page=/, "")), ["1", "2"]);
    assert.match(result.stderr, /\n  #300 /);
  } finally {
    await gh.close();
  }
});

test("package.json names the repository, though GITHUB_REPOSITORY names another, and GH_TOKEN is sent", async () => {
  const gh = await github(200, []);
  try {
    const result = await run(project(PKG), {
      GITHUB_API_URL: gh.url,
      GITHUB_REPOSITORY: "fork/repo",
      GH_TOKEN: "t0ken",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(gh.seen[0]!.url, /^\/repos\/owner\/repo\/issues\?/);
    assert.equal(gh.seen[0]!.headers.authorization, "Bearer t0ken");
  } finally {
    await gh.close();
  }
});

test("GH_TOKEN is sent when both tokens are set", async () => {
  const gh = await github(200, []);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url, GH_TOKEN: "f1rst", GITHUB_TOKEN: "act1ons" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(gh.seen[0]!.headers.authorization, "Bearer f1rst");
  } finally {
    await gh.close();
  }
});

test("GITHUB_TOKEN alone is sent too", async () => {
  const gh = await github(200, []);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url, GITHUB_TOKEN: "act1ons" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(gh.seen[0]!.headers.authorization, "Bearer act1ons");
  } finally {
    await gh.close();
  }
});

test("each form npm reads in the repository field names the same repository", async () => {
  const forms: unknown[] = [
    "github:owner/repo",
    "github:owner/repo#v1",
    "owner/repo",
    "https://github.com/owner/repo",
    "https://github.com/owner/repo#readme",
    "https://github.com/owner/repo?tab=readme",
    "https://github.com/owner/repo/tree/main/packages/fixture",
    "git@github.com:owner/repo.git",
    { type: "git", url: "git+ssh://git@github.com/owner/repo.git" },
    { type: "git", url: "git+https://github.com/owner/repo.git#main" },
  ];
  const gh = await github(200, []);
  try {
    for (const repository of forms) {
      const result = await run(project({ name: "fixture", repository }), {
        GITHUB_API_URL: gh.url,
        GITHUB_REPOSITORY: "fork/repo",
      });
      assert.equal(result.code, 0, `${JSON.stringify(repository)}: ${result.stderr}`);
      assert.match(gh.seen.at(-1)!.url, /^\/repos\/owner\/repo\/issues\?/, JSON.stringify(repository));
    }
  } finally {
    await gh.close();
  }
});

test("a repository field that names no GitHub repository stops the release, whatever GITHUB_REPOSITORY says", async () => {
  const result = await run(project({ name: "fixture", repository: "gitlab:owner/repo" }), {
    GITHUB_API_URL: "http://127.0.0.1:1",
    GITHUB_REPOSITORY: "fork/repo",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /package\.json's repository field \(gitlab:owner\/repo\) names no GitHub repository this check can ask/);
});

test("GITHUB_REPOSITORY names the repository when package.json names none, or can't be read", async () => {
  const gh = await github(200, []);
  try {
    // No field, a blank one, and a package.json that isn't JSON.
    for (const pkg of [{ name: "fixture" }, { name: "fixture", repository: "" }, { name: "fixture", repository: { url: " " } }, "{ not json"]) {
      const result = await run(project(pkg), {
        GITHUB_API_URL: gh.url,
        GITHUB_REPOSITORY: "other/place",
      });
      assert.equal(result.code, 0, `${JSON.stringify(pkg)}: ${result.stderr}`);
      assert.match(gh.seen.at(-1)!.url, /^\/repos\/other\/place\/issues\?/, JSON.stringify(pkg));
    }
  } finally {
    await gh.close();
  }
});

test("a repository GitHub doesn't know sends the maintainer to the setting that named it", async () => {
  const cases: Array<{ pkg: Record<string, unknown>; says: RegExp }> = [
    { pkg: PKG, says: /no repository owner\/repo is visible without a token; check package\.json's repository field, or set GH_TOKEN/ },
    { pkg: { name: "fixture" }, says: /no repository gone\/place is visible without a token; check GITHUB_REPOSITORY, or set GH_TOKEN/ },
  ];
  for (const { pkg, says } of cases) {
    const gh = await github(404, { message: "Not Found" });
    try {
      const result = await run(project(pkg), { GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "gone/place" });
      assert.equal(result.code, 1);
      assert.match(result.stderr, says);
    } finally {
      await gh.close();
    }
  }
});

test("a package.json that isn't JSON stops the release, saying so", async () => {
  const result = await run(project("{ not json"), { GITHUB_API_URL: "http://127.0.0.1:1" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^release-holds: can't read package\.json \(.+\), and GITHUB_REPOSITORY is unset/);
});

test("a server error stops the release, with a retry", async () => {
  const gh = await github(500, { message: "unavailable" });
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^release-holds: GitHub answered 500 Internal Server Error when asked for the release holds: GitHub had an error; run this again once it answers normally\./);
  } finally {
    await gh.close();
  }
});

test("each refusal says what to do, with and without a token", async () => {
  const cases: Array<{ status: number; env: Record<string, string>; says: RegExp }> = [
    { status: 401, env: { GH_TOKEN: "stale" }, says: /answered 401 Unauthorized .*doesn't accept the token in GH_TOKEN or GITHUB_TOKEN/ },
    { status: 403, env: {}, says: /answered 403 Forbidden .*rate limit for requests without a token; set GH_TOKEN/ },
    { status: 403, env: { GH_TOKEN: "narrow" }, says: /answered 403 Forbidden .*the token in GH_TOKEN or GITHUB_TOKEN can't read this repository's issues/ },
    { status: 404, env: {}, says: /answered 404 Not Found .*no repository owner\/repo is visible without a token; check package\.json's repository field, or set GH_TOKEN/ },
    { status: 404, env: { GH_TOKEN: "narrow" }, says: /answered 404 Not Found .*no repository owner\/repo is visible to the token in GH_TOKEN or GITHUB_TOKEN/ },
    { status: 410, env: {}, says: /answered 410 Gone .*issues are turned off for owner\/repo, so no hold can be filed or read there; turn them on, or point package\.json's repository field at the repository that tracks them/ },
    { status: 429, env: {}, says: /answered 429 Too Many Requests .*rate limit for requests without a token; set GH_TOKEN/ },
    { status: 429, env: { GH_TOKEN: "busy" }, says: /answered 429 Too Many Requests .*or its rate limit is spent/ },
    { status: 418, env: {}, says: /answered 418 I'm a Teapot .*this check doesn't know that answer/ },
  ];
  for (const { status, env, says } of cases) {
    const gh = await github(status, { message: "no" });
    try {
      const result = await run(project(PKG), { GITHUB_API_URL: gh.url, ...env });
      assert.equal(result.code, 1, `${status}`);
      assert.match(result.stderr, says);
    } finally {
      await gh.close();
    }
  }
});

test("an answer that isn't JSON stops the release, saying how to go on", async () => {
  const gh = await github(200, "<html>not json</html>", true);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url, npm_lifecycle_event: "preversion" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^release-holds: couldn't read GitHub's answer \(.+\)\. Check https:\/\/github\.com\/owner\/repo\/issues\?q=\S+, and run npm version again\./);
  } finally {
    await gh.close();
  }
});

test("exactly the most it reads, five thousand labelled items, is read whole; one more stops the release", async () => {
  const full = (from: number) => Array.from({ length: 100 }, (_, i) => ({ number: from + i, title: "pr", pull_request: {} }));
  for (const [last, stops] of [[[], false], [[{ number: 9999, title: "pr", pull_request: {} }], true]] as const) {
    const gh = await github(200, (url: string) => {
      const n = Number(url.replace(/.*&page=/, ""));
      return n <= 50 ? full(n * 100) : last;
    });
    try {
      const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
      assert.equal(gh.seen.length, 51);
      if (stops) {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /^release-holds: more than 5000 open items are labelled release-hold in owner\/repo, more than this check reads\./);
      } else {
        assert.equal(result.code, 0, result.stderr);
      }
    } finally {
      await gh.close();
    }
  }
});

test("an answer that isn't a list stops the release", async () => {
  const gh = await github(200, { message: "not a list" });
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^release-holds: GitHub's answer wasn't a list of issues\./);
  } finally {
    await gh.close();
  }
});

test("GitHub out of reach stops the release, naming why", async () => {
  // A port that was just free, so nothing listens there. Not the discard
  // port: fetch refuses it, and others, as a "bad port" without connecting.
  const gh = await github(200, []);
  await gh.close();
  const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^release-holds: couldn't reach GitHub to read the release holds \(E[A-Z]+\)\. Check \S+, and run this again once GitHub can be reached\./);
});

test("an API URL with a trailing slash asks the same path", async () => {
  const gh = await github(200, []);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: `${gh.url}/` });
    assert.equal(result.code, 0, result.stderr);
    assert.match(gh.seen[0]!.url, /^\/repos\/owner\/repo\/issues\?/);
  } finally {
    await gh.close();
  }
});

test("the stop message says how to go on where it ran", async () => {
  const gh = await github(200, [HOLD]);
  try {
    const workflow = await run(project(PKG), { GITHUB_API_URL: gh.url, GITHUB_ACTIONS: "true" });
    assert.match(workflow.stderr, /then re-run this workflow for the tag\./);
    // npm version comes before any tag, wherever it runs.
    const versionInActions = await run(project(PKG), { GITHUB_API_URL: gh.url, GITHUB_ACTIONS: "true", npm_lifecycle_event: "preversion" });
    assert.match(versionInActions.stderr, /then run npm version again\./);
    const version = await run(project(PKG), { GITHUB_API_URL: gh.url, npm_lifecycle_event: "preversion" });
    assert.match(version.stderr, /then run npm version again\./);
    const publish = await run(project(PKG), { GITHUB_API_URL: gh.url, npm_lifecycle_event: "prepublishOnly" });
    assert.match(publish.stderr, /then run npm publish again\./);
  } finally {
    await gh.close();
  }
});

test("no repository to ask stops the release", async () => {
  const result = await run(project({ name: "fixture" }), { GITHUB_API_URL: "http://127.0.0.1:1" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /names no repository, and GITHUB_REPOSITORY is unset/);
});

/** A throwaway package whose preversion and prepublishOnly are this
 *  repository's own, with the script beside it and a stand-in for the build
 *  that prepublishOnly runs after the check. */
function wiredProject(): string {
  const scripts = (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { scripts: Record<string, string> }).scripts;
  const dir = project({
    ...PKG,
    scripts: { preversion: scripts.preversion, prepublishOnly: scripts.prepublishOnly, build: "node -e 0" },
  });
  mkdirSync(join(dir, "scripts"));
  copyFileSync(SCRIPT, join(dir, "scripts", "release-holds.mjs"));
  copyFileSync(BUMP, join(dir, "scripts", "release-bump.mjs"));
  writeFileSync(join(dir, ".npmrc"), "");
  return dir;
}

/** npm, kept to the throwaway directory: its own cache and user config,
 *  and the stand-in for its registry and GitHub's API. */
function npm(dir: string, args: string[], api: string) {
  // Under `npm test`, npm names its own CLI script in npm_execpath, and this
  // Node runs it: a bare `npm` is npm.cmd on Windows, which execFile can't
  // start without a shell. Another package manager names its own CLI there
  // (bun its binary), so anything but npm's script falls back to the `npm`
  // on PATH.
  const cli = process.env.npm_execpath;
  const [file, argv] = cli && /npm-cli\.c?js$/.test(cli) ? [process.execPath, [cli, ...args]] : ["npm", args];
  return exec(file, argv, dir, {
    HOME: dir,
    npm_config_cache: join(dir, ".npm-cache"),
    npm_config_userconfig: join(dir, ".npmrc"),
    npm_config_registry: api,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    GITHUB_API_URL: api,
  });
}

test("this repository's preversion stops npm version before the bump while a hold is open", async () => {
  const gh = await github(200, [HOLD]);
  try {
    const dir = wiredProject();
    const result = await npm(dir, ["version", "patch", "--no-git-tag-version"], gh.url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /#300 DefaultErrorPolicy/);
    assert.match(result.stderr, /then run npm version again\./);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.0.0");
  } finally {
    await gh.close();
  }
});

test("with no hold open, this repository's preversion lets npm version bump", async () => {
  const gh = await github(200, []);
  try {
    const dir = wiredProject();
    const result = await npm(dir, ["version", "patch", "--no-git-tag-version"], gh.url);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.0.1");
    assert.ok(gh.seen.some((s) => s.url.startsWith("/repos/owner/repo/issues?")));
  } finally {
    await gh.close();
  }
});

test("this repository's prepublishOnly stops npm publish while a hold is open", async () => {
  const gh = await github(200, [HOLD]);
  try {
    const dir = wiredProject();
    const result = await npm(dir, ["publish", "--dry-run"], gh.url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /#300 DefaultErrorPolicy/);
    assert.match(result.stderr, /then run npm publish again\./);
  } finally {
    await gh.close();
  }
});

test("with no hold open, this repository's prepublishOnly lets npm publish go ahead", async () => {
  const gh = await github(200, []);
  try {
    const dir = wiredProject();
    const result = await npm(dir, ["publish", "--dry-run"], gh.url);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(gh.seen.some((s) => s.url.startsWith("/repos/owner/repo/issues?")));
  } finally {
    await gh.close();
  }
});
