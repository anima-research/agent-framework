// Black-box coverage of scripts/pack-installs-alone.mjs: each case runs the
// real script in a throwaway package whose dependencies, if any, are local
// tarballs, so npm packs and installs it offline, with its own cache and
// user config. A `bun` shim in front of PATH decides whether bun is there:
// by default it isn't; BUN_BY_NODE stands bun in with Node under the `bun`
// condition, so a bun target loads as bun would load it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/pack-installs-alone.mjs", import.meta.url));

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
  `#!/bin/sh\n[ "$1" = --version ] && { echo 0.0.0-node; exit 0; }\n[ "$1" = -e ] && exec ${JSON.stringify(process.execPath)} --conditions=bun --input-type=module -e "$2"\nexit 2\n`,
);

/** A directory holding an `npm` that runs `body`, in which `pass()` hands
 *  the call to the npm on PATH. */
function npmShim(body: string): string {
  const real = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
  return shim(
    "npm",
    `#!/usr/bin/env node\nconst { execFileSync } = require("node:child_process");\nconst args = process.argv.slice(2);\nconst pass = () => { try { process.stdout.write(execFileSync(${JSON.stringify(real)}, args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] })); } catch (error) { process.stdout.write(error.stdout ?? ""); process.exit(error.status ?? 1); } };\n${body}\n`,
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

function check(dir: string, bun = NO_BUN, extraPath = "", extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...isolated(), ...extraEnv, PATH: `${extraPath}${bun}:${process.env.PATH ?? ""}` };
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { cwd: dir, env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const ENTRY = { "dist/index.js": "export const ok = true;\n", "dist/extra.js": "export const extra = true;\n" };
const NODE_BIN = "#!/usr/bin/env node\nthrow new Error('zz-serve ran');\n";

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
    /^zz-fixture-1\.0\.0\.tgz \(\d+ files\) installs on its own; every file package\.json's main, types, exports and bin name is in it; loaded '@zz\/fixture' \(import\), '@zz\/fixture\/extra' \(import\), '@zz\/fixture\/package\.json' \(import json\), '@zz\/fixture\/legacy' \(require\), '@zz\/fixture\/dual' \(import\), '@zz\/fixture\/dual' \(require\); bun targets present, not loaded \(bun isn't on PATH\): '@zz\/fixture'; bins start with '#!': zz-serve, zz-shell; ES module bins' static imports load: zz-serve; bins whose '#!' line names no node, not loaded: zz-shell; export patterns matched, not loaded: \.\/parts\/\*\.\n$/m,
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

test("the bin load hook goes in through registerHooks where Node has it, and through register where it doesn't", async () => {
  // A preload that wraps node:module's register and registerHooks, noting
  // each call: the check shows a bin load's output only when the load
  // fails, so a passing check's output can't say which one it called.
  const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone-spy-"));
  made.push(dir);
  const calls = join(dir, "calls.txt");
  writeFileSync(join(dir, "spy.mjs"), `import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
const builtin = createRequire(import.meta.url)("node:module");
for (const name of ["register", "registerHooks"]) {
  const original = builtin[name];
  if (typeof original === "function") builtin[name] = function (...args) { appendFileSync(${JSON.stringify(calls)}, name + "\\n"); return original.apply(this, args); };
}
syncBuiltinESMExports();
`);
  const result = await check(fixture({ files: ["dist"], bin: "./dist/serve.js" }, { "dist/serve.js": NODE_BIN }), NO_BUN, "", {
    NODE_OPTIONS: `--import ${pathToFileURL(join(dir, "spy.mjs")).href}`,
  });
  assert.equal(result.code, 0, result.stderr);
  const hooks = typeof (await import("node:module") as { registerHooks?: unknown }).registerHooks === "function";
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [hooks ? "registerHooks" : "register"]);
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
  const pack = (pkg: Record<string, unknown>, files: Record<string, string>) => {
    const dir = fixture(pkg, files);
    const out = execFileSync("npm", ["pack", "--json", "--pack-destination", tarballs], { cwd: dir, encoding: "utf8", env: isolated() });
    const parsed = JSON.parse(out);
    return join(tarballs, (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0] as { filename: string }).filename);
  };
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

test("a load that outlives its limit fails at the limit even when it handles SIGTERM, and each limit must be a positive whole number", async () => {
  // It ignores SIGTERM and would end on its own only after a minute, so a
  // check that only asked it to stop would take that minute.
  const hang = "process.on('SIGTERM', () => {});\nsetTimeout(() => process.exit(0), 60_000);\nawait new Promise(() => {});\n";
  const limit = { PACK_INSTALLS_ALONE_LOAD_TIMEOUT_MS: "2000" };
  let start = Date.now();
  const root = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, { "dist/index.js": hang }), NO_BUN, "", limit);
  assert.ok(Date.now() - start < 40_000, `took ${Date.now() - start} ms`);
  assert.equal(root.code, 1);
  assert.match(root.stderr, /pack-installs-alone: loading '@zz\/fixture': it didn't finish within 2 s\.\n$/);
  start = Date.now();
  const bin = await check(
    fixture({ files: ["dist"], bin: "./dist/serve.js" }, { "dist/serve.js": "#!/usr/bin/env node\nimport './hang.js';\n", "dist/hang.js": hang }),
    NO_BUN,
    "",
    limit,
  );
  assert.ok(Date.now() - start < 40_000, `took ${Date.now() - start} ms`);
  assert.equal(bin.code, 1);
  assert.match(bin.stderr, /pack-installs-alone: loading bin 'fixture' \(\.\/dist\/serve\.js\) in zz-fixture-1\.0\.0\.tgz didn't finish within 2 s\.\n$/);
  start = Date.now();
  const underBun = await check(
    fixture({ files: ["dist", "src"], exports: { ".": { bun: "./src/index.js", import: "./dist/index.js" } } }, { ...ENTRY, "src/index.js": hang }),
    BUN_BY_NODE,
    "",
    limit,
  );
  assert.ok(Date.now() - start < 40_000, `took ${Date.now() - start} ms`);
  assert.equal(underBun.code, 1);
  assert.match(underBun.stderr, /pack-installs-alone: loading '@zz\/fixture' under bun: it didn't finish within 2 s\.\n$/);
  for (const name of ["PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS", "PACK_INSTALLS_ALONE_LOAD_TIMEOUT_MS"]) {
    for (const value of ["soon", "0"]) {
      const bad = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN, "", { [name]: value });
      assert.equal(bad.code, 1);
      assert.equal(bad.stderr, `pack-installs-alone: ${name} is '${value}': give it a positive whole number of milliseconds.\n`);
    }
  }
});

test("npm pack or npm install that outlives its limit fails at the limit even when it handles SIGTERM", async () => {
  // npm pack runs under the install's limit too, so the install's case
  // leaves the real npm pack room on a loaded runner.
  const hangOn = (command: string) =>
    npmShim(`if (args[0] === ${JSON.stringify(command)}) { process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000); }\nelse pass();`);
  let start = Date.now();
  const install = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN, `${hangOn("install")}:`, {
    PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS: "10000",
  });
  assert.ok(Date.now() - start < 40_000, `took ${Date.now() - start} ms`);
  assert.equal(install.code, 1);
  assert.match(install.stderr, /pack-installs-alone: zz-fixture-1\.0\.0\.tgz didn't install on its own into an empty directory: it didn't finish within 10 s\.\n$/);
  start = Date.now();
  const pack = await check(fixture({ files: ["dist"], main: "./dist/index.js" }, ENTRY), NO_BUN, `${hangOn("pack")}:`, {
    PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS: "2000",
  });
  assert.ok(Date.now() - start < 40_000, `took ${Date.now() - start} ms`);
  assert.equal(pack.code, 1);
  assert.match(pack.stderr, /pack-installs-alone: npm pack didn't finish within 2 s\.\n$/);
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

test("with bun on PATH, a bun target is loaded under bun, and one that doesn't load fails, naming it", async () => {
  const pkg = { files: ["dist", "src"], exports: { ".": { bun: "./src/index.js", import: "./dist/index.js" } } };
  const loads = await check(fixture(pkg, { ...ENTRY, "src/index.js": "export const ok = 'bun';\n" }), BUN_BY_NODE);
  assert.equal(loads.code, 0, loads.stderr);
  assert.match(loads.stdout, /; loaded '@zz\/fixture' \(import\); loaded under bun: '@zz\/fixture'\.\n$/m);
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
  const realNpm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
  const npm12 = shim(
    "npm",
    `#!/usr/bin/env node\nconst { execFileSync } = require("node:child_process");\nconst args = process.argv.slice(2);\ntry {\n  const out = execFileSync(${JSON.stringify(realNpm)}, args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });\n  if (args[0] === "pack" && args.includes("--json")) {\n    const parsed = JSON.parse(out);\n    // npm 12 prints the object already; npm 11's array is rewritten.\n    process.stdout.write(Array.isArray(parsed) ? JSON.stringify({ [parsed[0].name]: parsed[0] }) : out);\n  } else process.stdout.write(out);\n} catch (error) { process.stdout.write(error.stdout ?? ""); process.exit(error.status ?? 1); }\n`,
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
