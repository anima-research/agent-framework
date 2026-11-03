/**
 * A build of the framework that must fail: `AgentFramework.create()`, or a
 * fixture's restart through it. A failed create() releases what it acquired
 * (agent-framework #389), so a test can boot again on the same store. A build
 * that succeeds is stopped before the assertion fails, so its store is
 * released too.
 */
import assert from 'node:assert/strict';
import { AgentFramework } from '../../src/index.js';

export async function rejectsBuild(build: () => Promise<unknown>, message: RegExp, what?: string): Promise<Error> {
  let caught: unknown;
  let made: unknown;
  try {
    made = await build();
  } catch (error) {
    caught = error;
  }
  if (made instanceof AgentFramework) await made.stop();
  assert.ok(caught instanceof Error, `the build should have failed${what ? `: ${what}` : ''}`);
  assert.match(caught.message, message, what);
  return caught;
}
