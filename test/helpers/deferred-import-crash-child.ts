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
 *                       Exit code 4 instead where the record's write is
 *                       reached with no store sync since the last imported
 *                       write (AF #844 bot review 4, finding 44), and 5
 *                       where it is reached with nothing imported (bot
 *                       review 5, finding 5).
 *   big-before-rewrite  the same, for a queue the test made large (more than
 *                       any fixed scan tail).
 *
 * argv[2] = store path.
 */
import { JsStore } from '@animalabs/chronicle';
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
  // Whether the importer stored a write, and whether the store synced after
  // the last one it stored: nothing imported reads as neither.
  let importedAny = false;
  let syncedSinceImported = false;
  const addMessage = proto.addMessage;
  proto.addMessage = function (participant, content, metadata, opts) {
    const id = addMessage.call(this, participant, content, metadata, opts);
    if (opts?.imported) { importedAny = true; syncedSinceImported = false; }
    return id;
  };
  const storeProto = JsStore.prototype as unknown as { sync(this: JsStore): unknown };
  const sync = storeProto.sync;
  storeProto.sync = function (this: JsStore) {
    const synced = sync.call(this);
    if (importedAny) syncedSinceImported = true;
    return synced;
  };
  proto.writeImportedRecord = function () { process.exit(!importedAny ? 5 : syncedSinceImported ? 0 : 4); };
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
