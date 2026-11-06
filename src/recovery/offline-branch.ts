import { suppressionRecordOf } from '../gate/suppression-stats.js';
import { JsStore } from '@animalabs/chronicle';
import type { SurgeryMarkerReceipt } from '../operator-log.js';
import { ContextManager, continuesBody, type BodyShard } from '@animalabs/context-manager';
import { removeStoredInterval } from '../stored-removal.js';
import { firstFreeBranchName } from '../branch-names.js';
import {
  DEFAULT_DISCORD_AWARENESS_EMOJI,
  DiscordAwarenessOutbox,
  boundDiscordAwarenessText,
  defaultDiscordAwarenessOutboxPath,
  checkedDiscordAwarenessMarks,
  extractDiscordAwarenessRefs,
  selectDiscordAwarenessRefs,
  type DiscordAwarenessMarks,
  type DiscordAwarenessRef,
  type DiscordMessageMetadataCarrier,
} from './discord-awareness-outbox.js';

export interface OfflineRecoveryBranchOptions {
  storePath: string;
  agentName: string;
  /**
   * Preferred: Discord message that remains as the last visible anchor. On
   * an agent's window that was presented (#291) the branch is cut at the
   * write that presented the anchor, so rows stored after the anchor and
   * before that write stay on the branch: those the window took after the
   * anchor enter it again at the agent's next presentation point, after the
   * anchor. Only rows stored after the cut are removed and counted. A
   * suppression may name any row the branch keeps that has a Discord
   * message id, one the cut keeps after the anchor too; one without (an
   * agent's round, a tool row) takes the live suppressMessages, by its row
   * id. A recovery on that window that would change nothing (no
   * row removed, none an arrival again, no suppression) is refused, as the
   * live rollback refuses it.
   */
  messageId?: string;
  /** Exact internal ContextManager message ID that remains as the anchor (the cut as for `messageId`). */
  contextId?: string;
  /**
   * Backward-compatible alternative: remove the newest N context entries,
   * counted in the agent's window once it was presented (#291), over the
   * rows of its own slot, and in the record before that; the anchor is the
   * entry before them, cut as for `messageId`.
   */
  messages?: number;
  /**
   * Remove every row a suppress rule hid (`metadata.suppressed`) on the new
   * branch, which needs no anchor: the branch then starts from the newest row.
   * For rolling back to a release that doesn't read the stamp, where a row
   * hidden between messages a summary covers makes that summary non-contiguous,
   * and the store is refused at open. The source branch keeps them.
   */
  removeSuppressed?: boolean;
  /** Exact Discord messages to suppress on the new branch. */
  suppressMessageIds?: string[];
  /** Inclusive context-order ranges between Discord message endpoints. */
  suppressRanges?: Array<{ fromMessageId: string; toMessageId: string }>;
  /** Defaults to `recovery/{agentName}/{ms}`, or with `-2`, `-3`, … appended when the store already holds that name. */
  branchName?: string;
  /** Defaults to the primary-agent namespace `agents/{agentName}`. */
  namespace?: string;
  /** Use for old message records that do not carry metadata.serverId. */
  discordServerId?: string;
  /** The awareness ledger (default: under the store). */
  outboxPath?: string;
  emoji?: string;
  /**
   * Awareness marks on the removed Discord messages: an explicit publication
   * choice, `none` by default. The recovery itself stays local either way.
   */
  marks?: DiscordAwarenessMarks;
  dryRun?: boolean;
}

export interface OfflineRecoveryBranchResult {
  dryRun: boolean;
  sourceBranch: string;
  targetBranch: string;
  messagesRemoved: number;
  messagesSuppressed: number;
  /**
   * On a presented window (#291): the rows after the anchor in the agent's
   * window that the cut keeps in the record (stored before the write that
   * presented the anchor, presented after it), as the live rollback counts
   * them, of the agent's own slot: the recovery reads that slot alone, so a
   * row of a slot the agent observes (the residents' rows in a persistent
   * subconscious's window), which the live rollback counts, isn't counted
   * here, and the check of a cut that would change nothing doesn't see it. They leave the window as arrived and not presented, and enter it
   * again at the agent's next presentation point, after the anchor. Not
   * removed, so not counted in `messagesRemoved`, and not marked; a row the
   * same recovery suppresses is counted there instead. 0 for a run with no
   * anchor; absent on a window that is still the record.
   */
  returnedToArrivals?: number;
  /** Removed messages that carry a Discord address. */
  discordAddressable: number;
  /** The publication scope recorded for this recovery. */
  marksScope: 'none' | 'addressed' | 'all';
  /** Marks queued for delivery (planned, for a dry run); not delivered. */
  discordMarkersQueued: number;
  /** What became of the marks once the branch was made (absent on a dry
   *  run): scheduling only, never Discord acceptance. */
  markers?: SurgeryMarkerReceipt;
  /** The refs that will be marked (empty unless marks were chosen). */
  refs: DiscordAwarenessRef[];
  /** Removed addressable messages the marks choice leaves unmarked (outside
   *  its scope); `markers` says whether the chosen ones are scheduled. */
  unmarked: number;
  /** Authorized refs (marks.refs) this recovery does not remove. */
  notRemoved: number;
  /** The awareness ledger the batch is recorded in. */
  outboxPath: string;
  /** Set when a suppression-only batch's resume record couldn't be closed:
   *  what of it is left, as the host's surgeries report it. */
  suppressionRecord?: string;
}

