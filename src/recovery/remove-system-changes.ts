import { JsStore } from '@animalabs/chronicle';
import { ContextManager, MessageStore, continuesBody } from '@animalabs/context-manager';
import { isDeclarationRow } from '../system-changes.js';
import { removeStoredMessages } from '../stored-removal.js';
import { firstFreeBranchName } from '../branch-names.js';
import { RECOVERY_SCAN_WINDOW, validateRemovalIntegrity } from './offline-branch.js';

export interface RemoveSystemChangesOptions {
  storePath: string;
  /** Defaults to `recovery/system-changes/{ms}`, or with `-2`, `-3`, … appended when the store already holds that name. */
  branchName?: string;
  dryRun?: boolean;
}

export interface RemoveSystemChangesResult {
  dryRun: boolean;
  sourceBranch: string;
  /** The branch made at the head of the source branch, with the rows taken out, and selected: the one a dry run would
   *  make. Absent when no slot holds a row to take out, since nothing is made then. */
  targetBranch?: string;
  /** Each message slot of the store, by its state id, with how many rows it holds that change tools or system text. */
  slots: Array<{ slot: string; rows: number }>;
  rowsRemoved: number;
}

type Reader = Pick<ContextManager, 'getMessageCount' | 'getMessageWindow'>;
type Removals = Pick<ContextManager, 'removeMessage' | 'removeMessages'>;
type StoredRow = ReturnType<ContextManager['getMessageWindow']>['messages'][number];

/**
 * A message slot, and what it is read and changed through: the context of a
 * namespace that reads it, or, where no context of the store reads it, the
 * message store alone, since a context opened for the run would register a
 * state of its own on the branch.
 */
interface Slot {
  id: string;
  through: { namespace: string | undefined; isolate: boolean } | { messages: string | undefined };
}

/**
 * Take every row that changes tools or system text out of every message slot
 * of the store, onto a new branch made at the head of the current one, while
 * the host is stopped. A release before head declarations sends such a row as
 * stored, beside its own tools, or, with membrane 0.10.0 or later and a
 * formatter or adapter that can't send one, has membrane refuse the request,
 * so this is run before a step back to one; it also mends a store after a
 * step back made without it. Other
 * branches keep their rows. A row is picked by its content, as a request
 * counts it, a body of shards whole, since a host's own rows carry no mark.
 * The store writes to the branch it has selected, so the new branch is
 * selected for its removals. A failure that the command meets selects the
 * source branch again and keeps the new one for diagnosis. A run stopped
 * partway can leave the new branch selected and partly cleaned: the command
 * run again takes the rest out, onto a branch of its own.
 */
export async function removeSystemChangesOffline(options: RemoveSystemChangesOptions): Promise<RemoveSystemChangesResult> {
  const store = JsStore.openOrCreate({ path: options.storePath });
  try {
    const sourceBranch = store.currentBranch().name;
    const slots = slotsOf(store);
    const counts: number[] = [];
    for (const slot of slots) {
      counts.push(await throughSlot(store, slot, (reader) => {
        const bodies = declarationBodies(reader);
        try {
          validateRemovalIntegrity(reader, reader.getMessageCount(), bodies.map(({ from, to }) => ({ start: from, end: to })));
        } catch (error) {
          throw new Error(
            `${slot.id}: a row there that changes tools or system text can't be taken out on its own ` +
              `(${error instanceof Error ? error.message : String(error)}). This command takes no anchor or ` +
              'suppression boundary, and it changed nothing.',
            { cause: error },
          );
        }
        return bodies.length;
      }));
    }
    const rowsRemoved = counts.reduce((sum, n) => sum + n, 0);
    const result: RemoveSystemChangesResult = {
      dryRun: options.dryRun === true,
      sourceBranch,
      slots: slots.map((slot, i) => ({ slot: slot.id, rows: counts[i]! })),
      rowsRemoved,
    };
    if (rowsRemoved === 0) return result;
    const held = new Set(store.listBranches().map((branch) => branch.name));
    const targetBranch = options.branchName ?? firstFreeBranchName(`recovery/system-changes/${Date.now()}`, (name) => held.has(name));
    if (held.has(targetBranch)) throw new Error(`Recovery branch ${targetBranch} already exists; choose another --branch`);
    result.targetBranch = targetBranch;
    if (options.dryRun) return result;

    let created = false;
    try {
      store.createBranchAt(targetBranch, sourceBranch, store.currentSequence());
      created = true;
      store.switchBranch(targetBranch);
      for (const [i, slot] of slots.entries()) {
        if (counts[i] === 0) continue;
        await throughSlot(store, slot, (reader, removals) => {
          for (const { first, last } of declarationBodies(reader)) removeStoredMessages(removals, first, last);
        });
      }
    } catch (error) {
      let restore = '';
      try {
        if (store.currentBranch().name !== sourceBranch) store.switchBranch(sourceBranch);
      } catch (restoreError) {
        restore = `; restoring ${sourceBranch} failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${restore}` + (created
          ? `; branch ${targetBranch} is kept for diagnosis: it may be partly cleaned, so don't start on it, and ` +
            "delete it once it has been looked at (the host API's branch.delete, once the host runs)"
          : ''),
        { cause: error },
      );
    }
    return result;
  } finally {
    store.close();
  }
}

