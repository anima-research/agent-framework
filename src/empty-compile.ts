/**
 * Thrown before a request is sent when a compile under the passthrough
 * strategy selected none of the conversation the agent's window holds.
 * Sent, such a request is refused by the provider, or answered with a turn
 * that sees none of the conversation. Not retryable: the same store compiles
 * to the same nothing.
 *
 * `operatorNote` gives the budget's figures, the newest row that the compile
 * left out, and what to change.
 */
export class EmptyCompileError extends Error {
  readonly retryable = false;
  readonly strategy = 'passthrough';
  readonly budgetTokens: number;
  readonly reserveTokens: number;
  readonly operatorNote: string;
  /** The id of the newest row that the compile left out, when the window holds one. */
  readonly rowId?: string;

  constructor(budgetTokens: number, reserveTokens: number, windowTokens?: number, rowId?: string) {
    super('the compile selected none of the conversation in the agent\'s window, so its request was not sent');
    const usable = budgetTokens - reserveTokens;
    this.name = 'EmptyCompileError';
    this.budgetTokens = budgetTokens;
    this.reserveTokens = reserveTokens;
    if (rowId !== undefined) this.rowId = rowId;
    const row = rowId !== undefined ? `; the newest row that the compile left out is ${rowId}` : '';
    const cap = windowTokens !== undefined ? `, up to the model's context window of ${windowTokens} tokens` : '';
    this.operatorNote = usable <= 0
      ? `the passthrough strategy selected none of the agent's conversation; contextBudgetTokens (${budgetTokens}) leaves no room once ` +
        `${reserveTokens} tokens are held back for the reply: raise contextBudgetTokens${cap}.`
      : `the passthrough strategy selected none of the agent's conversation; ` +
        `${usable} of a ${budgetTokens}-token budget is usable after ${reserveTokens} held back for the reply. ` +
        `A row too large for that room keeps the conversation out${row}: raise contextBudgetTokens${cap}, or remove that row.`;
  }
}

/** Whether `err` is an EmptyCompileError, from this copy of the package or another, by its name. */
export function isEmptyCompileError(err: unknown): err is EmptyCompileError {
  return err instanceof EmptyCompileError || (err instanceof Error && err.name === 'EmptyCompileError');
}