/**
 * Create a safe Chronicle branch while the normal agent host is stopped.
 *
 * History is scanned in bounded windows and blobs are not re-inlined, but a
 * presented window (#291) is read whole where its order counts: for a
 * `messages` count, and for the rows after the anchor that the cut returns
 * to the arrivals or keeps (windowAfterCut). The affected messages are never
 * compiled and their content is never written to the recovery outbox; only
 * Discord addressing metadata leaves Chronicle.
 */
export async function createOfflineRecoveryBranch(
  options: OfflineRecoveryBranchOptions,
): Promise<OfflineRecoveryBranchResult> {
  const anchorCount = Number(!!options.messageId)
    + Number(!!options.contextId)
    + Number(options.messages !== undefined);
  if (anchorCount !== 1 && !(anchorCount === 0 && options.removeSuppressed === true)) {
    throw new Error('Specify exactly one of messageId, contextId, or messages');
  }
  const count = options.messages === undefined ? undefined : Math.floor(options.messages);
  if (count !== undefined && (!Number.isFinite(count) || count < 1)) {
    throw new Error('messages must be a positive integer');
  }
  // The marks choice is checked as the live methods check it, before the
  // store is opened: a malformed one would otherwise mark every removed
  // message.
  const marks = checkedDiscordAwarenessMarks(options.marks);

  const store = JsStore.openOrCreate({ path: options.storePath });
  let contextManager: ContextManager | null = null;
  try {
    contextManager = await ContextManager.open({
      store,
      namespace: options.namespace ?? `agents/${options.agentName}`,
    });

    const total = contextManager.getMessageCount();
    if (count !== undefined && count >= total) {
      throw new Error(
        `Cannot remove ${count} message(s) — history has ${total}; at least one must remain.`,
      );
    }

    let target: StoredWindowMessage;
    let targetIndex: number;
    let removedCount: number;
    let carriers: DiscordMessageMetadataCarrier[];
    // Once the agent's window was presented (#291), the branch cut is the
    // write that presented the anchor (branchSequenceOf), not the anchor's
    // own place in the record: the rows stored after the anchor and before
    // that write stay on the branch, and those the window took after the
    // anchor are arrivals again there. Only the rows stored after the cut
    // are removed, and only they are counted, carried and checked.
    const presented = contextManager.windowMode() === 'presented';
    const firstRemovedAfter = (index: number, anchor: StoredWindowMessage): number => presented
      ? firstIndexAfterCut(contextManager!, index, total, contextManager!.branchSequenceOf(anchor.id))
      : index + 1;

    if (options.messageId) {
      // Search backward in bounded windows: recovery anchors are normally near
      // the tail, and even a very large Chronicle is never materialized all at
      // once. If an adaptive strategy sharded the Discord message, choosing the
      // newest matching shard keeps the complete message at the branch point.
      const anchorId = normalizeDiscordMessageId(options.messageId);
      const located = findDiscordMessageFromTail(contextManager, total, anchorId);
      if (!located) {
        throw new Error(
          `Discord message ${anchorId} is not an addressable message in this context.`,
        );
      }
      target = located.message;
      targetIndex = located.index;
      const firstRemoved = firstRemovedAfter(targetIndex, target);
      removedCount = total - firstRemoved;
      carriers = collectDiscordCarriers(contextManager, firstRemoved, total);
    } else if (options.contextId) {
      const located = findInternalMessageFromTail(contextManager, total, options.contextId.trim());
      if (!located) {
        throw new Error(`Internal context message ${options.contextId} was not found.`);
      }
      target = located.message;
      targetIndex = located.index;
      const firstRemoved = firstRemovedAfter(targetIndex, target);
      removedCount = total - firstRemoved;
      carriers = collectDiscordCarriers(contextManager, firstRemoved, total);
    } else if (presented && count !== undefined) {
      // Counted back in the agent's window, whose order isn't the record's:
      // the anchor is the window's row `count` before its newest. Only the
      // rows of the context's own slot count, as the live undo counts them:
      // the anchor is looked for in that slot, and a window index can name
      // a row of a slot the agent observed (the residents' rows in a
      // persistent subconscious's window). The one context opened here
      // merges no other slot, so its listing holds none of those today; the
      // count doesn't lean on that.
      const window = contextManager.getPresentedMessages().filter((row) => contextManager!.getMessage(row.id) !== null);
      if (count! >= window.length) {
        throw new Error(
          `Cannot remove ${count} message(s) — history has ${window.length}; at least one must remain.`,
        );
      }
      const anchor = window[window.length - 1 - count!]!;
      const located = findInternalMessageFromTail(contextManager, total, String(anchor.id));
      if (!located) {
        throw new Error(`The recovery anchor ${String(anchor.id)}, ${count} back in the window, is not in this context's record.`);
      }
      target = located.message;
      targetIndex = located.index;
      const firstRemoved = firstRemovedAfter(targetIndex, target);
      removedCount = total - firstRemoved;
      carriers = collectDiscordCarriers(contextManager, firstRemoved, total);
    } else {
      // Count mode remains for compatibility. Read only the target plus suffix,
      // avoiding full-history materialization and attachment blob inflation.
      // With no anchor (removeSuppressed alone), the target is the newest row,
      // on a presented window too: nothing is cut, the branch starting at the
      // head.
      const dropping = count ?? 0;
      const window = contextManager.getMessageWindow(total - dropping - 1, dropping + 1, {
        resolveBlobs: false,
      }).messages;
      const countTarget = window[0];
      const discarded = window.slice(1);
      if (!countTarget || discarded.length !== dropping) {
        throw new Error('Could not read the requested recovery window from Chronicle');
      }
      target = countTarget;
      targetIndex = total - dropping - 1;
      removedCount = dropping;
      carriers = discarded.map(addressingOnly);
    }

    validateAnchorBoundary(contextManager, targetIndex, total, target);

    // The rows the branch keeps are the record's first `total -
    // removedCount`: a suppression may name any of them, those stored after
    // the anchor and kept by a presented window's cut too (in the record
    // before a presentation, the last kept row is the anchor).
    const suppression = buildSuppressionPlan(
      contextManager,
      total - removedCount - 1,
      options.suppressMessageIds ?? [],
      options.suppressRanges ?? [],
      options.removeSuppressed === true,
    );
    // A run with no anchor cuts nothing, so there is no anchor to name and
    // nothing returns: one with nothing to suppress makes a branch at the
    // head, as on a legacy window.
    const afterCut = presented && anchorCount > 0 ? windowAfterCut(contextManager, target) : undefined;
    const returnedToArrivals = afterCut?.returned.filter((id) => !suppression.ids.has(String(id))).length;
    if (afterCut && removedCount === 0 && suppression.intervals.length === 0 && afterCut.returned.length === 0) {
      refuseIneffectiveCut(target, afterCut.kept, options.agentName);
    }
    validateRemovalIntegrity(
      contextManager,
      total,
      [
        ...(removedCount > 0 ? [{
          start: total - removedCount,
          end: total - 1,
          fromId: '',
          toId: '',
        }] : []),
        ...suppression.intervals,
      ],
    );
    carriers = [...carriers, ...suppression.carriers];
    const addressable = extractDiscordAwarenessRefs(carriers, options.discordServerId).length;
    const selection = selectDiscordAwarenessRefs(carriers, marks, options.discordServerId);
    const refs = selection.refs;

    const sourceBranch = store.currentBranch().name;
    const held = new Set(store.listBranches().map((branch) => branch.name));
    const targetBranch = options.branchName
      ?? firstFreeBranchName(`recovery/${options.agentName}/${Date.now()}`, (name) => held.has(name));
    if (targetBranch === sourceBranch) {
      throw new Error('Recovery branch name must differ from the active source branch');
    }
    // A known collision is refused before anything is prepared.
    if (store.listBranches().some((branch) => branch.name === targetBranch)) {
      throw new Error(`Recovery branch ${targetBranch} already exists; choose another --branch`);
    }
    const outboxPath = options.outboxPath
      ?? defaultDiscordAwarenessOutboxPath(options.storePath);

    const result: OfflineRecoveryBranchResult = {
      dryRun: options.dryRun === true,
      sourceBranch,
      targetBranch,
      messagesRemoved: removedCount,
      messagesSuppressed: suppression.messageCount,
      ...(presented ? { returnedToArrivals: returnedToArrivals ?? 0 } : {}),
      discordAddressable: addressable,
      marksScope: marks === 'none' ? 'none' : marks.scope,
      discordMarkersQueued: refs.length,
      refs,
      unmarked: selection.unmarked,
      notRemoved: selection.notRemoved,
      outboxPath,
    };
    if (options.dryRun) return result;

    // The host is stopped, so this process is the ledger's only writer.
    const outbox = new DiscordAwarenessOutbox(outboxPath, { store });
    const batch = await outbox.prepare({
      agentName: options.agentName,
      sourceBranch,
      targetBranch,
      refs,
      scope: marks === 'none' ? 'none' : marks.scope,
      unmarked: selection.unmarked,
      notRemoved: selection.notRemoved,
      emoji: options.emoji ?? DEFAULT_DISCORD_AWARENESS_EMOJI,
      // Merely seeing targetBranch active does not prove branch-local
      // suppressions finished: a start on it applies them again while the
      // batch is prepared. Only the recovery may activate it, after every
      // removal below succeeds.
      suppressionIntervals: suppression.intervals.map((interval) => ({
        fromId: String(interval.fromId),
        toId: String(interval.toId),
      })),
    });

    let createdBranch: string | undefined;
    try {
      // branchAt uses the target message's origin sequence. With no anchor
      // nothing is rewound, so the branch starts at the head instead: what
      // was written after the newest message, a removal or a summary, stays.
      // No message content is compiled or submitted to Membrane during this
      // operation. Creating the branch is part of the body: a failure here
      // settles the batch like a failed switch or redaction.
      createdBranch = anchorCount === 0
        ? store.createBranchAt(targetBranch, sourceBranch, store.currentSequence()).name
        : contextManager.branchAt(target.id, targetBranch);
      await contextManager.switchBranch(createdBranch);
      // Each interval is removed by its messages' ids, so the order doesn't
      // change the result. removeStoredInterval takes a single message outside
      // any body through removeMessage, and a shard or a longer interval as a
      // range, which refuses one that splits a body.
      for (const interval of [...suppression.intervals].reverse()) {
        removeStoredInterval(contextManager, interval.fromId, interval.toId);
      }
    } catch (error) {
      // A partially suppressed branch is not safe to boot into. Preserve it
      // for diagnosis, but put Chronicle back on the untouched source branch.
      // Once the source is confirmed, the batch is retired (discard syncs the
      // restored state before it records that): its surgery never happened.
      // If it can't be confirmed, the batch stays prepared as the body's
      // record: a start on its target branch finishes a suppression's
      // removals, since its body is in effect there, and a start retires the
      // batch, none of its marks sent. The error says which, and names the
      // branch.
      const failure = error instanceof Error ? error.message : String(error);
      let restore = '';
      try {
        if (store.currentBranch().name !== sourceBranch) await contextManager.switchBranch(sourceBranch);
      } catch (restoreError) {
        restore = `; restoring ${sourceBranch} failed: ${boundDiscordAwarenessText(
          restoreError instanceof Error ? restoreError.message : String(restoreError),
        )}`;
      }
      const sourceConfirmed = store.currentBranch().name === sourceBranch;
      let retire = '';
      // A batch with marks never sends them once kept: the recovery, run
      // again, chooses them again.
      const redo = batch && batch.refs.length > 0
        ? '. To apply its marks, run the recovery again onto a new --branch, choosing them again' : '';
      if (batch) {
        if (!sourceConfirmed) {
          // The recovery starts from the store's current branch, which this
          // one couldn't put back: a run from there would start from the fork.
          const redoFromSource = batch.refs.length > 0
            ? `. To apply its marks, redo it from ${sourceBranch}, choosing them again: the recovery starts from the ` +
              `store's current branch, which isn't ${sourceBranch} now, so start the host, switch to ${sourceBranch} ` +
              'through the host API\'s branch.switch, stop the host, and run the recovery again onto a new --branch'
            : '';
          retire = `; awareness batch ${batch.id} kept, since the source branch could not be confirmed: ` +
            (suppression.intervals.length > 0
              ? `a start on ${targetBranch} finishes its removals and retires it`
              : 'the next start retires it') + `, none of its marks sent${redoFromSource}`;
        } else {
          try {
            await outbox.discard(batch.id);
            retire = `; awareness batch ${batch.id} retired, none of its marks sent${redo}`;
          } catch (discardError) {
            // None of its marks is ever sent: a start retires it. A write that
            // fails leaves the batch as it was, prepared, as in the host's
            // retireAfterRestore. A suppression's removals stay pending for
            // its target branch: a start on a branch with that name finishes
            // them.
            const detail = boundDiscordAwarenessText(
              discardError instanceof Error ? discardError.message : String(discardError),
            );
            const kept = `; awareness batch ${batch.id} could not be retired (${detail}); it stays prepared, none of ` +
              'its marks to be sent';
            if (suppression.intervals.length === 0) {
              retire = `${kept}, until the next start retires it${redo}`;
            } else {
              let forked = true;
              try {
                forked = store.listBranches().some((branch) => branch.name === targetBranch);
              } catch { /* unknown: say what a start on an existing branch would do */ }
              retire = `${kept}. Its removals stay pending for ${targetBranch}: a start on a branch with that ` +
                'name would finish them there and retire the batch' + (forked
                ? `, and ${targetBranch} is kept, so delete it unless you want that, through the host API's ` +
                  'branch.delete once the host runs'
                : '') + redo;
            }
          }
        }
      }
      // A partly suppressed branch is unsafe to start on, unless its batch was
      // kept because the source couldn't be confirmed: a start on it then
      // completes the suppression, as the batch's note says.
      const kept = createdBranch === undefined ? ''
        : suppression.intervals.length === 0 ? `; branch ${createdBranch} is kept for diagnosis`
        : batch && !sourceConfirmed ? `; branch ${createdBranch} is kept: it may be partly suppressed`
        : `; branch ${createdBranch} is kept for diagnosis: it may be partly suppressed, so don't start on it, and ` +
          'delete it once it has been looked at (the host API\'s branch.delete, once the host runs)';
      if (!restore && !retire && !kept) throw error;
      throw new Error(`${failure}${restore}${kept}${retire}`, { cause: error });
    }

    // The body change landed. Marker bookkeeping is reported apart from it
    // and never undoes it.
    const facts = {
      scope: (marks === 'none' ? 'none' : marks.scope) as SurgeryMarkerReceipt['scope'],
      unmarked: selection.unmarked,
      notRemoved: selection.notRemoved,
    };
    let markers: SurgeryMarkerReceipt = { ...facts, status: 'none', queued: 0 };
    let suppressionRecord: string | undefined;
    if (batch) {
      const settled = await outbox.settleActivation(batch.id);
      if (batch.refs.length > 0) {
        markers = settled.status === 'queued'
          ? { ...facts, status: 'queued', queued: settled.queued, batchId: batch.id }
          : { ...facts, status: 'not-scheduled', queued: 0, error: settled.error };
      } else if (settled.status === 'not-scheduled') {
        // A suppression-only batch carries no marks, and its activation
        // closes the body's resume record: if that failed, say what became of it.
        suppressionRecord = `the resume record (awareness batch ${batch.id}, no marks) could not be closed: ${settled.error}`;
      }
    }
    return { ...result, discordMarkersQueued: markers.queued, markers, ...(suppressionRecord ? { suppressionRecord } : {}) };
  } finally {
    contextManager?.close();
    store.close();
  }
}

