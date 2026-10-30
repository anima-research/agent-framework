import { spawnSync } from "node:child_process";
import { availableParallelism, cpus } from "node:os";
import { npmCommand } from "./single-threaded.mjs";

const cores = cpus().length;
const width = 2 * cores;
console.log(`cores: ${cores} (Node's availableParallelism: ${availableParallelism()}); test files at once: ${width}`);

const npm = npmCommand();
const run = spawnSync(npm.file, [...npm.args, "test"], {
  stdio: "inherit",
  env: { ...process.env, AF_TEST_CONCURRENCY: String(width) },
});
if (run.error) throw run.error;
if (run.signal) process.kill(process.pid, run.signal);
process.exit(run.status ?? 1);
