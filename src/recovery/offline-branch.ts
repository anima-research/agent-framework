import { JsStore } from '@animalabs/chronicle';
import { ContextManager, continuesBody, type BodyShard } from '@animalabs/context-manager';
import { removeStoredInterval } from '../stored-removal.js';
import { firstFreeBranchName } from '../branch-names.js';
import {
  DEFAULT_DISCORD_AWARENESS_EMOJI,
  DiscordAwarenessOutbox,
  defaultDiscordAwarenessOutboxPath,
  extractDiscordAwarenessRefs,
  type DiscordAwarenessRef,
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
  outboxPath?: string;
  emoji?: string;
  dryRun?: boolean;
}

export interface OfflineRecoveryBranchResult {
  dryRun: boolean;
  sourceBranch: string;
  targetBranch: string;
  messagesRemoved: number;
  messagesSuppressed: number;
  discordMarkersQueued: number;
  refs: DiscordAwarenessRef[];
  outboxPath: string;
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
    let refs: DiscordAwarenessRef[];

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
      refs = collectDiscordRefs(
        contextManager,
        located.index + 1,
        total,
        options.discordServerId,
      );
    } else if (options.contextId) {
      const located = findInternalMessageFromTail(contextManager, total, options.contextId.trim());
      if (!located) {
        throw new Error(`Internal context message ${options.contextId} was not found.`);
      }
      target = located.message;
      targetIndex = located.index;
      removedCount = total - located.index - 1;
      refs = collectDiscordRefs(
        contextManager,
        located.index + 1,
        total,
        options.discordServerId,
      );
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
      refs = extractDiscordAwarenessRefs(discarded, options.discordServerId);
    }

    validateAnchorBoundary(contextManager, targetIndex, total, target);

    const suppression = buildSuppressionPlan(
      contextManager,
      targetIndex,
      options.suppressMessageIds ?? [],
      options.suppressRanges ?? [],
      options.discordServerId,
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
    refs = dedupeDiscordRefs([...refs, ...suppression.refs]);

    const sourceBranch = store.currentBranch().name;
    const held = new Set(store.listBranches().map((branch) => branch.name));
    const targetBranch = options.branchName
      ?? firstFreeBranchName(`recovery/${options.agentName}/${Date.now()}`, (name) => held.has(name));
    if (targetBranch === sourceBranch) {
      throw new Error('Recovery branch name must differ from the active source branch');
    }
    const outboxPath = options.outboxPath
      ?? defaultDiscordAwarenessOutboxPath(options.storePath);

    const result: OfflineRecoveryBranchResult = {
      dryRun: options.dryRun === true,
      sourceBranch,
      targetBranch,
      messagesRemoved: removedCount,
      messagesSuppressed: suppression.messageCount,
      discordMarkersQueued: refs.length,
      refs,
      outboxPath,
    };
    if (options.dryRun) return result;

    const outbox = new DiscordAwarenessOutbox(outboxPath);
    const batch = outbox.prepare({
      agentName: options.agentName,
      sourceBranch,
      targetBranch,
      refs,
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
      // Each interval is removed by its messages' ids, so the order doesn't
      // change the result. removeStoredInterval takes a single message outside
      // any body through removeMessage, and a shard or a longer interval as a
      // range, which refuses one that splits a body.
      for (const interval of [...suppression.intervals].reverse()) {
        removeStoredInterval(contextManager, interval.fromId, interval.toId);
      }
      if (batch) outbox.activate(batch.id);
    } catch (error) {
      // A partially suppressed branch is not safe to boot into. Preserve it
      // for diagnosis, but leave Chronicle on the untouched source branch and
      // keep the explicit outbox batch non-deliverable.
      if (store.currentBranch().name === createdBranch) {
        await contextManager.switchBranch(sourceBranch);
      }
      throw error;
    }

    return result;
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
  forcedServerId?: string,
): { intervals: SuppressionInterval[]; refs: DiscordAwarenessRef[]; messageCount: number } {
  const messageIds = rawMessageIds.map(normalizeDiscordMessageId);
  const ranges = rawRanges.map((range) => ({
    fromMessageId: normalizeDiscordMessageId(range.fromMessageId),
    toMessageId: normalizeDiscordMessageId(range.toMessageId),
  }));
  const wanted = new Set([
    ...messageIds,
    ...ranges.flatMap((range) => [range.fromMessageId, range.toMessageId]),
  ]);
  if (wanted.size === 0) return { intervals: [], refs: [], messageCount: 0 };

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

  const refs: DiscordAwarenessRef[] = [];
  for (const interval of merged) {
    refs.push(...collectDiscordRefs(
      contextManager,
      interval.start,
      interval.end + 1,
      forcedServerId,
    ));
  }
  return {
    intervals: merged,
    refs: dedupeDiscordRefs(refs),
    messageCount: merged.reduce((sum, interval) => sum + interval.end - interval.start + 1, 0),
  };
}

function collectDiscordRefs(
  contextManager: ContextManager,
  start: number,
  end: number,
  forcedServerId?: string,
): DiscordAwarenessRef[] {
  const refs: DiscordAwarenessRef[] = [];
  for (let offset = start; offset < end; offset += RECOVERY_SCAN_WINDOW) {
    const messages = contextManager.getMessageWindow(
      offset,
      Math.min(RECOVERY_SCAN_WINDOW, end - offset),
      { resolveBlobs: false },
    ).messages;
    refs.push(...extractDiscordAwarenessRefs(messages, forcedServerId));
  }
  // A sharded message may repeat Discord metadata across adjacent records.
  return dedupeDiscordRefs(refs);
}

function dedupeDiscordRefs(refs: DiscordAwarenessRef[]): DiscordAwarenessRef[] {
  const deduped = new Map<string, DiscordAwarenessRef>();
  for (const ref of refs) {
    deduped.set(`${ref.serverId}\0${ref.channelId}\0${ref.messageId}`, ref);
  }
  return [...deduped.values()];
}
