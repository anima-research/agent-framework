// Black-box coverage of scripts/pack-installs-alone.mjs: each case runs the
// real script in a throwaway package whose dependencies, if any, are local
// tarballs, so npm packs and installs it offline, with its own cache and
// user config. A `bun` shim in front of PATH decides whether bun runs: by
// default it exits 127; BUN_BY_NODE stands bun in with Node under the `bun`
// condition, so a bun target loads as bun would load it, with --single-threaded
// as the script's own loads run. The tests start the real npm as the script
// does (scripts/single-threaded.mjs).
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/pack-installs-alone.mjs", import.meta.url));
const { npmCommand } = (await import(new URL("../../scripts/single-threaded.mjs", import.meta.url).href)) as {
  npmCommand: (cwd?: string, path?: string) => { file: string; args: string[] };
};

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway package: package.json from `pkg`, and `files` (path to text). */
function fixture(pkg: Record<string, unknown>, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone-test-"));
  made.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@zz/fixture", version: "1.0.0", type: "module", ...pkg }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** A directory holding one executable `name` with `text`. */
function shim(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone-shim-"));
  made.push(dir);
  writeFileSync(join(dir, name), text, { mode: 0o755 });
  return dir;
}
const NO_BUN = shim("bun", "#!/bin/sh\nexit 127\n");
const BUN_BY_NODE = shim(
  "bun",
  `#!/bin/sh\n[ "$1" = --version ] && { echo 0.0.0-node; exit 0; }\n[ "$1" = -e ] && exec ${JSON.stringify(process.execPath)} --single-threaded --conditions=bun --input-type=module -e "$2"\nexit 2\n`,
);

/** The npm on PATH, as the script starts it, for a shim to hand calls to: an
 *  npm started by name goes by its absolute path, so a shim in front of it on
 *  PATH doesn't find itself, and a shim in another directory finds it. */
function realNpm(): { file: string; args: string[] } {
  const npm = npmCommand();
  return npm.file === "npm" ? { file: resolvePath(execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim()), args: [] } : npm;
}

/** An npm's source that runs `prelude`, then hands the call to the real npm. */
function npmHandingOn(prelude: string): string {
  const real = realNpm();
  return `#!/usr/bin/env node\n${prelude}const { execFileSync } = require("node:child_process");\ntry { process.stdout.write(execFileSync(${JSON.stringify(real.file)}, [...${JSON.stringify(real.args)}, ...process.argv.slice(2)], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] })); } catch (error) { process.stdout.write(error.stdout ?? ""); process.exit(error.status ?? 1); }\n`;
}

/** A directory holding an `npm` that runs `body`, in which `pass()` hands
 *  the call to the npm on PATH. */
function npmShim(body: string): string {
  const real = realNpm();
  return shim(
    "npm",
    `#!/usr/bin/env node\nconst { execFileSync } = require("node:child_process");\nconst args = process.argv.slice(2);\nconst pass = () => { try { process.stdout.write(execFileSync(${JSON.stringify(real.file)}, [...${JSON.stringify(real.args)}, ...args], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] })); } catch (error) { process.stdout.write(error.stdout ?? ""); process.exit(error.status ?? 1); } };\n${body}\n`,
  );
}

/** npm offline, with its home, cache and user config outside the package,
 *  so npm pack doesn't take them in and nothing of the user's is read. */
function isolated(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "pack-installs-alone-home-"));
  made.push(home);
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    npm_config_cache: join(home, ".npm-cache"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
}

/** How long an npm may take in these tests: the tests' own npm pack, and
 *  the script's npm pack and npm install under check(). It's past their
 *  second or two on a loaded host, and short of the runner's ten-minute
 *  timeout, so a hang in npm says which command it was. The tests' own npm
 *  pack is killed at the limit, not asked to stop. What it started itself
 *  isn't killed with it, and, as with the script's own npm pack, the call
 *  waits on any of that still holding npm's output open. */
const PACK_LIMIT_MS = 120_000;
const NEVER_FIRES_IN_A_TEST_MS = 120_000;

/** Packs the package in `dir` into `tarballs`, offline, starting the npm
 *  `path` names as the script does, and returns the tarball's path. */
