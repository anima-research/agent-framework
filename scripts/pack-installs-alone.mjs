// Packs this package as `npm publish` packs it, installs the tarball alone
// into an empty directory with its dependencies from the registry, and
// checks, under the Node that runs this, what the installed package.json
// offers. The install is nested (npm's --install-strategy nested), which is
// stricter than npm's default: the package reaches only its own
// dependencies, so a package it imports but only devDependencies lists
// fails to load even when another dependency brings that package in.
//   - every file its `main`, `types` (or `typings`), `exports` and `bin`
//     name is in the package: each `exports` target under every condition
//     (the `bun` and `types` targets too), at least one file for each export
//     pattern, and each `bin`; and, in a package with types (`types`,
//     `typings` or a `types` condition), so is the `.d.ts` the build wrote
//     beside each `.js` it packs;
//   - each entry point loads as a consumer loads it: the root and each
//     subpath, patterns aside, through import() (a JSON target with its
//     import attribute), and through require() where `require` picks a file
//     import() doesn't; and, when bun is on PATH, each one with a `bun`
//     condition through bun's import() of its name;
//   - each bin starts with a `#!` line, without which npm's link can't run
//     it as a command, and an ES module node bin's static imports load.
//     Bins aren't run: a load hook makes the bin throw as soon as its
//     imports have loaded, before its own code, which for the MCP server
//     would start it. A CommonJS bin's requires run with its code, so the
//     hook stops it before it loads, and it's only parsed (`node --check`).
//     A bin whose `#!` line names no node is checked for that line alone.
// Before packing it checks that the files package.json names exist in this
// tree, so an unbuilt tree says so rather than looking like a packaging
// fault. The publish workflow runs it after its build and before
// `npm publish` (which builds again from the same sources first); to check
// by hand, run `npm run build` and then this, from the repository root.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const LOAD_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
// What the load hook makes an ES module bin throw once its imports have
// loaded, and what it throws in place of loading a bin that isn't one.
const LINKED = "__pack_installs_alone_linked__";
const NOT_MODULE = "__pack_installs_alone_not_module__";
const HOOK = `export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== process.env.PACK_INSTALLS_ALONE_BIN) return result;
  // A CommonJS bin's requires run with its code, so it isn't loaded at all.
  if (result.format !== "module") throw new Error("${NOT_MODULE}");
  // Only a bin whose first line starts with '#!' gets here.
  const lines = String(result.source).split("\\n");
  lines.splice(1, 0, 'throw "${LINKED}";');
  return { ...result, source: lines.join("\\n") };
}
`;

class CheckError extends Error {}

/** The target a set of conditions picks from an exports value, as Node
 *  resolves it: the first key, in order, that is active or `default`. A
 *  `null` it reaches blocks the subpath for those conditions, so it answers
 *  null, which stops the search as Node's does; undefined means no key
 *  matched. */
function pick(value, conditions) {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pick(item, conditions);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "default" || conditions.includes(key)) {
        const found = pick(inner, conditions);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

/** Every file target an exports value names, under any condition (an
 *  array's items are its values). */
function allTargets(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") for (const inner of Object.values(value)) allTargets(inner, out);
  return out;
}

/** The package's subpaths, `.` included, each with its exports value: an
 *  exports that names no subpath (a string, an array, or an object of
 *  conditions, none of whose keys starts with '.') is the root's. A null
 *  subpath, which blocks its path, names no file and loads nothing. */
function subpaths(exports) {
  if (exports == null) return [];
  if (!Object.keys(exports).some((key) => key.startsWith("."))) return [[".", exports]];
  return Object.entries(exports);
}

/** `bin` as npm reads it: a path for the package's own name, or a map. */
function binsOf(pkg) {
  if (typeof pkg.bin === "string") return { [pkg.name.split("/").pop()]: pkg.bin };
  return pkg.bin && typeof pkg.bin === "object" ? pkg.bin : {};
}

/** The files package.json names (pattern exports aside), each with what names it. */
function namedFiles(pkg) {
  const named = [];
  if (typeof pkg.main === "string") named.push([pkg.main, "main"]);
  for (const field of ["types", "typings"]) if (typeof pkg[field] === "string") named.push([pkg[field], field]);
  for (const [key, value] of subpaths(pkg.exports)) {
    if (key.includes("*")) continue;
    for (const target of allTargets(value)) named.push([target, `exports['${key}']`]);
  }
  for (const [bin, path] of Object.entries(binsOf(pkg))) named.push([path, `bin '${bin}'`]);
  return named;
}

/** Whether an exports value names `condition` anywhere (an array's keys
 *  are its indexes). */
function hasCondition(value, condition) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, inner]) => key === condition || hasCondition(inner, condition));
}

