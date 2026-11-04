// How scripts/pack-installs-alone.mjs and its test start npm, where PATH
// names a JavaScript npm, and each Node of their own: with --single-threaded,
// so that V8 runs no work on its background threads.
//
// Node 24's process exit can wait forever: process.exit() joins V8's worker
// threads while one of them is parked waiting for a garbage collection that
// only the main thread runs, and the exit never runs it (nodejs/node#64274,
// where an uncaught exception is reported to hang the same way; a fix is
// proposed in nodejs/node#66171). npm 11 ends every command with
// process.exit(), so an `npm install` that has finished its work can hang
// there, and on a loaded host some do. --single-threaded is V8's "disable the
// use of background tasks", so V8 has no job to park. NODE_OPTIONS refuses
// the flag, so it goes on the command line, and npm is started through its
// JavaScript entry to take it.
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export const SINGLE_THREADED = "--single-threaded";

/** How to start npm for a child started in `cwd` with `path` as its PATH:
 *  the first executable file `npm` in path's directories, each resolved
 *  against `cwd`, where the child reads a relative or empty entry from.
 *  Where that npm's real path is a JavaScript file, as an npm installed with
 *  Node's is (bin/npm links to lib/node_modules/npm/bin/npm-cli.js), it runs
 *  under this Node with --single-threaded, by the path it was found at, not
 *  its real path, as a start by name runs it. Any other npm, such as a shell
 *  script, is started by name as before, and so is npm when PATH is unset,
 *  since the child then looks on its default path. */
export function npmCommand(cwd = process.cwd(), path = process.env.PATH) {
  if (path === undefined) return { file: "npm", args: [] };
  for (const dir of path.split(delimiter)) {
    const candidate = resolve(cwd, dir, "npm");
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    if (/\.[cm]?js$/.test(realpathSync(candidate))) return { file: process.execPath, args: [SINGLE_THREADED, candidate] };
    break;
  }
  return { file: "npm", args: [] };
}
