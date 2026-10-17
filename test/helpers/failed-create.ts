/**
 * A build of the framework that must fail: `AgentFramework.create()`, or a
 * fixture's restart through it. Until a failed create() releases what it
 * acquired (agent-framework #389, which #426 fixes), the framework it built keeps its store open,
 * so a test that boots again on that store first stops it here, as that
 * release would. stop() is idempotent, so this stop is harmless once it does.
 */
import assert from 'node:assert/strict';
import { AgentFramework } from '../../src/index.js';

export async function rejectsBuild(build: () => Promise<unknown>, message: RegExp, what?: string): Promise<Error> {
  // restoreUsageState runs early in every create(), on the framework it builds.
  const proto = AgentFramework.prototype as unknown as { restoreUsageState(this: AgentFramework): void };
  const original = proto.restoreUsageState;
  let built: AgentFramework | undefined;
  proto.restoreUsageState = function (this: AgentFramework) {
    built = this;
    return original.call(this);
  };
  let caught: unknown;
  let made: unknown;
  try {
    made = await build();
  } catch (error) {
    caught = error;
  } finally {
    proto.restoreUsageState = original;
    await built?.stop();
  }
  if (made instanceof AgentFramework) await made.stop();
  assert.ok(caught instanceof Error, `the build should have failed${what ? `: ${what}` : ''}`);
  assert.match(caught.message, message, what);
  return caught;
}