function packInto(dir: string, tarballs: string, path = process.env.PATH ?? "", limitMs = PACK_LIMIT_MS): string {
  const npm = npmCommand(dir, path);
  let out: string;
  try {
    out = execFileSync(npm.file, [...npm.args, "pack", "--json", "--pack-destination", tarballs], {
      cwd: dir,
      encoding: "utf8",
      env: { ...isolated(), PATH: path },
      timeout: limitMs,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ETIMEDOUT") throw new Error(`npm pack in ${dir} didn't finish within ${limitMs / 1000} s`);
    throw error;
  }
  const parsed = JSON.parse(out);
  return join(tarballs, (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0] as { filename: string }).filename);
}

/** Runs the script in `dir`. Its npm pack and npm install take PACK_LIMIT_MS,
 *  not the script's own ten minutes, which the runner's timeout equals, so a
 *  hang in either fails with the script's message naming it. A test's own
 *  PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS in `extraEnv` replaces it. */
function check(dir: string, bun = NO_BUN, extraPath = "", extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...isolated(),
    PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS: String(PACK_LIMIT_MS),
    ...extraEnv,
    PATH: `${extraPath}${bun}:${process.env.PATH ?? ""}`,
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { cwd: dir, env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const ENTRY = { "dist/index.js": "export const ok = true;\n", "dist/extra.js": "export const extra = true;\n" };
const NODE_BIN = "#!/usr/bin/env node\nthrow new Error('zz-serve ran');\n";

describe("pack-installs-alone", { concurrency: 4 }, () => {
  test("a package whose files carry everything it names installs alone, and each entry point loads", async () => {
    const dir = fixture(
      {
        files: ["dist", "src"],
        exports: {
          ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./extra": "./dist/extra.js",
          "./package.json": "./package.json",
          "./legacy": { require: "./dist/legacy.cjs" },
          "./dual": { import: "./dist/index.js", require: "./dist/legacy.cjs" },
          "./types": { types: "./dist/types.d.ts" },
          "./internal": null,
          "./parts/*": "./dist/*.js",
        },
        bin: { "zz-serve": "./dist/serve.js", "zz-shell": "./dist/shell.sh" },
      },
      {
        ...ENTRY,
        "src/index.ts": "export const ok = true;\n",
        "dist/index.d.ts": "export declare const ok: boolean;\n",
        "dist/types.d.ts": "export type T = 1;\n",
        "dist/legacy.cjs": "module.exports = { legacy: true };\n",
        "dist/serve.js": NODE_BIN,
        "dist/shell.sh": "#!/bin/sh\necho zz-shell\n",
      },
    );
    const result = await check(dir);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /zz-serve ran/, "a bin is never run");
    assert.match(
      result.stdout,
      /^zz-fixture-1\.0\.0\.tgz \(\d+ files\) installs on its own; every file package\.json's main, types, exports and bin name is in it; loaded '@zz\/fixture' \(import\), '@zz\/fixture\/extra' \(import\), '@zz\/fixture\/package\.json' \(import json\), '@zz\/fixture\/legacy' \(require\), '@zz\/fixture\/dual' \(import\), '@zz\/fixture\/dual' \(require\); bun targets present, not loaded \(bun doesn't run here: bun --version exited 127\): '@zz\/fixture'; bins start with '#!': zz-serve, zz-shell; ES module bins' static imports load: zz-serve; bins whose '#!' line names no node, not loaded: zz-shell; export patterns matched, not loaded: \.\/parts\/\*\.\n$/m,
    );
  });

  test("a string exports, an exports of conditions, an exports array, and main without exports each load as the root", async () => {
    for (const pkg of [
      { files: ["dist"], exports: "./dist/index.js" },
      { files: ["dist"], exports: { import: "./dist/index.js", default: "./dist/index.js" } },
      { files: ["dist"], exports: ["./dist/index.js"] },
      { files: ["dist"], main: "./dist/index.js" },
    ]) {
      const result = await check(fixture(pkg, ENTRY));
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /; loaded '@zz\/fixture' \(import\)\.\n$/m, JSON.stringify(pkg));
    }
  });

  test("a pattern whose target repeats '*', an import blocked by null beside a require, and a JSON main each pass", async () => {
    const repeated = await check(
      fixture({ files: ["dist"], exports: { ".": "./dist/index.js", "./parts/*": "./dist/*/*.js" } }, { ...ENTRY, "dist/a/a.js": "export const a = 1;\n" }),
    );
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /; export patterns matched, not loaded: \.\/parts\/\*\.\n$/m);
    // Node stops at the null that `import` reaches, so a consumer can only require it.
    const blocked = await check(
      fixture(
        { files: ["dist"], exports: { ".": { import: null, require: "./dist/legacy.cjs", default: "./dist/index.js" } } },
        { ...ENTRY, "dist/legacy.cjs": "module.exports = { legacy: true };\n" },
      ),
    );
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.match(blocked.stdout, /; loaded '@zz\/fixture' \(require\)\.\n$/m);
    const json = await check(fixture({ files: ["data.json"], main: "./data.json" }, { "data.json": '{"ok":true}\n' }));
    assert.equal(json.code, 0, json.stderr);
    assert.match(json.stdout, /; loaded '@zz\/fixture' \(import json\)\.\n$/m);
  });

  test("with neither exports nor main, the root is loaded from its index.js, and a bin-only package loads nothing", async () => {
    const fallback = await check(fixture({}, { "index.js": "export const ok = true;\n" }));
    assert.equal(fallback.code, 0, fallback.stderr);
    assert.match(fallback.stdout, /; loaded '@zz\/fixture' \(import\)\.\n$/m);
    const binOnly = await check(fixture({ files: ["dist"], bin: "./dist/serve.js" }, { "dist/serve.js": NODE_BIN }));
    assert.equal(binOnly.code, 0, binOnly.stderr);
    assert.match(binOnly.stdout, /installs on its own; every file package\.json's main, types, exports and bin name is in it; bins start with '#!': fixture; ES module bins' static imports load: fixture\.\n$/m);
  });

  test("a tree that hasn't been built, or a main beside exports that names no file, says so before packing", async () => {
    const main = await check(fixture({ files: ["dist"], main: "./dist/gone.js", exports: "./dist/index.js" }, ENTRY));
    assert.equal(main.code, 1);
    assert.match(main.stderr, /^pack-installs-alone: \.\/dist\/gone\.js \(main\) doesn't exist in this tree/);
    const result = await check(fixture({ files: ["dist"], exports: { ".": "./dist/index.js" }, bin: { "zz-serve": "./dist/serve.js" } }, {}));
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "pack-installs-alone: ./dist/index.js (exports['.']), ./dist/serve.js (bin 'zz-serve') don't exist in this tree, so there is nothing to pack yet: build first (npm run build), or correct what names it.\n",
    );
  });

  test("a file the package names but leaves out of files fails, under any condition", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, string>, RegExp]> = [
      // the bun and types targets of the root, which no import() reads
      [{ files: ["dist"], exports: { ".": { bun: "./src/index.ts", import: "./dist/index.js" } } }, { ...ENTRY, "src/index.ts": "" }, /\.\/src\/index\.ts \(exports\['\.'\]\) isn't in zz-fixture-1\.0\.0\.tgz: add it to package\.json's `files`\./],
      [{ files: ["dist/index.js"], types: "./dist/index.d.ts", exports: "./dist/index.js" }, { ...ENTRY, "dist/index.d.ts": "" }, /\.\/dist\/index\.d\.ts \(types\) isn't in/],
      [{ files: ["dist/index.js"], typings: "./dist/index.d.ts", exports: "./dist/index.js" }, { ...ENTRY, "dist/index.d.ts": "" }, /\.\/dist\/index\.d\.ts \(typings\) isn't in/],
      // a pattern that matches nothing packed
      [{ files: ["dist/index.js"], exports: { ".": "./dist/index.js", "./parts/*": "./parts/*.js" } }, { ...ENTRY, "parts/a.js": "" }, /\.\/parts\/\*\.js \(exports\['\.\/parts\/\*'\], a pattern no packed file matches\) isn't in/],
    ];
    for (const [pkg, files, message] of cases) {
      const result = await check(fixture(pkg, files));
      assert.equal(result.code, 1, JSON.stringify(pkg));
      assert.match(result.stderr, message);
    }
  });

  test("an entry point that doesn't load fails, naming it: a devDependencies-only import, or a subpath's", async () => {
    const devOnly = await check(fixture(
      { files: ["dist"], main: "./dist/index.js", devDependencies: { "zz-dev-only": "1.0.0" } },
      { "dist/index.js": "import 'zz-dev-only';\nexport const ok = true;\n" },
    ));
    assert.equal(devOnly.code, 1);
    assert.match(devOnly.stderr, /Cannot find package 'zz-dev-only'/);
    assert.match(devOnly.stderr, /pack-installs-alone: loading '@zz\/fixture' \(import\) from the installed zz-fixture-1\.0\.0\.tgz failed \(above\)\. A dependency only devDependencies supplied does that, as does a file it imports that the package leaves out, or a dependency's new release \(rerun this on main to tell\)\.\n$/);

    const subpath = await check(fixture(
      { files: ["dist"], exports: { ".": "./dist/index.js", "./extra": "./dist/extra.js" } },
      { ...ENTRY, "dist/extra.js": "import './left-out.js';\n" },
    ));
    assert.equal(subpath.code, 1);
    assert.match(subpath.stderr, /pack-installs-alone: loading '@zz\/fixture\/extra' \(import\) from the installed/);
  });

  test("a bin needs a '#!' line, and a node bin's imports must load; none is run", async () => {
    const noShebang = await check(fixture({ files: ["dist"], main: "./dist/index.js", bin: { "zz-serve": "./dist/serve.js" } }, {
      ...ENTRY, "dist/serve.js": "/**\n * no shebang\n */\nexport {};\n",
    }));
    assert.equal(noShebang.code, 1);
    // npm 10 warns that the linked install is experimental; npm 11.19 and later don't.
    assert.match(
      noShebang.stderr,
      /(^|\n)pack-installs-alone: bin 'zz-serve' \(\.\/dist\/serve\.js\) has no '#!' line, so npm's link can't run it as a command: start its source with '#!\/usr\/bin\/env node'\.\n$/,
    );
    const unparsed = await check(fixture({ files: ["dist"], main: "./dist/index.js", bin: "./dist/serve.js" }, {
      ...ENTRY, "dist/serve.js": "#!/usr/bin/env node\nexport const = ;\n",
    }));
    assert.equal(unparsed.code, 1);
    assert.match(unparsed.stderr, /pack-installs-alone: bin 'fixture' \(\.\/dist\/serve\.js\) in zz-fixture-1\.0\.0\.tgz doesn't load \(above\): a package it imports that only devDependencies supplies does that, as does a file the package leaves out, a syntax error, or a dependency's new release \(rerun this on main to tell\)\.\n$/);
    // A bin whose imports the root never reaches: the root loads, the bin doesn't.
    const devOnlyBin = await check(fixture(
      { files: ["dist"], main: "./dist/index.js", bin: { "zz-serve": "./dist/serve.js" }, devDependencies: { "zz-dev-only": "1.0.0" } },
      { ...ENTRY, "dist/serve.js": "#!/usr/bin/env node\nimport 'zz-dev-only';\nthrow new Error('zz-serve ran');\n" },
    ));
    assert.equal(devOnlyBin.code, 1);
    assert.match(devOnlyBin.stderr, /Cannot find package 'zz-dev-only'/);
    assert.doesNotMatch(devOnlyBin.stderr, /zz-serve ran/);
    assert.match(devOnlyBin.stderr, /pack-installs-alone: bin 'zz-serve' \(\.\/dist\/serve\.js\) in zz-fixture-1\.0\.0\.tgz doesn't load \(above\)/);
    // One whose imports load is never run either, and the hook leaves what it
    // imports alone: a CommonJS one among them doesn't make the bin CommonJS.
    const imports = await check(fixture(
      { files: ["dist"], main: "./dist/index.js", bin: { "zz-serve": "./dist/serve.js" } },
      {
        ...ENTRY,
        "dist/legacy.cjs": "module.exports = { legacy: true };\n",
        "dist/serve.js": "#!/usr/bin/env node\nimport { ok } from './index.js';\nimport legacy from './legacy.cjs';\nthrow new Error('zz-serve ran ' + ok + legacy.legacy);\n",
      },
    ));
    assert.equal(imports.code, 0, imports.stderr);
    assert.doesNotMatch(imports.stderr, /zz-serve ran/);
    assert.match(imports.stdout, /; bins start with '#!': zz-serve; ES module bins' static imports load: zz-serve\.\n$/m);
  });

  test("a CommonJS bin is parsed, never run, whatever marks it CommonJS, and one that doesn't parse fails", async () => {
    const marks = mkdtempSync(join(tmpdir(), "pack-installs-alone-marks-"));
    made.push(marks);
    const bin = (mark: string) =>
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(join(marks, mark))}, "ran");\nconsole.error("zz CommonJS bin ran");\n`;
    // CommonJS by the package's type, and by a .cjs extension in an ES module package.
    for (const [mark, pkg, path] of [
      ["typed", { type: "commonjs", files: ["dist"], main: "./dist/index.cjs", bin: { "zz-cjs": "./dist/serve.js" } }, "dist/serve.js"],
      ["extension", { files: ["dist"], main: "./dist/index.js", bin: { "zz-cjs": "./dist/serve.cjs" } }, "dist/serve.cjs"],
    ] as const) {
      const result = await check(fixture(pkg, { ...ENTRY, "dist/index.cjs": "exports.ok = true;\n", [path]: bin(mark) }));
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /; bins start with '#!': zz-cjs; CommonJS bins parse, not loaded: zz-cjs\.\n$/m);
      assert.equal(existsSync(join(marks, mark)), false, `the ${mark} CommonJS bin ran`);
      assert.doesNotMatch(result.stderr, /zz CommonJS bin ran/);
    }
    const unparsed = await check(fixture(
      { type: "commonjs", files: ["dist"], main: "./dist/index.cjs", bin: { "zz-cjs": "./dist/serve.js" } },
      { "dist/index.cjs": "exports.ok = true;\n", "dist/serve.js": "#!/usr/bin/env node\nconst = ;\n" },
    ));
    assert.equal(unparsed.code, 1);
    assert.match(unparsed.stderr, /pack-installs-alone: bin 'zz-cjs' \(\.\/dist\/serve\.js\) in zz-fixture-1\.0\.0\.tgz doesn't parse \(above\)\.\n$/);
  });

  test("a package imported only through another dependency's copy, or a dependency's peer, fails, since the install is linked", async () => {
    // zz-cm depends on zz-chronicle; the fixture imports zz-chronicle but lists
    // it only in devDependencies, so a hoisted install would hand it zz-cm's.
    const tarballs = mkdtempSync(join(tmpdir(), "pack-installs-alone-deps-"));
    made.push(tarballs);
    const pack = (pkg: Record<string, unknown>, files: Record<string, string>) => packInto(fixture(pkg, files), tarballs);
    const chronicle = pack({ name: "zz-chronicle", main: "./index.js" }, { "index.js": "export const chronicle = true;\n" });
    const cm = pack({ name: "zz-cm", main: "./index.js", dependencies: { "zz-chronicle": `file:${chronicle}` } }, { "index.js": "import 'zz-chronicle';\nexport const cm = true;\n" });
    const imports = { "dist/index.js": "import 'zz-cm';\nimport 'zz-chronicle';\nexport const ok = true;\n" };
    const devOnly = await check(fixture(
      { files: ["dist"], main: "./dist/index.js", dependencies: { "zz-cm": `file:${cm}` }, devDependencies: { "zz-chronicle": `file:${chronicle}` } },
      imports,
    ));
    assert.equal(devOnly.code, 1);
    assert.match(devOnly.stderr, /Cannot find package 'zz-chronicle'/);
    const listed = await check(fixture(
      { files: ["dist"], main: "./dist/index.js", dependencies: { "zz-cm": `file:${cm}`, "zz-chronicle": `file:${chronicle}` } },
      imports,
    ));
    assert.equal(listed.code, 0, listed.stderr);
    // zz-host asks for zz-peer as a peer, which npm installs beside it: a
    // nested install would put it in the fixture's reach too.
    const peer = pack({ name: "zz-peer", main: "./index.js" }, { "index.js": "export const peer = true;\n" });
    const host = pack({ name: "zz-host", main: "./index.js", peerDependencies: { "zz-peer": `file:${peer}` } }, { "index.js": "import 'zz-peer';\nexport const host = true;\n" });
    const peerImports = { "dist/index.js": "import 'zz-host';\nimport 'zz-peer';\nexport const ok = true;\n" };
    const peerOnly = await check(fixture(
      { files: ["dist"], main: "./dist/index.js", dependencies: { "zz-host": `file:${host}` }, devDependencies: { "zz-peer": `file:${peer}` } },
      peerImports,
    ));
    assert.equal(peerOnly.code, 1);
    assert.match(peerOnly.stderr, /Cannot find package 'zz-peer' imported from \S*\/dist\/index\.js/);
    const peerListed = await check(fixture(
      { files: ["dist"], main: "./dist/index.js", dependencies: { "zz-host": `file:${host}`, "zz-peer": `file:${peer}` } },
      peerImports,
    ));
    assert.equal(peerListed.code, 0, peerListed.stderr);
    // A package's own peer is installed beside it, so its import loads.
    const ownPeer = await check(fixture(
      { files: ["dist"], main: "./dist/index.js", peerDependencies: { "zz-peer": `file:${peer}` } },
      { "dist/index.js": "import 'zz-peer';\nexport const ok = true;\n" },
    ));
    assert.equal(ownPeer.code, 0, ownPeer.stderr);
  });

  test("a load, a CommonJS bin's parse or the bun probe that outlives its limit fails at the limit even when it handles SIGTERM, and each limit must be a positive whole number", async () => {
    // Each hang ignores SIGTERM and would end on its own only after a minute,
    // so a check that only asked it to stop would take that minute. It notes
    // once its handler is in: one the limit ended before then would have ended
    // at SIGTERM too, so each case asserts the note, under a limit that leaves
    // a hang room to start on a loaded host.
    const notes = mkdtempSync(join(tmpdir(), "pack-installs-alone-ready-"));
    made.push(notes);
    const ready = (name: string) => join(notes, name);
    const sinceStart = (name: string) => Date.now() - statSync(ready(name)).mtimeMs;
    const hang = (name: string) =>
      `import { writeFileSync } from "node:fs";\nprocess.on('SIGTERM', () => {});\nwriteFileSync(${JSON.stringify(ready(name))}, "");\nsetTimeout(() => process.exit(0), 60_000);\nawait new Promise(() => {});\n`;
    const limit = { PACK_INSTALLS_ALONE_LOAD_TIMEOUT_MS: "5000" };
    const root = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, { "dist/index.js": hang("root") }), NO_BUN, "", limit);
    assert.equal(root.code, 1);
    assert.match(root.stderr, /pack-installs-alone: loading '@zz\/fixture': it didn't finish within 5 s\.\n$/);
    assert.ok(existsSync(ready("root")), "the load was ignoring SIGTERM when the limit came");
    assert.ok(sinceStart("root") < 40_000, `ended ${sinceStart("root")} ms after the hang started`);
    const bin = await check(
      fixture({ files: ["dist"], bin: "./dist/serve.js" }, { "dist/serve.js": "#!/usr/bin/env node\nimport './hang.js';\n", "dist/hang.js": hang("bin") }),
      NO_BUN,
      "",
      limit,
    );
    assert.equal(bin.code, 1);
    assert.match(bin.stderr, /pack-installs-alone: loading bin 'fixture' \(\.\/dist\/serve\.js\) in zz-fixture-1\.0\.0\.tgz didn't finish within 5 s\.\n$/);
    assert.ok(existsSync(ready("bin")), "the bin's load was ignoring SIGTERM when the limit came");
    assert.ok(sinceStart("bin") < 40_000, `ended ${sinceStart("bin")} ms after the hang started`);
    const underBun = await check(
      fixture({ files: ["dist", "src"], exports: { ".": { bun: "./src/index.js", import: "./dist/index.js" } } }, { ...ENTRY, "src/index.js": hang("bun") }),
      BUN_BY_NODE,
      "",
      limit,
    );
    assert.equal(underBun.code, 1);
    assert.match(underBun.stderr, /pack-installs-alone: loading '@zz\/fixture' under bun: it didn't finish within 5 s\.\n$/);
    assert.ok(existsSync(ready("bun")), "the load under bun was ignoring SIGTERM when the limit came");
    assert.ok(sinceStart("bun") < 40_000, `ended ${sinceStart("bun")} ms after the hang started`);
    // A CommonJS bin is only parsed, so the hang is a preload, in --check alone.
    const holdsCheck = join(notes, "holds-check.cjs");
    writeFileSync(
      holdsCheck,
      `if (process.execArgv.includes("--check")) {\n  process.on("SIGTERM", () => {});\n  require("node:fs").writeFileSync(${JSON.stringify(ready("check"))}, "");\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);\n}\n`,
    );
    const parse = await check(
      fixture({ files: ["dist"], bin: "./dist/serve.cjs" }, { "dist/serve.cjs": "#!/usr/bin/env node\nmodule.exports = 1;\n" }),
      NO_BUN,
      "",
      { ...limit, NODE_OPTIONS: `--require ${JSON.stringify(holdsCheck)}` },
    );
    assert.equal(parse.code, 1);
    assert.match(parse.stderr, /pack-installs-alone: checking bin 'fixture' \(\.\/dist\/serve\.cjs\) in zz-fixture-1\.0\.0\.tgz didn't finish within 5 s\.\n$/);
    assert.ok(existsSync(ready("check")), "the bin's --check was ignoring SIGTERM when the limit came");
    assert.ok(sinceStart("check") < 40_000, `ended ${sinceStart("check")} ms after the hang started`);
    // `bun --version` is how the script asks whether bun is there, so this bun hangs there.
    const hangingBun = shim(
      "bun",
      `#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nrequire("node:fs").writeFileSync(${JSON.stringify(ready("bun-version"))}, "");\nsetTimeout(() => {}, 60_000);\n`,
    );
    const probe = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), hangingBun, "", limit);
    assert.equal(probe.code, 1);
    assert.match(probe.stderr, /pack-installs-alone: bun --version didn't finish within 5 s\.\n$/);
    assert.ok(existsSync(ready("bun-version")), "bun --version was ignoring SIGTERM when the limit came");
    assert.ok(sinceStart("bun-version") < 40_000, `ended ${sinceStart("bun-version")} ms after the hang started`);
    for (const name of ["PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS", "PACK_INSTALLS_ALONE_LOAD_TIMEOUT_MS"]) {
      for (const value of ["soon", "0"]) {
        const bad = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN, "", { [name]: value });
        assert.equal(bad.code, 1);
        assert.equal(bad.stderr, `pack-installs-alone: ${name} is '${value}': give it a positive whole number of milliseconds.\n`);
      }
    }
  });

  test("npm pack or npm install that outlives its limit fails at the limit even when it handles SIGTERM", async () => {
    // Each hanging npm notes once its SIGTERM handler is in: one the limit
    // ended before then would have ended at SIGTERM too, so each case asserts
    // the note, under a limit that leaves the npm room to start on a loaded
    // host.
    const notes = mkdtempSync(join(tmpdir(), "pack-installs-alone-ready-"));
    made.push(notes);
    const hangOn = (command: string) =>
      `if (args[0] === ${JSON.stringify(command)}) { process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(join(notes, command))}, ""); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(join(notes, `${command}-outlived`))}, ""), ${NEVER_FIRES_IN_A_TEST_MS}); }`;
    const packed = JSON.stringify([
      { filename: "zz-fixture-1.0.0.tgz", files: [{ path: "package.json" }, { path: "dist/index.js" }, { path: "dist/extra.js" }] },
    ]);
    const install = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN,
      `${npmShim(`${hangOn("install")}\nelse if (args[0] === "pack") process.stdout.write(${JSON.stringify(packed)});\nelse pass();`)}:`, {
        PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS: "10000",
      });
    assert.equal(install.code, 1);
    assert.match(install.stderr, /pack-installs-alone: zz-fixture-1\.0\.0\.tgz didn't install on its own into an empty directory: it didn't finish within 10 s\.\n$/);
    assert.ok(existsSync(join(notes, "install")), "npm install was ignoring SIGTERM when the limit came");
    assert.ok(!existsSync(join(notes, "install-outlived")), "npm install, ignoring SIGTERM, outlived the limit");
    const pack = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN, `${npmShim(`${hangOn("pack")}\nelse pass();`)}:`, {
      PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS: "5000",
    });
    assert.equal(pack.code, 1);
    assert.match(pack.stderr, /pack-installs-alone: npm pack didn't finish within 5 s\.\n$/);
    assert.ok(existsSync(join(notes, "pack")), "npm pack was ignoring SIGTERM when the limit came");
    assert.ok(!existsSync(join(notes, "pack-outlived")), "npm pack, ignoring SIGTERM, outlived the limit");
  });

  test("an npm pack that fails without timing out fails the check, pointing to npm's own output", async () => {
    // The npm fails at once, so nothing is packed.
    const npm = shim("npm", "#!/usr/bin/env node\nprocess.exit(3);\n");
    const result = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN, `${npm}:`);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /pack-installs-alone: npm pack failed \(its output is above\)\.\n$/);
  });

  /** A file each Node that loads `noteFlags` adds the flags it started with to,
   *  one JSON array a line, and its reader. */
  function flagNotes(): { path: string; read: () => string[][]; noteFlags: string } {
    const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone-flags-"));
    made.push(dir);
    const path = join(dir, "flags");
    return {
      path,
      read: () => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]),
      noteFlags: `require("node:fs").appendFileSync(${JSON.stringify(path)}, JSON.stringify(process.execArgv) + "\\n");\n`,
    };
  }

  test("npmCommand takes the first executable npm on PATH, read from the child's directory, under this Node where it's JavaScript, and goes by name otherwise", () => {
    const dirWith = (name: string, mode = 0o755): string => {
      const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone-path-"));
      made.push(dir);
      writeFileSync(join(dir, name), "", { mode });
      return dir;
    };
    /** A directory whose `npm` links to `target`, as bin/npm links to npm-cli.js. */
    const linkTo = (target: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone-path-"));
      made.push(dir);
      symlinkSync(target, join(dir, "npm"));
      return dir;
    };
    const byName = { file: "npm", args: [] };
    // By the path it was found at, not its real path, as a start by name runs it.
    const underNode = (dir: string) => ({ file: process.execPath, args: ["--single-threaded", join(dir, "npm")] });
    const cwd = mkdtempSync(join(tmpdir(), "pack-installs-alone-cwd-"));
    made.push(cwd);
    for (const name of ["npm-cli.js", "npm-cli.cjs", "npm-cli.mjs"]) {
      const dir = linkTo(join(dirWith(name), name));
      assert.deepEqual(npmCommand(cwd, dir), underNode(dir), name);
    }
    const cli = join(dirWith("npm-cli.js"), "npm-cli.js");
    const js = linkTo(cli);
    // An npm that can't be run, and a directory named npm, are passed over, as a shell passes them.
    const directory = mkdtempSync(join(tmpdir(), "pack-installs-alone-path-"));
    made.push(directory);
    mkdirSync(join(directory, "npm"));
    assert.deepEqual(npmCommand(cwd, [dirWith("npm", 0o644), directory, js].join(delimiter)), underNode(js));
    // The first npm that runs decides: one that isn't JavaScript goes by name.
    assert.deepEqual(npmCommand(cwd, [dirWith("npm"), js].join(delimiter)), byName);
    // A relative or empty entry is read from the child's directory: passed over
    // where it holds no npm, and taken where it does.
    mkdirSync(join(cwd, "tools"));
    assert.deepEqual(npmCommand(cwd, ["tools", js].join(delimiter)), underNode(js));
    assert.deepEqual(npmCommand(cwd, ["", js].join(delimiter)), underNode(js));
    symlinkSync(cli, join(cwd, "tools", "npm"));
    assert.deepEqual(npmCommand(cwd, ["tools", js].join(delimiter)), underNode(join(cwd, "tools")));
    symlinkSync(cli, join(cwd, "npm"));
    assert.deepEqual(npmCommand(cwd, ["", js].join(delimiter)), underNode(cwd));
    // A PATH with no npm goes by name, and so does an unset PATH, which the
    // child reads as its default path, even where its directory holds an npm.
    assert.deepEqual(npmCommand(cwd, dirWith("not-npm")), byName);
    const saved = process.env.PATH;
    delete process.env.PATH;
    try {
      assert.deepEqual(npmCommand(cwd), byName);
    } finally {
      if (saved !== undefined) process.env.PATH = saved;
    }
  });

  test("npm starts under this Node with --single-threaded where PATH's npm is a JavaScript file, and by name otherwise, in the script and in the tests' own pack", async () => {
    const notes = flagNotes();
    const noting = npmHandingOn(notes.noteFlags);
    // As an npm installed with Node is: bin/npm links to a JavaScript file.
    const cli = shim("npm-cli.cjs", noting);
    const linked = mkdtempSync(join(tmpdir(), "pack-installs-alone-shim-"));
    made.push(linked);
    symlinkSync(join(cli, "npm-cli.cjs"), join(linked, "npm"));
    // Any other npm, here the same source not named as JavaScript.
    const other = shim("npm", noting);
    const tarballs = mkdtempSync(join(tmpdir(), "pack-installs-alone-deps-"));
    made.push(tarballs);
    for (const [npmDir, flags] of [[linked, ["--single-threaded"]], [other, []]] as const) {
      rmSync(notes.path, { force: true });
      const result = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN, `${npmDir}:`);
      assert.equal(result.code, 0, result.stderr);
      packInto(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), tarballs, `${npmDir}${delimiter}${process.env.PATH ?? ""}`);
      assert.deepEqual(notes.read(), [flags, flags, flags], `${npmDir === linked ? "a JavaScript npm" : "another npm"}: the script's npm pack and npm install, then the tests' own npm pack`);
    }
  });

  test("npm pack, npm install and the tests' own npm pack each take the npm their child finds on PATH from its own directory", async () => {
    const notes = flagNotes();
    // The script runs npm pack in the package's directory, which holds a
    // JavaScript npm under tools/, and npm install in a new one, which doesn't.
    const dir = fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY);
    mkdirSync(join(dir, "tools"));
    writeFileSync(join(dir, "tools", "npm-cli.cjs"), npmHandingOn(notes.noteFlags), { mode: 0o755 });
    symlinkSync("npm-cli.cjs", join(dir, "tools", "npm"));
    const result = await check(dir, NO_BUN, "tools:");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(notes.read(), [["--single-threaded"]], "npm pack ran tools/npm under the flag, and npm install the npm further on PATH");
    // The tests' own npm pack, run in the package's directory, takes it too.
    const tarballs = mkdtempSync(join(tmpdir(), "pack-installs-alone-deps-"));
    made.push(tarballs);
    packInto(dir, tarballs, `tools${delimiter}${process.env.PATH ?? ""}`);
    assert.deepEqual(notes.read(), [["--single-threaded"], ["--single-threaded"]], "the tests' own npm pack ran tools/npm under the flag");
  });

  test("each load, each bin's load, a CommonJS bin's --check and a JavaScript npm start under --single-threaded, and they are all the Nodes the script starts", async () => {
    // A preload that notes each Node's flags and main file: NODE_OPTIONS reaches
    // every Node the script starts, and a preload runs under --check too. It
    // notes on the main thread alone, since a thread of the process runs it
    // too, as the load hook's does where Node lacks registerHooks (Node 20).
    // Its directory's name has a space, so NODE_OPTIONS takes its path quoted.
    const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone flags-"));
    made.push(dir);
    const notes = join(dir, "flags");
    const noter = join(dir, "note.cjs");
    writeFileSync(noter, `if (require("node:worker_threads").isMainThread) require("node:fs").appendFileSync(${JSON.stringify(notes)}, JSON.stringify({ flags: process.execArgv, main: process.argv[1] ?? "" }) + "\\n");\n`);
    // A JavaScript npm first on PATH, as an npm installed with Node is, that
    // hands each call to the real npm without NODE_OPTIONS, so each npm start
    // is noted once, whatever the host's own npm is.
    const cli = shim("npm-cli.cjs", npmHandingOn("delete process.env.NODE_OPTIONS;\n"));
    const linked = mkdtempSync(join(tmpdir(), "pack-installs-alone-shim-"));
    made.push(linked);
    symlinkSync(join(cli, "npm-cli.cjs"), join(linked, "npm"));
    const pkg = fixture(
      {
        files: ["dist"],
        exports: { ".": { import: "./dist/index.js", require: "./dist/index.cjs" } },
        bin: { "zz-serve": "./dist/serve.js", "zz-old": "./dist/old.cjs" },
      },
      {
        "dist/index.js": "export const ok = true;\n",
        "dist/index.cjs": "module.exports = { ok: true };\n",
        "dist/serve.js": NODE_BIN,
        "dist/old.cjs": "#!/usr/bin/env node\nmodule.exports = 1;\n",
      },
    );
    const result = await check(pkg, NO_BUN, `${linked}:`, { NODE_OPTIONS: `--require ${JSON.stringify(noter)}` });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /loaded '@zz\/fixture' \(import\), '@zz\/fixture' \(require\).*ES module bins' static imports load: zz-serve; CommonJS bins parse, not loaded: zz-old/);
    type Start = { flags: string[]; main: string };
    const [script, ...children] = readFileSync(notes, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Start);
    // The first note is the script's own, which check() starts as CI does, without the flag.
    assert.ok(script.main.endsWith("pack-installs-alone.mjs"), JSON.stringify(script));
    const kinds: Array<[string, (one: Start) => boolean, number]> = [
      ["the import load", (one) => one.flags.includes("--input-type=module"), 1],
      ["the require load", (one) => one.flags.includes("-e") && !one.flags.includes("--input-type=module"), 1],
      ["each bin's load", (one) => one.flags.includes("--import"), 2],
      ["the CommonJS bin's --check", (one) => one.flags.includes("--check"), 1],
      ["npm pack and npm install", (one) => one.main === join(linked, "npm"), 2],
    ];
    for (const [name, is, count] of kinds) {
      const ofKind = children.filter(is);
      assert.equal(ofKind.length, count, name);
      for (const one of ofKind) assert.ok(one.flags.includes("--single-threaded"), `${name}: ${JSON.stringify(one)}`);
    }
    // Each Node the script starts for this package, each with the script's
    // environment and so the preload, is of exactly one kind, so the counts
    // above are all of them.
    for (const one of children) assert.equal(kinds.filter(([, is]) => is(one)).length, 1, JSON.stringify(one));
  });

  test("the tests' own npm pack fails at its limit, naming the command and its directory, and other failures stay npm's", () => {
    const notes = mkdtempSync(join(tmpdir(), "pack-installs-alone-ready-"));
    made.push(notes);
    const ready = join(notes, "ready");
    const hangs = npmShim(`if (args[0] === "pack") { process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""); setTimeout(() => {}, 60_000); }\nelse pass();`);
    const dir = fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY);
    const tarballs = mkdtempSync(join(tmpdir(), "pack-installs-alone-deps-"));
    made.push(tarballs);
    const start = Date.now();
    assert.throws(() => packInto(dir, tarballs, `${hangs}${delimiter}${process.env.PATH ?? ""}`, 5000), { message: `npm pack in ${dir} didn't finish within 5 s` });
    // It was ignoring SIGTERM when the limit came, so only the limit's SIGKILL
    // could stop it short of its own minute.
    assert.ok(existsSync(ready), "the npm was hanging, ignoring SIGTERM, when the limit came");
    assert.ok(Date.now() - start < 30_000, `took ${Date.now() - start} ms`);
    // An npm pack that fails is npm's failure, not a time limit's.
    const fails = npmShim(`if (args[0] === "pack") process.exit(3);\nelse pass();`);
    assert.throws(
      () => packInto(dir, tarballs, `${fails}${delimiter}${process.env.PATH ?? ""}`),
      (error: { status?: number; message: string }) => error.status === 3 && !error.message.includes("didn't finish"),
    );
  });

  test("a null in an exports array gives way to the next item, and a target only node-addons or module-sync names is loaded on a Node that matches it", async () => {
    const devOnly = { devDependencies: { "zz-dev-only": "1.0.0" } };
    const array = await check(fixture(
      { files: ["dist"], exports: [null, "./dist/index.js"], ...devOnly },
      { "dist/index.js": "import 'zz-dev-only';\nexport const ok = true;\n" },
    ));
    assert.equal(array.code, 1);
    assert.match(array.stderr, /Cannot find package 'zz-dev-only'/);
    // Node matches node-addons unless it runs with --no-addons, which the
    // check's loads don't.
    const addons = await check(fixture(
      { files: ["dist"], exports: { ".": { "node-addons": "./dist/addons.js" } }, ...devOnly },
      { "dist/addons.js": "import 'zz-dev-only';\nexport const ok = true;\n" },
    ));
    assert.equal(addons.code, 1);
    assert.match(addons.stderr, /Cannot find package 'zz-dev-only'/);
    // With no other condition beside it, only module-sync leads to this target.
    const sync = await check(fixture(
      { files: ["dist"], exports: { ".": { "module-sync": "./dist/sync.js" } }, ...devOnly },
      { "dist/sync.js": "import 'zz-dev-only';\nexport const ok = true;\n" },
    ));
    if ((process.features as { require_module?: boolean }).require_module) {
      assert.equal(sync.code, 1);
      assert.match(sync.stderr, /Cannot find package 'zz-dev-only'/);
    } else {
      assert.equal(sync.code, 0, sync.stderr);
    }
    // require() matches node-addons too, so a target only it names, beside an
    // import target, is required.
    const required = await check(fixture(
      { files: ["dist"], exports: { ".": { import: "./dist/index.js", "node-addons": "./dist/addons.cjs" } }, ...devOnly },
      { "dist/index.js": "export const ok = true;\n", "dist/addons.cjs": "require('zz-dev-only');\n" },
    ));
    assert.equal(required.code, 1);
    assert.match(required.stderr, /Cannot find module 'zz-dev-only'/);
    // So does module-sync, on a Node that can require ES modules: beside an
    // import target, a target only module-sync names is required.
    const syncRequired = await check(fixture(
      { files: ["dist"], exports: { ".": { import: "./dist/index.js", "module-sync": "./dist/sync.js" } }, ...devOnly },
      { "dist/index.js": "export const ok = true;\n", "dist/sync.js": "import 'zz-dev-only';\nexport const ok = true;\n" },
    ));
    if ((process.features as { require_module?: boolean }).require_module) {
      assert.equal(syncRequired.code, 1);
      assert.match(syncRequired.stderr, /\(require\) from the installed/);
      assert.match(syncRequired.stderr, /Cannot find package 'zz-dev-only'/);
    } else {
      assert.equal(syncRequired.code, 0, syncRequired.stderr);
    }
  });

  test("an import that a null, an array of nulls or an empty array blocks isn't attempted, and require() still loads the default", async () => {
    for (const blocked of [null, [null], []]) {
      const result = await check(fixture(
        { files: ["dist"], exports: { ".": { import: blocked, default: "./dist/index.cjs" } } },
        { "dist/index.cjs": "module.exports = { ok: true };\n" },
      ));
      assert.equal(result.code, 0, `${JSON.stringify(blocked)}: ${result.stderr}`);
      assert.match(result.stdout, /; loaded '@zz\/fixture' \(require\)\.\n$/m);
    }
  });

  test("with bun on PATH, a bun target is loaded under bun, one that doesn't load fails, naming it, and a bun that doesn't run leaves it unloaded, saying how", async () => {
    const pkg = { files: ["dist", "src"], exports: { ".": { bun: "./src/index.js", import: "./dist/index.js" } } };
    const loads = await check(fixture(pkg, { ...ENTRY, "src/index.js": "export const ok = 'bun';\n" }), BUN_BY_NODE);
    assert.equal(loads.code, 0, loads.stderr);
    assert.match(loads.stdout, /; loaded '@zz\/fixture' \(import\); loaded under bun: '@zz\/fixture'\.\n$/m);
    // A bun that crashes when asked --version doesn't run here; a bun that exits is NO_BUN's case.
    const crashed = await check(fixture(pkg, { ...ENTRY, "src/index.js": "export const ok = 'bun';\n" }), shim("bun", "#!/bin/sh\nkill -ILL $$\n"));
    assert.equal(crashed.code, 0, crashed.stderr);
    assert.match(crashed.stdout, /; bun targets present, not loaded \(bun doesn't run here: bun --version was killed by SIGILL\): '@zz\/fixture'\.\n$/m);
    const broken = await check(fixture(pkg, { ...ENTRY, "src/index.js": "import './left-out.js';\n" }), BUN_BY_NODE);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /pack-installs-alone: loading '@zz\/fixture' under bun \(from the installed zz-fixture-1\.0\.0\.tgz\) failed, as its output above shows\. A file it imports that the package leaves out does that, a dependency only devDependencies supplied, or a dependency's new release \(rerun this on main to tell\)\.\n$/);
  });

  test("the declaration the build wrote beside a packed module, left out of files, fails, whether types, typings or a types condition gives the package types, and exports: null falls back to main", async () => {
    const declarations = { "dist/index.d.ts": "export * from './extra.js';\n", "dist/extra.d.ts": "export declare const extra: boolean;\n" };
    for (const typed of [
      { types: "./dist/index.d.ts" },
      { typings: "./dist/index.d.ts" },
      { exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } },
    ]) {
      const result = await check(fixture({ files: ["dist/**/*.js", "dist/index.d.ts"], main: "./dist/index.js", ...typed }, { ...ENTRY, ...declarations }));
      assert.equal(result.code, 1, JSON.stringify(typed));
      assert.match(result.stderr, /: dist\/extra\.d\.ts \(the declaration beside dist\/extra\.js\) isn't in zz-fixture-1\.0\.0\.tgz/);
    }
    const nullExports = await check(fixture({ files: ["dist"], main: "./dist/index.js", exports: null }, ENTRY));
    assert.equal(nullExports.code, 0, nullExports.stderr);
    assert.match(nullExports.stdout, /; loaded '@zz\/fixture' \(import\)\.\n$/m);
  });

  test("no declaration is required beside a module the package doesn't pack, or in a package without types", async () => {
    // A root-level types, with a packed module and its declaration beside it,
    // and a test's and a dependency's declarations, which stay out.
    const root = await check(fixture(
      { files: ["index.js", "index.d.ts", "lib.js", "lib.d.ts"], main: "./index.js", types: "./index.d.ts" },
      {
        "index.js": "export * from './lib.js';\n",
        "index.d.ts": "export * from './lib.js';\n",
        "lib.js": "export const ok = true;\n",
        "lib.d.ts": "export declare const ok: boolean;\n",
        "test/helper.js": "export {};\n",
        "test/helper.d.ts": "export {};\n",
        "node_modules/zz-dep/index.d.ts": "export {};\n",
      },
    ));
    assert.equal(root.code, 0, root.stderr);
    // Without types, a declaration the build wrote may stay out.
    const untyped = await check(fixture({ files: ["dist/**/*.js"], main: "./dist/index.js" }, { ...ENTRY, "dist/index.d.ts": "export declare const ok: boolean;\n" }));
    assert.equal(untyped.code, 0, untyped.stderr);
  });

  test("npm pack output that isn't one record with a filename and its files fails, saying so", async () => {
    for (const printed of ["zz: not JSON", JSON.stringify({ "@zz/fixture": { filename: "zz-fixture-1.0.0.tgz" } })]) {
      const npm = shim("npm", `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(printed)}\n`);
      const result = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN, `${npm}:`);
      assert.equal(result.code, 1, printed);
      assert.equal(result.stderr, `${printed}\npack-installs-alone: npm pack --json didn't print one record with a filename and its files (its output is above).\n`);
    }
  });

  test("npm pack's JSON is read in npm 12's shape too, and a prepack's output doesn't break it", async () => {
    // npm 12 prints an object keyed by package name: a shim in front of the
    // real npm rewrites npm 11's array that way, and passes npm 12's through.
    const real = realNpm();
    const npm12 = shim(
      "npm",
      `#!/usr/bin/env node\nconst { execFileSync } = require("node:child_process");\nconst args = process.argv.slice(2);\ntry {\n  const out = execFileSync(${JSON.stringify(real.file)}, [...${JSON.stringify(real.args)}, ...args], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });\n  if (args[0] === "pack" && args.includes("--json")) {\n    const parsed = JSON.parse(out);\n    // npm 12 prints the object already; npm 11's array is rewritten.\n    process.stdout.write(Array.isArray(parsed) ? JSON.stringify({ [parsed[0].name]: parsed[0] }) : out);\n  } else process.stdout.write(out);\n} catch (error) { process.stdout.write(error.stdout ?? ""); process.exit(error.status ?? 1); }\n`,
    );
    const twelve = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN, `${npm12}:`);
    assert.equal(twelve.code, 0, twelve.stderr);
    assert.match(twelve.stdout, /^zz-fixture-1\.0\.0\.tgz \(\d+ files\) installs on its own;/m);
    const chatty = await check(fixture({ files: ["dist"], main: "./dist/index.js", scripts: { prepack: "echo zz: packing" } }, ENTRY));
    assert.equal(chatty.code, 0, chatty.stderr);
  });

  test("a dependency that can't be installed fails the install, saying what does that", async () => {
    const result = await check(fixture(
      { files: ["dist"], main: "./dist/index.js", dependencies: { "zz-not-on-the-registry": "1.0.0" } },
      ENTRY,
    ));
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /pack-installs-alone: zz-fixture-1\.0\.0\.tgz didn't install on its own into an empty directory \(npm's output is above\)\. A dependency that isn't on the registry does that, or a registry or network error, which a re-run gets past\.\n$/,
    );
  });
});
