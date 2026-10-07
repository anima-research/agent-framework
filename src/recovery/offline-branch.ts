import { JsStore } from '@animalabs/chronicle';
import type { SurgeryMarkerReceipt } from '../operator-log.js';
import { ContextManager } from '@animalabs/context-manager';
import {
  DEFAULT_DISCORD_AWARENESS_EMOJI,
  DiscordAwarenessOutbox,
  boundDiscordAwarenessText,
  defaultDiscordAwarenessOutboxPath,
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
  branchName?: string;
  /** Defaults to the primary-agent namespace `agents/{agentName}`. */
  namespace?: string;
  /** Use for old message records that do not carry metadata.serverId. */
  discordServerId?: string;
  /** A pre-journal awareness ledger to import (default: under the store). */
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
  /** Removed addressable messages left unmarked. */
  unmarked: number;
  /** Authorized refs (marks.refs) this recovery does not remove. */
  notRemoved: number;
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
    const marks = options.marks ?? 'none';
    const selection = selectDiscordAwarenessRefs(carriers, marks, options.discordServerId);
    const refs = selection.refs;

    const sourceBranch = store.currentBranch().name;
    const targetBranch = options.branchName
      ?? `recovery/${options.agentName}/${Date.now()}`;
    if (targetBranch === sourceBranch) {
      throw new Error('Recovery branch name must differ from the active source branch');
    }

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
    };
    if (options.dryRun) return result;

    // The journal lives in this store; the host is stopped, so this process
    // is its only writer.
    const outbox = new DiscordAwarenessOutbox(store, {
      legacyPath: options.outboxPath ?? defaultDiscordAwarenessOutboxPath(options.storePath),
    });
    const batch = outbox.prepare({
      agentName: options.agentName,
      sourceBranch,
      targetBranch,
      refs,
      scope: marks === 'none' ? 'none' : marks.scope,
      unmarked: selection.unmarked,
      notRemoved: selection.notRemoved,
      emoji: options.emoji ?? DEFAULT_DISCORD_AWARENESS_EMOJI,
      // Merely seeing targetBranch active does not prove branch-local
      // suppressions finished. Only the recovery operation may activate this
      // batch after every removal below succeeds.
      activationPolicy: suppression.intervals.length > 0 ? 'explicit' : 'target-branch',
      suppressionIntervals: suppression.intervals.map((interval) => ({
        fromId: String(interval.fromId),
        toId: String(interval.toId),
      })),
    });

    // branchAt uses the target message's origin sequence. No message content is
    // compiled or submitted to Membrane during this operation.
    const createdBranch = contextManager.branchAt(target.id, targetBranch);
    try {
      await contextManager.switchBranch(createdBranch);
      // Work from newest to oldest so earlier redactions never perturb the
      // live positions used by later range endpoints.
      for (const interval of [...suppression.intervals].reverse()) {
        if (interval.fromId === interval.toId) contextManager.removeMessage(interval.fromId);
        else contextManager.removeMessages(interval.fromId, interval.toId);
      }
    } catch (error) {
      // A partially suppressed branch is not safe to boot into. Preserve it
      // for diagnosis, but put Chronicle back on the untouched source branch.
      // Once the source is confirmed, the batch is retired (after the
      // restored state is synced): its surgery never happened. If it can't
      // be confirmed, the batch stays prepared as the unfinished body's
      // record (startup holds its marks, and resumes the body only on its
      // branch). The error says which.
      const failure = error instanceof Error ? error.message : String(error);
      let restore = '';
      try {
        if (store.currentBranch().name !== sourceBranch) await contextManager.switchBranch(sourceBranch);
      } catch (restoreError) {
        restore = `; restoring ${sourceBranch} failed: ${boundDiscordAwarenessText(
          restoreError instanceof Error ? restoreError.message : String(restoreError),
        )}`;
      }
      let retire = '';
      if (batch) {
        if (store.currentBranch().name !== sourceBranch) {
          retire = `; awareness batch ${batch.id} kept, since the source branch could not be confirmed`;
        } else {
          try {
            outbox.discard(batch.id);
          } catch (discardError) {
            retire = `; awareness batch ${batch.id} could not be retired (${boundDiscordAwarenessText(
              discardError instanceof Error ? discardError.message : String(discardError),
            )}); startup will hold it`;
          }
        }
      }
      if (!restore && !retire) throw error;
      throw new Error(`${failure}${restore}${retire}`, { cause: error });
    }

    // The body change landed. Marker bookkeeping is reported apart from it
    // and never undoes it.
    const facts = {
      scope: (marks === 'none' ? 'none' : marks.scope) as SurgeryMarkerReceipt['scope'],
      unmarked: selection.unmarked,
      notRemoved: selection.notRemoved,
    };
    let markers: SurgeryMarkerReceipt = { ...facts, status: 'none', queued: 0 };
    if (batch) {
      const settled = outbox.settleActivation(batch.id);
      if (batch.refs.length > 0) {
        markers = settled.status === 'queued'
          ? { ...facts, status: 'queued', queued: settled.queued, batchId: batch.id }
          : settled.status === 'not-scheduled'
            ? { ...facts, status: 'not-scheduled', queued: 0, error: settled.error }
            : { ...facts, status: 'unresolved', queued: 0, batchId: batch.id, error: settled.error };
      }
    }
    return { ...result, discordMarkersQueued: markers.queued, markers };
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
  last: number;
  firstId: StoredWindowMessage['id'];
  lastId: StoredWindowMessage['id'];
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
  const groupId = (target as StoredWindowMessage & { bodyGroupId?: string }).bodyGroupId;
  if (!groupId || targetIndex + 1 >= total) return;
  const next = contextManager.getMessageWindow(targetIndex + 1, 1, {
    resolveBlobs: false,
  }).messages[0] as (StoredWindowMessage & { bodyGroupId?: string }) | undefined;
  if (next?.bodyGroupId === groupId) {
    throw new Error(
      `Recovery anchor ${String(target.id)} splits body group ${groupId}; choose its final shard.`,
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
  const groupMembership = new Map<string, boolean>();

  for (let offset = 0; offset < total; offset += RECOVERY_SCAN_WINDOW) {
    const messages = contextManager.getMessageWindow(
      offset,
      Math.min(RECOVERY_SCAN_WINDOW, total - offset),
      { resolveBlobs: false },
    ).messages;
    for (let i = 0; i < messages.length; i++) {
      const index = offset + i;
      const isRemoved = removed(index);
      const message = messages[i] as StoredWindowMessage & { bodyGroupId?: string };
      if (message.bodyGroupId) {
        const prior = groupMembership.get(message.bodyGroupId);
        if (prior !== undefined && prior !== isRemoved) {
          throw new Error(
            `Recovery selection splits body group ${message.bodyGroupId}; adjust the anchor or suppression boundary.`,
          );
        }
        groupMembership.set(message.bodyGroupId, isRemoved);
      }
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
          last: index,
          firstId: messages[i].id,
          lastId: messages[i].id,
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
        location.last = index;
        location.lastId = messages[i].id;
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
    intervals.push({
      start: earlier.first,
      end: later.last,
      fromId: earlier.firstId,
      toId: later.lastId,
    });
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
