/**
 * Child process for the importer's crash cases (deferred-import-boot.test.ts,
 * #291 AF-6). It boots a framework on a store whose recovery file holds a
 * deferred-write queue an earlier release left, and HARD-EXITS
 * (process.exit, no stop(), no further sync) at the point argv[3] names.
 * Exit code 0 means the intended exit point was hit; anything else means the
 * scenario could not be staged.
 *
 *   mid-import          exit right after the importer stored its second
 *                       write, before its sync: what it stored may be lost.
 *   before-rewrite      exit after the importer's sync, before it clears the
 *                       record: every write is on disk and still queued.
 *   big-before-rewrite  the same, for a queue the test made large (more than
 *                       any fixed scan tail).
 *
 * argv[2] = store path.
 */
import { AgentFramework } from '../../src/index.js';
import { MockMembrane } from './mock-membrane.js';

const MODES = ['mid-import', 'before-rewrite', 'big-before-rewrite'] as const;
type Mode = typeof MODES[number];
const [storePath, modeArg] = process.argv.slice(2);
if (!storePath || !MODES.includes(modeArg as Mode)) {
  console.error(`usage: deferred-import-crash-child <storePath> ${MODES.join('|')}`);
  process.exit(2);
}
const mode = modeArg as Mode;

const proto = AgentFramework.prototype as unknown as {
  addMessage(this: unknown, participant: string, content: unknown[], metadata?: unknown, opts?: { imported?: unknown }): unknown;
  writeImportedRecord(this: unknown, ...args: unknown[]): void;
};
if (mode === 'mid-import') {
  const addMessage = proto.addMessage;
  let imported = 0;
  proto.addMessage = function (participant, content, metadata, opts) {
    const id = addMessage.call(this, participant, content, metadata, opts);
    if (opts?.imported && ++imported === 2) process.exit(0);
    return id;
  };
} else {
  proto.writeImportedRecord = function () { process.exit(0); };
}

await AgentFramework.create({
  storePath,
  membrane: new MockMembrane().asMembrane(),
  agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'You are agent.' }],
  modules: [],
  syncIntervalMs: 0,
});
console.error(`deferred-import-crash-child: create() returned without reaching the ${mode} exit`);
process.exit(3);
