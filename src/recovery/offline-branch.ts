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
  /** Preferred: Discord message that remains as the last visible anchor. */
  messageId?: string;
  /** Exact internal ContextManager message ID that remains as the anchor. */
  contextId?: string;
  /** Backward-compatible alternative: remove the newest N context entries. */
  messages?: number;
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
 * History is scanned in bounded windows and blobs are not re-inlined. The
 * affected messages are never compiled and their content is never written to
 * the recovery outbox; only Discord addressing metadata leaves Chronicle.
 */
export async function createOfflineRecoveryBranch(
  options: OfflineRecoveryBranchOptions,
): Promise<OfflineRecoveryBranchResult> {
  const anchorCount = Number(!!options.messageId)
    + Number(!!options.contextId)
    + Number(options.messages !== undefined);
  if (anchorCount !== 1) {
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
      removedCount = total - located.index - 1;
      carriers = collectDiscordCarriers(contextManager, located.index + 1, total);
    } else if (options.contextId) {
      const located = findInternalMessageFromTail(contextManager, total, options.contextId.trim());
      if (!located) {
        throw new Error(`Internal context message ${options.contextId} was not found.`);
      }
      target = located.message;
      targetIndex = located.index;
      removedCount = total - located.index - 1;
      carriers = collectDiscordCarriers(contextManager, located.index + 1, total);
    } else {
      // Count mode remains for compatibility. Read only the target plus suffix,
      // avoiding full-history materialization and attachment blob inflation.
      const window = contextManager.getMessageWindow(total - count! - 1, count! + 1, {
        resolveBlobs: false,
      }).messages;
      const countTarget = window[0];
      const discarded = window.slice(1);
      if (!countTarget || discarded.length !== count) {
        throw new Error('Could not read the requested recovery window from Chronicle');
      }
      target = countTarget;
      targetIndex = total - count! - 1;
      removedCount = count!;
      carriers = discarded.map(addressingOnly);
    }

    validateAnchorBoundary(contextManager, targetIndex, total, target);

    const suppression = buildSuppressionPlan(
      contextManager,
      targetIndex,
      options.suppressMessageIds ?? [],
      options.suppressRanges ?? [],
    );
    validateRemovalIntegrity(
      contextManager,
      total,
      [
        ...(removedCount > 0 ? [{
          start: targetIndex + 1,
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
      // branchAt uses the target message's origin sequence. No message
      // content is compiled or submitted to Membrane during this operation.
      // Creating the branch is part of the body: a failure here settles the
      // batch like a failed switch or redaction.
      createdBranch = contextManager.branchAt(target.id, targetBranch);
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
  const removed = (index: number) => intervals.some((interval) =>
    index >= interval.start && index <= interval.end);
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
  targetIndex: number,
  rawMessageIds: string[],
  rawRanges: Array<{ fromMessageId: string; toMessageId: string }>,
): { intervals: SuppressionInterval[]; carriers: DiscordMessageMetadataCarrier[]; messageCount: number } {
  const messageIds = rawMessageIds.map(normalizeDiscordMessageId);
  const ranges = rawRanges.map((range) => ({
    fromMessageId: normalizeDiscordMessageId(range.fromMessageId),
    toMessageId: normalizeDiscordMessageId(range.toMessageId),
  }));
  const wanted = new Set([
    ...messageIds,
    ...ranges.flatMap((range) => [range.fromMessageId, range.toMessageId]),
  ]);
  if (wanted.size === 0) return { intervals: [], carriers: [], messageCount: 0 };

  const locations = new Map<string, MessageLocation>();
  for (let offset = 0; offset <= targetIndex; offset += RECOVERY_SCAN_WINDOW) {
    const messages = contextManager.getMessageWindow(
      offset,
      Math.min(RECOVERY_SCAN_WINDOW, targetIndex - offset + 1),
      { resolveBlobs: false },
    ).messages;
    for (let i = 0; i < messages.length; i++) {
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

  const intervals: SuppressionInterval[] = [];
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
  for (const interval of merged) {
    carriers.push(...collectDiscordCarriers(contextManager, interval.start, interval.end + 1));
  }
  return {
    intervals: merged,
    carriers,
    messageCount: merged.reduce((sum, interval) => sum + interval.end - interval.start + 1, 0),
  };
}

/**
 * The addressing metadata of removed messages, read in bounded windows: only
 * the Discord address and the MCPL tags (for `addressed` selection) are kept,
 * never content. A sharded message may repeat its metadata across adjacent
 * records; selection dedupes by address.
 */
function collectDiscordCarriers(
  contextManager: ContextManager,
  start: number,
  end: number,
): DiscordMessageMetadataCarrier[] {
  const carriers: DiscordMessageMetadataCarrier[] = [];
  for (let offset = start; offset < end; offset += RECOVERY_SCAN_WINDOW) {
    const messages = contextManager.getMessageWindow(
      offset,
      Math.min(RECOVERY_SCAN_WINDOW, end - offset),
      { resolveBlobs: false },
    ).messages;
    carriers.push(...messages.map(addressingOnly));
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