const RECOVERY_SCAN_WINDOW = 1_000;
type StoredWindowMessage = ReturnType<ContextManager['getMessageWindow']>['messages'][number];

interface SuppressionInterval {
  start: number;
  end: number;
  fromId: StoredWindowMessage['id'];
  toId: StoredWindowMessage['id'];
}

interface MessageLocation {
  first: number;
  firstId: StoredWindowMessage['id'];
  /** Usually one run; multiple runs tolerate duplicate external metadata. */
  runs: SuppressionInterval[];
}

function normalizeDiscordMessageId(input: string): string {
  const trimmed = input.trim();
  const link = trimmed.match(/channels\/\d+\/\d+\/(\d+)/);
  return link?.[1] ?? trimmed;
}

function findDiscordMessageFromTail(
  contextManager: ContextManager,
  total: number,
  messageId: string,
): { message: ReturnType<ContextManager['getMessageWindow']>['messages'][number]; index: number } | null {
  let end = total;
  while (end > 0) {
    const start = Math.max(0, end - RECOVERY_SCAN_WINDOW);
    const messages = contextManager.getMessageWindow(start, end - start, {
      resolveBlobs: false,
    }).messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (String(messages[i].metadata?.messageId ?? '') === messageId) {
        return { message: messages[i], index: start + i };
      }
    }
    end = start;
  }
  return null;
}

