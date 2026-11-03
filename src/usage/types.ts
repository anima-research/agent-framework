export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** The summed estimated cost of the inferences counted here that membrane
   *  priced, in one currency. An inference it couldn't price adds nothing, so
   *  this is a lower bound when any were unpriced. Absent when none was
   *  priced, and from the moment costs in two currencies meet here, since the
   *  two can't be summed, which `mixedCurrencies` records. */
  estimatedCost?: { total: number; currency: string };
  /** Set once inferences priced in two currencies have been counted here:
   *  `estimatedCost` stays absent from then on, since the two can't be
   *  summed and a later cost alone isn't this tally's. Stored and restored
   *  with it, and carried into the shared ephemeral entry when stored
   *  entries fold into it. */
  mixedCurrencies?: true;
}

export interface AgentUsage {
  agentName: string;
  usage: SessionUsage;
  inferenceCount: number;
  /** Set on the one entry that holds every ephemeral agent's usage together
   *  (agentName EPHEMERAL_USAGE_NAME), apart from any agent of that name. Each
   *  ephemeral agent runs under a new name, so an entry per name would grow
   *  the record by one for every run, for good. */
  ephemeral?: true;
}

export interface SessionUsageSnapshot {
  totals: SessionUsage;
  byAgent: AgentUsage[];
  inferenceCount: number;
}

/** Trace event emitted by UsageTracker after each inference completion. */
export interface UsageUpdatedEvent {
  type: 'usage:updated';
  totals: SessionUsage;
  agentName: string;
  inferenceCount: number;
}
