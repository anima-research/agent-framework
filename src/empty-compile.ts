/**
 * Thrown before a request is sent when its compile selected none of the
 * conversation the agent's window holds. Sent, such a request is refused by
 * the provider, or answered with a turn that sees none of the conversation.
 * Not retryable: the same store compiles to the same nothing.
 *
 * `operatorNote` gives the strategy, the budget's figures and what to
 * change.
 */
export class EmptyCompileError extends Error {
  readonly retryable = false;
  readonly budgetTokens: number;
  readonly reserveTokens: number;
  readonly strategy?: string;
  readonly operatorNote: string;

  constructor(budgetTokens: number, reserveTokens: number, strategy?: string) {
    super('the compile selected none of the conversation in the agent\'s window, so its request was not sent');
    const usable = budgetTokens - reserveTokens;
    this.name = 'EmptyCompileError';
    this.budgetTokens = budgetTokens;
    this.reserveTokens = reserveTokens;
    if (strategy !== undefined) this.strategy = strategy;
    const selector = strategy ? `the ${strategy} strategy` : 'the compile';
    this.operatorNote = usable <= 0
      ? `${selector} selected none of the agent's conversation; contextBudgetTokens (${budgetTokens}) leaves no room once ` +
        `${reserveTokens} tokens are held back for the reply and any pending tool results: raise contextBudgetTokens.`
      : `${selector} selected none of the agent's conversation; ` +
        `${usable} of a ${budgetTokens}-token budget is usable after ${reserveTokens} held back for the reply and any pending tool results: ` +
        'raise contextBudgetTokens, or check the strategy\'s selection.';
  }
}

/** Whether `err` is an EmptyCompileError, from this copy of the package or another, by its name. */
export function isEmptyCompileError(err: unknown): err is EmptyCompileError {
  return err instanceof EmptyCompileError || (err instanceof Error && err.name === 'EmptyCompileError');
}