function findInternalMessageFromTail(
  contextManager: ContextManager,
  total: number,
  contextId: string,
): { message: StoredWindowMessage; index: number } | null {
  let end = total;
  while (end > 0) {
    const start = Math.max(0, end - RECOVERY_SCAN_WINDOW);
    const messages = contextManager.getMessageWindow(start, end - start, {
      resolveBlobs: false,
    }).messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (String(messages[i].id) === contextId) {
        return { message: messages[i], index: start + i };
      }
    }
    end = start;
  }
  return null;
}

/**
 * The first slot index after `targetIndex` whose row was stored after
 * `cut`, or `total` when none was: the rows a branch cut at `cut` leaves
 * behind, the slot being in store order, start there. Read in bounded,
 * blob-free windows.
 */
function firstIndexAfterCut(
  contextManager: ContextManager,
  targetIndex: number,
  total: number,
  cut: number,
): number {
  for (let offset = targetIndex + 1; offset < total; offset += RECOVERY_SCAN_WINDOW) {
    const messages = contextManager.getMessageWindow(
      offset,
      Math.min(RECOVERY_SCAN_WINDOW, total - offset),
      { resolveBlobs: false },
    ).messages;
    const at = messages.findIndex((message) => message.sequence > cut);
    if (at >= 0) return offset + at;
  }
  return total;
}

