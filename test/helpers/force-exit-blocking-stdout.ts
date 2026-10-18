/**
 * Loaded by `npm test` (`node --import`) into the test runner and into each
 * test file's process. In a test file's own process under the runner
 * (NODE_TEST_CONTEXT is child-v8), it makes stdout blocking: that pipe
 * carries the file's results to the runner.
 *
 * With --test-force-exit, Node's runner ends a test file's process with
 * process.exit() as soon as its last test has finished and its results are
 * handed to stdout. It doesn't wait for the pipe to drain, and writes to a
 * pipe are asynchronous on Linux and macOS, so results still queued for it
 * are dropped. The runner counts only what reached it, so the run passes
 * with fewer tests than ran (agent-framework #294; nodejs/node#64833). A
 * blocking pipe takes each write whole before the next, and the exit drops
 * nothing. Node's own fix, nodejs/node#64875, takes the same step; once it
 * ships, this adds nothing.
 *
 * The handle is internal, so a stdout without one, such as a file, is left
 * as it is.
 */
const stdout = process.stdout as typeof process.stdout & { _handle?: { setBlocking?: (blocking: boolean) => number } };
if (process.env.NODE_TEST_CONTEXT === 'child-v8') stdout._handle?.setBlocking?.(true);

export {};
