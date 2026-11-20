import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const { LAUNCHES_PATH, FAIL_RELAUNCH } = process.env;
const [fixture, ...rest] = process.argv.slice(2);
const earlier = LAUNCHES_PATH && existsSync(LAUNCHES_PATH) ? readFileSync(LAUNCHES_PATH, 'utf8').trim().split('\n').filter(Boolean).length : 0;
if (LAUNCHES_PATH) appendFileSync(LAUNCHES_PATH, `${Date.now()} ${process.pid}\n`);
if (FAIL_RELAUNCH && earlier > 0) {
  process.stderr.write(`refusing to start with ${process.env.API_TOKEN ?? 'no token'}\n`);
  process.exitCode = 1;
  await new Promise((resolve) => process.stderr.write('', resolve));
  process.exit(1);
}
process.argv = [process.argv[0], fixture, ...rest];
await import(fixture);