/**
 * The rows after `target` in a presented window, as the live rollback reads
 * them (windowAfterCut): those the write that presented the target
 * presented too (`kept`, which no branch cut separates from it), and those
 * presented after that write but stored at or before it (`returned`, which
 * the cut keeps in the record and makes arrivals again). Read from the
 * window's newest row back to the target or the first row presented before
 * the cut (every row's cut grows in window order).
 */
function windowAfterCut(
  contextManager: ContextManager,
  target: StoredWindowMessage,
): { returned: StoredWindowMessage['id'][]; kept: StoredWindowMessage[] } {
  const cut = contextManager.branchSequenceOf(target.id);
  const window = contextManager.getPresentedMessages();
  const returned: StoredWindowMessage['id'][] = [];
  const kept: StoredWindowMessage[] = [];
  for (let i = window.length - 1; i >= 0; i--) {
    const row = window[i]!;
    if (row.id === target.id) break;
    const at = contextManager.branchSequenceOf(row.id);
    if (at < cut) break;
    if (at === cut) kept.unshift(row as StoredWindowMessage);
    else if (row.sequence <= cut) returned.unshift(row.id);
  }
  return { returned, kept };
}

/**
 * Refuses a recovery on a presented window that would change nothing, as
 * the live rollback refuses one: the cut at the write that presented the
 * anchor removes no row, and no row the window took after that write
 * becomes an arrival again (windowAfterCut). The rows that write presented
 * after the anchor (`kept`) name the way to take them out: a suppression in
 * the same recovery, which names a row by its Discord message id, and for a
 * row with none (an agent's round, a tool row) the live `suppressMessages`
 * by its row id. Each refusal says the recovery reads the agent's own slot
 * alone: a row of a slot it observes, which the live rollback weighs, isn't
 * weighed here.
 */
