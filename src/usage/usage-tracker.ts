import type { SessionUsage, SessionUsageSnapshot, UsageUpdatedEvent } from './types.js';

function snapshotUsage(usage: SessionUsage): SessionUsage {
  return {
    ...usage,
    estimatedCost: usage.estimatedCost ? { ...usage.estimatedCost } : undefined,
  };
}

/** Add one count into a tally. `mixedCurrencies`: what's added is itself a
 *  tally in which two currencies met, as a stored entry being folded can be. */
function accumulateUsage(
  target: SessionUsage,
  tokens: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
  estimatedCost?: { total: number; currency: string },
  mixedCurrencies = false,
): void {
  // A provider's usage can lack a count (membrane 0.5.87's Bedrock stream
  // takes a message_delta's output count as reported); adding it would make
  // the total NaN, which is stored as null.
  const count = (n: number): number => (Number.isFinite(n) ? n : 0);
  target.inputTokens += count(tokens.inputTokens);
  target.outputTokens += count(tokens.outputTokens);
  target.cacheCreationTokens += count(tokens.cacheCreationTokens);
  target.cacheReadTokens += count(tokens.cacheReadTokens);
  // Costs in two currencies can't be summed, and a cost counted after they
  // met is only part of this tally's, so once they meet the cost stays absent.
  if (target.mixedCurrencies) return;
  if (mixedCurrencies || (estimatedCost && target.estimatedCost && target.estimatedCost.currency !== estimatedCost.currency)) {
    target.estimatedCost = undefined;
    target.mixedCurrencies = true;
    return;
  }
  if (estimatedCost) {
    target.estimatedCost ??= { total: 0, currency: estimatedCost.currency };
    target.estimatedCost.total += estimatedCost.total;
  }
}

function parseUsage(raw: unknown): SessionUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  // A count stored as null is a NaN total, as JSON stores one: an earlier
  // release could write it when a provider's usage lacked a count. The sum
  // before it was lost when it became NaN, so it reads as 0.
  const count = (v: unknown): number | undefined => (v === null ? 0 : typeof v === 'number' ? v : undefined);
  const inputTokens = count(o.inputTokens);
  const outputTokens = count(o.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens: typeof o.cacheCreationTokens === 'number' ? o.cacheCreationTokens : 0,
    cacheReadTokens: typeof o.cacheReadTokens === 'number' ? o.cacheReadTokens : 0,
    ...(o.mixedCurrencies === true
      ? { mixedCurrencies: true as const }
      : {
          estimatedCost: o.estimatedCost && typeof o.estimatedCost === 'object'
            ? { total: (o.estimatedCost as any).total, currency: (o.estimatedCost as any).currency }
            : undefined,
        }),
  };
}

export interface PersistedUsageState {
  totals: SessionUsage;
  byAgent: Array<{ agentName: string; usage: SessionUsage; inferenceCount: number; ephemeral?: true }>;
  inferenceCount: number;
}

/** The name the entry for every ephemeral agent's usage together goes by. */
export const EPHEMERAL_USAGE_NAME = 'ephemeral agents';

type Tally = { usage: SessionUsage; inferenceCount: number };

const emptyUsage = (): SessionUsage => ({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });

/** Add one tally's stored usage and inference count into another. */
function addTally(target: Tally, usage: SessionUsage, inferenceCount: number): void {
  accumulateUsage(target.usage, usage, usage.estimatedCost, usage.mixedCurrencies === true);
  target.inferenceCount += inferenceCount;
}

/** What keeps a stored usage record from restoring, or undefined when it
 *  restores: it must be an object whose totals are token counts and whose
 *  byAgent, if it has one, is a list. Its per-agent entries are checked one
 *  by one as they restore, and one that isn't an agent's usage is skipped. */
export function persistedUsageProblem(value: unknown): 'not a record' | 'totals' | 'byAgent' | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not a record';
  const { totals, byAgent } = value as { totals?: unknown; byAgent?: unknown };
  if (parseUsage(totals) === null) return 'totals';
  if (byAgent !== undefined && !Array.isArray(byAgent)) return 'byAgent';
  return undefined;
}

export class UsageTracker {
  private totals: SessionUsage = emptyUsage();
  private byAgent: Map<string, Tally> = new Map();
  /** Every ephemeral agent's usage together, kept apart from byAgent so an
   *  agent named EPHEMERAL_USAGE_NAME has an entry of its own. */
  private ephemeral: Tally | undefined;
  private inferenceCount = 0;
  private emitTrace: (event: UsageUpdatedEvent) => void;