// A message slot's state is `messages`, the shared slot, or
// `<namespace>/messages`, an isolated one; a context's log is
// `<namespace>/context`, or `context` with no namespace. A context with no
// slot of its own reads the shared slot.
function slotsOf(store: JsStore): Slot[] {
  const ids = new Set(store.listStates().map((state) => state.id));
  const namespaceOf = (id: string, kind: string) => (id === kind ? '' : id.endsWith(`/${kind}`) ? id.slice(0, -kind.length - 1) : undefined);
  const contexts = [...ids].map((id) => namespaceOf(id, 'context')).filter((namespace) => namespace !== undefined).sort();
  return [...ids].filter((id) => namespaceOf(id, 'messages') !== undefined).sort().map((id): Slot => {
    const namespace = namespaceOf(id, 'messages')!;
    if (namespace !== '') {
      return { id, through: contexts.includes(namespace) ? { namespace, isolate: true } : { messages: namespace } };
    }
    const reader = contexts.find((context) => context === '' || !ids.has(`${context}/messages`));
    return { id, through: reader === undefined ? { messages: undefined } : { namespace: reader || undefined, isolate: false } };
  });
}

async function throughSlot<T>(store: JsStore, slot: Slot, use: (reader: Reader, removals: Removals) => T): Promise<T> {
  if ('messages' in slot.through) {
    const messages = new MessageStore(store, slot.through.messages === undefined ? {} : { namespace: slot.through.messages });
    return use(
      { getMessageCount: () => messages.length(), getMessageWindow: (offset, limit, opts) => messages.getWindow(offset, limit, opts) },
      { removeMessage: (id) => messages.remove(id), removeMessages: (fromId, toId) => messages.removeRange(fromId, toId) },
    );
  }
  const { namespace, isolate } = slot.through;
  const context = await ContextManager.open({ store, ...(namespace === undefined ? {} : { namespace }), ...(isolate ? { isolate } : {}) });
  try {
    return use(context, context);
  } finally {
    context.close();
  }
}

// Each body whose rows change tools or system text, read whole as a compile
// renders it, a body of shards included: its places in the slot, its first
// row and its last.
function declarationBodies(reader: Reader): Array<{ from: number; to: number; first: StoredRow; last: StoredRow }> {
  const total = reader.getMessageCount();
  const bodies: Array<{ from: number; to: number; first: StoredRow; last: StoredRow }> = [];
  let body: { from: number; rows: StoredRow[] } | undefined;
  const close = () => {
    if (body && isDeclarationRow({ content: body.rows.flatMap((row) => row.content) })) {
      bodies.push({ from: body.from, to: body.from + body.rows.length - 1, first: body.rows[0]!, last: body.rows.at(-1)! });
    }
  };
  for (let offset = 0; offset < total; offset += RECOVERY_SCAN_WINDOW) {
    const { messages } = reader.getMessageWindow(offset, Math.min(RECOVERY_SCAN_WINDOW, total - offset), { resolveBlobs: false });
    for (const [i, row] of messages.entries()) {
      if (body && continuesBody(body.rows.at(-1), row)) {
        body.rows.push(row);
        continue;
      }
      close();
      body = { from: offset + i, rows: [row] };
    }
  }
  close();
  return bodies;
}