/** Whether `bun` runs here. */
function bunOnPath() {
  return spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Runs a command with its output going to ours; a failure throws `message`. */
function run(file, args, options, message) {
  try {
    execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
  } catch (error) {
    throw new CheckError(error?.code === "ETIMEDOUT" ? `${message.split(" (")[0]}: it didn't finish within ${options.timeout / 1000} s.` : message);
  }
}

function main() {
  const source = JSON.parse(readFileSync("package.json", "utf8"));
  const unbuilt = namedFiles(source).filter(([path]) => !existsSync(path));
  if (unbuilt.length > 0) {
    throw new CheckError(
      `${unbuilt.map(([path, by]) => `${path} (${by})`).join(", ")} ${unbuilt.length === 1 ? "doesn't" : "don't"} exist in this tree, ` +
        "so there is nothing to pack yet: build first (npm run build), or correct what names it.",
    );
  }
  const work = mkdtempSync(join(tmpdir(), "pack-installs-alone-"));
  try {
    let out = "";
    try {
      // Lifecycle scripts' output would land ahead of the JSON in the
      // foreground, so they run in the background.
      out = execFileSync("npm", ["pack", "--json", "--foreground-scripts=false", "--pack-destination", work], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      if (error?.stdout) process.stderr.write(error.stdout);
      throw new CheckError("npm pack failed (its output is above).");
    }
    // npm 11 prints an array of records, npm 12 an object keyed by name.
    let records;
    try {
      const parsed = JSON.parse(out);
      records = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
    } catch {
      records = [];
    }
    if (records.length !== 1 || typeof records[0]?.filename !== "string" || !Array.isArray(records[0]?.files)) {
      process.stderr.write(out);
      throw new CheckError("npm pack --json didn't print one record with a filename and its files (its output is above).");
    }
    const packed = records[0];
    const files = packed.files.map((file) => file.path);
    const tarball = join(work, packed.filename);
    const dir = join(work, "install");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pack-installs-alone", private: true }));
    run(
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-package-lock", "--install-strategy=nested", tarball],
      { cwd: dir, timeout: INSTALL_TIMEOUT_MS },
      `${packed.filename} didn't install on its own into an empty directory (npm's output is above). A dependency ` +
        "that isn't on the registry does that, or a registry or network error, which a re-run gets past.",
    );
    const installed = join(dir, "node_modules", ...source.name.split("/"));
    // What a consumer reads: the manifest in the tarball.
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));

    // This tree has each named file (checked before packing), so one the
    // package lacks is one `files` leaves out.
    const named = namedFiles(pkg);
    const missing = named.filter(([path]) => !existsSync(join(installed, path)));
    // A consumer's TypeScript reads the declaration beside each module it
    // reaches, so a package with types carries the one the build wrote
    // beside each module it packs. A named one was checked above.
    if (typeof pkg.types === "string" || typeof pkg.typings === "string" || hasCondition(pkg.exports, "types")) {
      const checked = new Set([...files, ...named.map(([path]) => relative(".", path))]);
      for (const file of files) {
        const declaration = file.replace(/\.js$/, ".d.ts");
        if (declaration !== file && !checked.has(declaration) && existsSync(declaration)) {
          missing.push([declaration, `the declaration beside ${file}`]);
        }
      }
    }
    for (const [key, value] of subpaths(pkg.exports)) {
      if (!key.includes("*")) continue;
      for (const target of allTargets(value)) {
        // Node puts the same text in place of every `*` in a target.
        const parts = target.replace(/^\.\//, "").split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const matches = new RegExp(`^${parts[0]}${parts.slice(1).map((part, i) => (i === 0 ? `(.+)${part}` : `\\1${part}`)).join("")}$`);
        if (!files.some((file) => matches.test(file))) {
          missing.push([target, `exports['${key}'], a pattern no packed file matches`]);
        }
      }
    }
    if (missing.length > 0) {
      throw new CheckError(
        `${missing.map(([path, by]) => `${path} (${by})`).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in ` +
          `${packed.filename}: add ${missing.length === 1 ? "it" : "them"} to package.json's \`files\`.`,
      );
    }

    // The entry points, loaded as a consumer loads them, each in its own process.
    const loads = [];
    const roots = subpaths(pkg.exports);
    if (pkg.exports == null && (typeof pkg.main === "string" || existsSync(join(installed, "index.js")))) {
      loads.push([pkg.name, typeof pkg.main === "string" && pkg.main.endsWith(".json") ? "import json" : "import"]);
    }
    for (const [key, value] of roots) {
      if (key.includes("*")) continue;
      const specifier = key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`;
      const imported = pick(value, ["node", "import"]);
      const required = pick(value, ["node", "require"]);
      if (typeof imported === "string") loads.push([specifier, imported.endsWith(".json") ? "import json" : "import"]);
      if (typeof required === "string" && required !== imported) loads.push([specifier, "require"]);
    }
    for (const [specifier, how] of loads) {
      const code =
        how === "require"
          ? `require(${JSON.stringify(specifier)}); process.exit(0);`
          : `await import(${JSON.stringify(specifier)}${how === "import json" ? ', { with: { type: "json" } }' : ""}); process.exit(0);`;
      run(
        process.execPath,
        how === "require" ? ["-e", code] : ["--input-type=module", "-e", code],
        { cwd: dir, timeout: LOAD_TIMEOUT_MS },
        `loading '${specifier}' (${how}) from the installed ${packed.filename} failed (above). A dependency only ` +
          "devDependencies supplied does that, as does a file it imports that the package leaves out, or a " +
          "dependency's new release (rerun this on main to tell).",
      );
    }
    // bun reads the `bun` condition, which Node never does. Importing the
    // package's name under bun loads what a bun consumer gets: the `bun`
    // target where `bun` is the first condition bun matches.
    const bunLoads = [];
    const bun = bunOnPath();
    for (const [key, value] of roots) {
      if (key.includes("*") || !hasCondition(value, "bun")) continue;
      const specifier = key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`;
      bunLoads.push(specifier);
      if (!bun) continue;
      run(
        "bun",
        ["-e", `await import(${JSON.stringify(specifier)}); process.exit(0);`],
        { cwd: dir, timeout: LOAD_TIMEOUT_MS },
        `loading '${specifier}' under bun from the installed ${packed.filename} failed (above). ` +
          "A file it imports that the package leaves out does that, a dependency only devDependencies supplied, or " +
          "a dependency's new release (rerun this on main to tell).",
      );
    }

    const bins = binsOf(pkg);
    const binsLoaded = [];
    const binsParsed = [];
    const binsNotNode = [];
    for (const [bin, path] of Object.entries(bins)) {
      const file = join(installed, path);
      const first = readFileSync(file, "utf8").split("\n", 1)[0];
      if (!first.startsWith("#!")) {
        throw new CheckError(
          `bin '${bin}' (${path}) has no '#!' line, so npm's link can't run it as a command: start its source with '#!/usr/bin/env node'.`,
        );
      }
      if (!/\bnode\b/.test(first)) {
        binsNotNode.push(bin);
        continue;
      }
      // The hook makes an ES module bin throw once its imports have loaded,
      // so its own code never runs, and stops a CommonJS bin before it
      // loads, which is then only parsed; any other failure is the bin's.
      const hook = join(work, "bin-hook.mjs");
      const register = join(work, "bin-register.mjs");
      writeFileSync(hook, HOOK);
      writeFileSync(register, `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hook).href)});\n`);
      const loaded = spawnSync(process.execPath, ["--import", pathToFileURL(register).href, file], {
        cwd: dir,
        encoding: "utf8",
        timeout: LOAD_TIMEOUT_MS,
        env: { ...process.env, PACK_INSTALLS_ALONE_BIN: pathToFileURL(realpathSync(file)).href },
      });
      const stderr = `${loaded.stderr ?? ""}`;
      if (stderr.includes(LINKED)) {
        binsLoaded.push(bin);
        continue;
      }
      if (stderr.includes(NOT_MODULE)) {
        run(process.execPath, ["--check", file], {}, `bin '${bin}' (${path}) in ${packed.filename} doesn't parse (above).`);
        binsParsed.push(bin);
        continue;
      }
      process.stderr.write(stderr);
      throw new CheckError(
        loaded.error?.code === "ETIMEDOUT"
          ? `loading bin '${bin}' (${path}) in ${packed.filename} didn't finish within ${LOAD_TIMEOUT_MS / 1000} s.`
          : `bin '${bin}' (${path}) in ${packed.filename} doesn't load (above): a package it imports that only ` +
              "devDependencies supplies does that, as does a file the package leaves out, a syntax error, or a " +
              "dependency's new release (rerun this on main to tell).",
      );
    }

    const patterns = roots.filter(([key]) => key.includes("*")).map(([key]) => key);
    console.log(
      `${packed.filename} (${files.length} files) installs on its own; every file package.json's main, types, exports and bin name is in it` +
        (loads.length > 0 ? `; loaded ${loads.map(([s, how]) => `'${s}' (${how})`).join(", ")}` : "") +
        (bunLoads.length > 0
          ? bun
            ? `; loaded under bun: ${bunLoads.map((s) => `'${s}'`).join(", ")}`
            : `; bun targets present, not loaded (bun isn't on PATH): ${bunLoads.map((s) => `'${s}'`).join(", ")}`
          : "") +
        (Object.keys(bins).length > 0 ? `; bins start with '#!': ${Object.keys(bins).join(", ")}` : "") +
        (binsLoaded.length > 0 ? `; ES module bins' static imports load: ${binsLoaded.join(", ")}` : "") +
        (binsParsed.length > 0 ? `; CommonJS bins parse, not loaded: ${binsParsed.join(", ")}` : "") +
        (binsNotNode.length > 0 ? `; bins whose '#!' line names no node, not loaded: ${binsNotNode.join(", ")}` : "") +
        (patterns.length > 0 ? `; export patterns matched, not loaded: ${patterns.join(", ")}` : "") +
        ".",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  if (!(error instanceof CheckError)) throw error;
  console.error(`pack-installs-alone: ${error.message}`);
  process.exitCode = 1;
}