  /** `wasEphemeral` names the stored unmarked entries that belong in the
   *  shared entry, such as an ephemeral agent's own from before ephemeral
   *  agents shared one: each restores into the shared entry instead. A stored
   *  entry marked ephemeral restores into it whatever its name. */
  constructor(opts: {
    emitTrace: (event: UsageUpdatedEvent) => void;
    restored?: PersistedUsageState;
    wasEphemeral?: (agentName: string) => boolean;
  }) {
    this.emitTrace = opts.emitTrace;
    if (opts.restored) {
      this.restoreFrom(opts.restored, opts.wasEphemeral ?? (() => false));
    }
  }

  private restoreFrom(state: PersistedUsageState, wasEphemeral: (agentName: string) => boolean): void {
    const totals = parseUsage(state.totals);
    if (!totals) return;
    this.totals = totals;
    this.inferenceCount = typeof state.inferenceCount === 'number' ? state.inferenceCount : 0;
    if (Array.isArray(state.byAgent)) {
      for (const item of state.byAgent as unknown[]) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as { agentName?: unknown; usage?: unknown; inferenceCount?: unknown; ephemeral?: unknown };
        const usage = parseUsage(entry.usage);
        if (usage && typeof entry.agentName === 'string') {
          const inferenceCount = typeof entry.inferenceCount === 'number' ? entry.inferenceCount : 0;
          if (entry.ephemeral === true || wasEphemeral(entry.agentName)) {
            this.ephemeral ??= { usage: emptyUsage(), inferenceCount: 0 };
            addTally(this.ephemeral, usage, inferenceCount);
          } else {
            this.byAgent.set(entry.agentName, { usage, inferenceCount });
          }
        }
      }
    }
    // The totals count every entry's inferences, so stored entries whose
    // costs are in two currencies, or one where two met, mean two met in the
    // totals too. A record written before mixedCurrencies shows it only so.
    const tallies = [...this.byAgent.values(), ...(this.ephemeral ? [this.ephemeral] : [])].map((tally) => tally.usage);
    const currencies = new Set(tallies.flatMap((usage) => (usage.estimatedCost ? [usage.estimatedCost.currency] : [])));
    if (this.totals.estimatedCost) currencies.add(this.totals.estimatedCost.currency);
    if (!this.totals.mixedCurrencies && (currencies.size > 1 || tallies.some((usage) => usage.mixedCurrencies))) {
      this.totals.estimatedCost = undefined;
      this.totals.mixedCurrencies = true;
    }
  }

  toJSON(): PersistedUsageState {
    return this.getSnapshot();
  }

  /** `ephemeral`: the agent is an ephemeral one, whose usage counts in the
   *  shared entry; the trace still names the agent. */
  onInferenceCompleted(agentName: string, usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }, estimatedCost?: { total: number; currency: string }, ephemeral = false): void {
    const tokens = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
    };

    accumulateUsage(this.totals, tokens, estimatedCost);
    this.inferenceCount++;

    let agent = ephemeral ? this.ephemeral : this.byAgent.get(agentName);
    if (!agent) {
      agent = { usage: emptyUsage(), inferenceCount: 0 };
      if (ephemeral) this.ephemeral = agent;
      else this.byAgent.set(agentName, agent);
    }
    accumulateUsage(agent.usage, tokens, estimatedCost);
    agent.inferenceCount++;

    this.emitTrace({
      type: 'usage:updated',
      totals: snapshotUsage(this.totals),
      agentName,
      inferenceCount: this.inferenceCount,
    });
  }

  getSnapshot(): SessionUsageSnapshot {
    const byAgent: SessionUsageSnapshot['byAgent'] = [...this.byAgent.entries()].map(([name, data]) => ({
      agentName: name,
      usage: snapshotUsage(data.usage),
      inferenceCount: data.inferenceCount,
    }));
    if (this.ephemeral) {
      byAgent.push({
        agentName: EPHEMERAL_USAGE_NAME,
        usage: snapshotUsage(this.ephemeral.usage),
        inferenceCount: this.ephemeral.inferenceCount,
        ephemeral: true,
      });
    }
    return { totals: snapshotUsage(this.totals), byAgent, inferenceCount: this.inferenceCount };
  }
}
