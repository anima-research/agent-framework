// For test/force-exit-blocking-stdout: a test file whose one test writes more
// to stdout than a pipe holds and exits at once, as --test-force-exit's
// process.exit() does once a file's last test has finished, at the moment
// the most is still queued for the pipe.
import { test } from 'node:test';

test('writes more than a pipe holds, then exits', () => {
  process.stdout.write('~'.repeat(Number(process.env.FORCE_EXIT_BYTES)));
  process.exit(0);
});
