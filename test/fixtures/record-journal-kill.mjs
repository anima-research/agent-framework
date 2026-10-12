// Child process for record-journal.test.ts: commit branch state, append a
// journal entry that asserts it, then die without sync or close.
//   node record-journal-kill.mjs <storePath> <mode>
// mode "asserting": append with afterCommittedState (the barrier under test).
import { JsStore } from '@animalabs/chronicle';
import { RecordJournal } from '../../src/record-journal.js';

const [storePath, mode] = process.argv.slice(2);
const store = JsStore.openOrCreate({ path: storePath });
try {
  store.registerState({ id: 'journal-test/tree', strategy: 'tree' });
} catch {
  // registered by the parent's setup
}
const journal = new RecordJournal(store, { type: 'journal-test/entry' });
store.treeSet('journal-test/tree', 'committed.txt', { blobHash: 'c'.repeat(64), size: 1, mode: 0o644 });
journal.append({ asserts: 'committed.txt' }, { afterCommittedState: mode === 'asserting' });
process.kill(process.pid, 'SIGKILL');