function refuseIneffectiveCut(
  target: StoredWindowMessage,
  kept: readonly StoredWindowMessage[],
  agentName: string,
): never {
  const anchorDiscordId = discordIdOf(target);
  const anchor = `${String(target.id)}${anchorDiscordId ? ` (Discord message ${anchorDiscordId})` : ''}`;
  const ownSlotOnly = `. Offline, only ${agentName}'s own slot is read: a row of a slot it observes, which the live rollback weighs, isn't weighed here.`;
  if (kept.length > 0) {
    const n = kept.length;
    const first = kept[0]!;
    const firstDiscordId = discordIdOf(first);
    const named = `${String(first.id)}${firstDiscordId ? `, Discord message ${firstDiscordId}` : ''}`;
    const unaddressed = kept.filter((row) => discordIdOf(row) === undefined).map((row) => String(row.id));
    // Every one, so following the advice leaves none of them in place.
    const rowIds = unaddressed.join(', ');
    const offline = 'in the same recovery (--suppress / suppressMessageIds, or a --suppress-range)';
    const live = `by row id with the live suppressMessages (${rowIds}) once the host runs, since the offline recovery ` +
      'suppresses only by Discord message id';
    const how = unaddressed.length === 0 ? `suppress ${n === 1 ? 'it' : 'them'} ${offline}`
      : unaddressed.length === n ? `suppress ${n === 1 ? 'it' : 'them'} ${live} and ${n === 1 ? 'it has none' : 'none of them has one'}`
      : `suppress the ${n - unaddressed.length} with a Discord message id ${offline}, and the ${unaddressed.length} ` +
        `without one ${live}`;
    throw new Error(
      `Recovery anchor ${anchor} was presented to ${agentName} in one write with the ${n} message${n === 1 ? '' : 's'} ` +
      `after it in its window (the first: ${named}), and a branch cut can't separate the rows one write presented, ` +
      `so a recovery anchored there would remove nothing; to take ${n === 1 ? 'that message' : 'those messages'} out, ` +
      how + ownSlotOnly,
    );
  }
  throw new Error(
    `Recovery anchor ${anchor} is already the tail of ${agentName}'s window: every message stored after it was ` +
    'stored before the write that presented it, where the branch is cut, and none entered the window after it, so ' +
    'a recovery anchored there would change nothing' + ownSlotOnly,
  );
}

