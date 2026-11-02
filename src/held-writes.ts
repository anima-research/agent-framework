import type { ContextManager, MessageId, StoredMessage } from '@animalabs/context-manager';

/**
 * The id a release before #291 gave a module for a write it held while the
 * write's agent's turn was alive: `held:` and the write's id in its deferred
 * queue, which the stored row carries as `metadata.deferredWriteId` once it
 * lands. This release stores every write at once and answers its stored id,
 * so no write gets a handle any more, but a module may have kept one across
 * the upgrade: for one release the context's getMessage, editMessage and
 * removeMessage still take it, and reach the row its write landed as
 * (AgentFramework.landedRow), which the importer stores at boot for a write
 * that release left queued.
 */
const HELD = 'held:';

/** The queued write a `held:` handle names, or undefined for any other id. A
 *  value that isn't a string, which only an untyped caller passes, is no
 *  handle, and goes on to the store as it did before handles. */
export function heldWriteId(id: MessageId): string | undefined {
  return typeof id === 'string' && id.startsWith(HELD) ? id.slice(HELD.length) : undefined;
}

/** What asModuleRow reads of the window of the agent a read is for. */
export type ModuleRowWindow = Pick<ContextManager, 'windowMode' | 'ordinalOf'>;

/**
 * A row as a module's context answers it, for the agent whose store it was
 * read from:
 *
 * - `heldFromResidents` when it carries the stamp a tune-out puts on a
 *   message it holds from the residents (`metadata.tuneOut`). Every
 *   resident's viewFilter leaves a stamped row out of its compiled view
 *   (framework.ts, createAgent), and a tool boundary never presents one to a
 *   resident, so a marked row is one the store keeps and no resident is
 *   shown (ModuleMessage.heldFromResidents says where its text can still
 *   reach one).
 * - `held` when that agent's window (`window`) presents rows and doesn't
 *   hold it (#291): stored and not yet presented to the agent, which its
 *   next presentation point does, or taken out of it as an undone turn's,
 *   or one it is never presented, as a held row is for a resident. Never in
 *   legacy mode, where the window is the record. A resident's window
 *   written down from the record holds the held rows an earlier release
 *   stored, unstamped, so those read without `held`: `heldFromResidents`
 *   marks every held row.
 *
 * Any other row comes back as it is.
 */
export function asModuleRow<T extends Pick<StoredMessage, 'id' | 'metadata'>>(
  row: T,
  window?: ModuleRowWindow,
): T & { heldFromResidents?: true; held?: true } {
  const fromResidents = !!(row.metadata as { tuneOut?: unknown } | undefined)?.tuneOut;
  const held = window !== undefined && window.windowMode() === 'presented' && window.ordinalOf(row.id) === undefined;
  if (!fromResidents && !held) return row;
  return { ...row, ...(fromResidents ? { heldFromResidents: true as const } : {}), ...(held ? { held: true as const } : {}) };
}
