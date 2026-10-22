import type { MessageId, MessageQuery, StoredMessage } from '@animalabs/context-manager';

/**
 * The id a module holds for a write the framework holds. addMessage holds a
 * write while its agent's turn is alive or the host is quiesced, and stores
 * it at a later boundary. Until then, a module's context answers its id as a
 * handle: `held:` and the write's id in the deferred queue. The context's
 * getMessage, editMessage and removeMessage take the handle as they take a
 * stored id, as a process answer's edits and removals do, and once the write
 * lands, the handle names the stored row, which carries the write's id as
 * `metadata.deferredWriteId`.
 */
const HELD = 'held:';

export function heldHandle(writeId: string): MessageId {
  return `${HELD}${writeId}`;
}

/** The deferred write a handle names, or undefined for any other id. A value
 *  that isn't a string, which only an untyped caller passes, is no handle,
 *  and goes on to the store as it did before handles. */
export function heldWriteId(id: MessageId): string | undefined {
  return typeof id === 'string' && id.startsWith(HELD) ? id.slice(HELD.length) : undefined;
}

/**
 * Whether a row matches `filter` as context-manager's queryMessages matches a
 * stored one. That's its MessageStore's private matchesFilter, the same at
 * 0.14.1, 0.16.0, 0.17.1 and 0.18.0, which the package doesn't export, so the rule is copied
 * here, and a test compares the two on the same rows. A row matches the external source, one of the
 * external ids (an empty list filters nothing), the participant, and each
 * metadata path, dot-separated, by strict equality.
 */
export function matchesMessageQuery(row: Pick<StoredMessage, 'participant' | 'metadata'>, filter: MessageQuery): boolean {
  const external = row.metadata?.external as { source?: unknown; id?: unknown } | undefined;
  if (filter.source !== undefined && external?.source !== filter.source) return false;
  if (
    filter.externalIds !== undefined &&
    filter.externalIds.length > 0 &&
    (!external?.id || !filter.externalIds.includes(external.id as string))
  ) {
    return false;
  }
  if (filter.participant !== undefined && row.participant !== filter.participant) return false;
  if (filter.metadata !== undefined) {
    for (const [path, value] of Object.entries(filter.metadata)) {
      if (valueAt(row.metadata, path) !== value) return false;
    }
  }
  return true;
}

function valueAt(value: unknown, path: string): unknown {
  for (const part of path.split('.')) {
    if (value === undefined || value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * A row as a module's context answers it: marked `heldFromResidents` when it
 * carries the stamp a tune-out puts on a message it holds from the residents
 * (`metadata.tuneOut`). Every resident's viewFilter leaves a stamped row out
 * of its compiled view (framework.ts, createAgent), and a tool boundary
 * stores a stamped write without injecting it into the live turn, so a
 * marked row is one the store keeps and no resident is shown
 * (ModuleMessage.heldFromResidents says where its text can still reach
 * one). Any other row comes back as it is.
 */
export function asModuleRow<T extends Pick<StoredMessage, 'metadata'>>(row: T): T & { heldFromResidents?: true } {
  return (row.metadata as { tuneOut?: unknown } | undefined)?.tuneOut ? { ...row, heldFromResidents: true } : row;
}