function discordIdOf(message: { metadata?: Record<string, unknown> }): string | undefined {
  const id = message.metadata?.messageId;
  return id === undefined || id === null || id === '' ? undefined : String(id);
}

function validateAnchorBoundary(
  contextManager: ContextManager,
  targetIndex: number,
  total: number,
  target: StoredWindowMessage,
): void {
  if (targetIndex + 1 >= total) return;
  const next = contextManager.getMessageWindow(targetIndex + 1, 1, {
    resolveBlobs: false,
  }).messages[0];
  // A body continues only into a later shard of the same ingestion: a
  // reposted document shares its group id but starts a body of its own.
  if (continuesBody(target as BodyShard, next as BodyShard | undefined)) {
    throw new Error(
      `Recovery anchor ${String(target.id)} splits body group ${(target as BodyShard).bodyGroupId}; choose its final shard.`,
    );
  }
}

function validateRemovalIntegrity(
  contextManager: ContextManager,
  total: number,
  intervals: SuppressionInterval[],
): void {
  if (intervals.length === 0) return;
  // Sorted starts with each one's running furthest end, searched per row: a
  // store can hold a removal for every third row (--remove-suppressed).
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const reach: number[] = [];
  for (const interval of sorted) reach.push(Math.max(interval.end, reach.at(-1) ?? -1));
  const removed = (index: number) => {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sorted[mid]!.start <= index) lo = mid; else hi = mid - 1;
    }
    return sorted[lo]!.start <= index && index <= reach[lo]!;
  };
  const toolUses = new Map<string, boolean>();
  const toolResults = new Map<string, boolean>();
  // The message before, in store order: a selection splits a body when a
  // message continuing the one before it lands on the other side.
  let previous: { message: BodyShard; removed: boolean } | null = null;

  for (let offset = 0; offset < total; offset += RECOVERY_SCAN_WINDOW) {
    const messages = contextManager.getMessageWindow(
      offset,
      Math.min(RECOVERY_SCAN_WINDOW, total - offset),
      { resolveBlobs: false },
    ).messages;
    for (let i = 0; i < messages.length; i++) {
      const index = offset + i;
      const isRemoved = removed(index);
      const message = messages[i];
      const shard = message as BodyShard;
      if (previous && previous.removed !== isRemoved && continuesBody(previous.message, shard)) {
        throw new Error(
          `Recovery selection splits body group ${shard.bodyGroupId}; adjust the anchor or suppression boundary.`,
        );
      }
      previous = { message: shard, removed: isRemoved };
      for (const rawBlock of message.content) {
        const block = rawBlock as { type?: unknown; id?: unknown; toolUseId?: unknown };
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          toolUses.set(block.id, isRemoved);
        } else if (block.type === 'tool_result' && typeof block.toolUseId === 'string') {
          toolResults.set(block.toolUseId, isRemoved);
        }
      }
    }
  }

  for (const [toolUseId, useRemoved] of toolUses) {
    const resultRemoved = toolResults.get(toolUseId);
    if (resultRemoved !== undefined && resultRemoved !== useRemoved) {
      throw new Error(
        `Recovery selection would split tool exchange ${toolUseId}; suppress or retain both tool_use and tool_result.`,
      );
    }
  }
}

