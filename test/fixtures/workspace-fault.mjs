// Child process for workspace-three-way.test.ts: run one workspace operation
// and die by SIGKILL at a chosen point of its write-ahead order.
//   node workspace-fault.mjs <storePath> <mountDir> <op> <killAt>
// op:
//   "materialize": materialize the mount (a store→disk write of a draft)
//   "sync":        a full sync (a disk→store adoption of a shell edit)
//   "write":       an autoMaterialize write of work/new.txt
// killAt:
//   "after-intent": the intent is durable; the effect never happens
//   "after-effect": the effect is durable; its completion is never appended
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../../src/modules/workspace/index.js';
import { DiskAgreement } from '../../src/modules/workspace/disk-agreement.js';

const [storePath, mountDir, op, killAt] = process.argv.slice(2);
const store = JsStore.openOrCreate({ path: storePath });
const module = new WorkspaceModule({
  mounts: [{ name: 'work', path: mountDir, mode: 'read-write', watch: 'never', autoMaterialize: op === 'write' }],
});
module.initStore(store);
await module.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} });

const die = () => process.kill(process.pid, 'SIGKILL');
const intend = DiskAgreement.prototype.intend;
const set = DiskAgreement.prototype.set;
let intended = false;
DiskAgreement.prototype.intend = function (mount, path, intent, opts) {
  intended = true;
  intend.call(this, mount, path, intent, opts);
  if (killAt === 'after-intent' && opts?.durable) die();
};
DiskAgreement.prototype.set = function (...args) {
  if (killAt === 'after-effect' && intended) {
    // Whatever the effect was — a fsynced disk write, or a tree commit — it is
    // durable now; the completion that would follow is never appended.
    store.sync();
    die();
  }
  return set.apply(this, args);
};

const call = (name, input) => module.handleToolCall({ id: 'fault', name, input });
if (op === 'materialize') await call('materialize', {});
else if (op === 'sync') await call('sync', {});
else if (op === 'write') await call('write', { path: 'work/new.txt', content: 'new file' });
// Reaching here means the kill point never came: the parent sees exit 0.
store.close();
process.exit(0);