function buildSuppressionPlan(
  contextManager: ContextManager,
  lastKeptIndex: number,
  rawMessageIds: string[],
  rawRanges: Array<{ fromMessageId: string; toMessageId: string }>,
  removeSuppressed = false,
): { intervals: SuppressionInterval[]; carriers: DiscordMessageMetadataCarrier[]; messageCount: number; ids: Set<string> } {
  const messageIds = rawMessageIds.map(normalizeDiscordMessageId);
  const ranges = rawRanges.map((range) => ({
    fromMessageId: normalizeDiscordMessageId(range.fromMessageId),
    toMessageId: normalizeDiscordMessageId(range.toMessageId),
  }));
  const wanted = new Set([
    ...messageIds,
    ...ranges.flatMap((range) => [range.fromMessageId, range.toMessageId]),
  ]);
  if (wanted.size === 0 && !removeSuppressed) return { intervals: [], carriers: [], messageCount: 0, ids: new Set() };
  const stamped: SuppressionInterval[] = [];

  const locations = new Map<string, MessageLocation>();
  for (let offset = 0; offset <= lastKeptIndex; offset += RECOVERY_SCAN_WINDOW) {
    const messages = contextManager.getMessageWindow(
      offset,
      Math.min(RECOVERY_SCAN_WINDOW, lastKeptIndex - offset + 1),
      { resolveBlobs: false },
    ).messages;
    for (let i = 0; i < messages.length; i++) {
      if (removeSuppressed && suppressionRecordOf(messages[i].metadata as Record<string, unknown> | undefined)) {
        stamped.push({ start: offset + i, end: offset + i, fromId: messages[i].id, toId: messages[i].id });
      }
      const externalId = String(messages[i].metadata?.messageId ?? '');
      if (!wanted.has(externalId)) continue;
      const index = offset + i;
      const location = locations.get(externalId);
      if (!location) {
        const run = {
          start: index,
          end: index,
          fromId: messages[i].id,
          toId: messages[i].id,
        };
        locations.set(externalId, {
          first: index,
          firstId: messages[i].id,
          runs: [run],
        });
      } else {
        const lastRun = location.runs.at(-1)!;
        if (index === lastRun.end + 1) {
          lastRun.end = index;
          lastRun.toId = messages[i].id;
        } else {
          location.runs.push({
            start: index,
            end: index,
            fromId: messages[i].id,
            toId: messages[i].id,
          });
        }
      }
    }
  }

  for (const id of wanted) {
    if (!locations.has(id)) {
      throw new Error(
        `Suppression endpoint ${id} is not visible at the selected branch point.`,
      );
    }
  }

  const intervals: SuppressionInterval[] = [...stamped];
  for (const id of messageIds) {
    const location = locations.get(id)!;
    intervals.push(...location.runs.map((run) => ({ ...run })));
  }
  for (const range of ranges) {
    const from = locations.get(range.fromMessageId)!;
    const to = locations.get(range.toMessageId)!;
    const earlier = from.first <= to.first ? from : to;
    const later = from.first <= to.first ? to : from;
    // What's between the two messages, after the earlier one began and
    // before the later one began: from the earlier one's first stored copy
    // through the later one's first. Each end is every copy of it besides,
    // as a single suppression is, so a copy stored outside that span (a
    // write cut short and retried later) is taken on its own, and nothing
    // else stored after the later one began is taken.
    intervals.push({
      start: earlier.first,
      end: later.first,
      fromId: earlier.firstId,
      toId: later.firstId,
    });
    for (const end of [from, to]) intervals.push(...end.runs.map((run) => ({ ...run })));
  }

  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SuppressionInterval[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + 1) {
      if (interval.end > previous.end) {
        previous.end = interval.end;
        previous.toId = interval.toId;
      }
    } else {
      merged.push({ ...interval });
    }
  }

  const carriers: DiscordMessageMetadataCarrier[] = [];
  const ids = new Set<string>();
  for (const interval of merged) {
    carriers.push(...collectDiscordCarriers(contextManager, interval.start, interval.end + 1, ids));
  }
  return {
    intervals: merged,
    carriers,
    messageCount: merged.reduce((sum, interval) => sum + interval.end - interval.start + 1, 0),
    ids,
  };
}

/**
 * The addressing metadata of removed messages, read in bounded windows: only
 * the Discord address and the MCPL tags (for `addressed` selection) are kept,
 * never content. A sharded message may repeat its metadata across adjacent
 * records; selection dedupes by address. Each row's id is added to `ids`
 * where given.
 */
function collectDiscordCarriers(
  contextManager: ContextManager,
  start: number,
  end: number,
  ids?: Set<string>,
): DiscordMessageMetadataCarrier[] {
  const carriers: DiscordMessageMetadataCarrier[] = [];
  for (let offset = start; offset < end; offset += RECOVERY_SCAN_WINDOW) {
    const messages = contextManager.getMessageWindow(
      offset,
      Math.min(RECOVERY_SCAN_WINDOW, end - offset),
      { resolveBlobs: false },
    ).messages;
    carriers.push(...messages.map(addressingOnly));
    if (ids) for (const message of messages) ids.add(String(message.id));
  }
  return carriers;
}

function addressingOnly(message: { metadata?: Record<string, unknown> }): DiscordMessageMetadataCarrier {
  const metadata = message.metadata ?? {};
  return {
    metadata: {
      serverId: metadata.serverId,
      channelId: metadata.channelId,
      messageId: metadata.messageId,
      tags: metadata.tags,
    },
  };
}
