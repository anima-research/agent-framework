export interface NewestRow {
  sender?: string;
  channel?: string;
  toolResult?: 'own' | 'other';
  tool?: string;
  own?: 'tool-call' | 'message';
  injection?: string;
  notice?: true;
  rowId?: string;
}

/**
 * Thrown before a request is sent when its compile selected none of the
 * conversation the agent's window holds. Sent, such a request is refused by
 * the provider, or answered with a turn that sees none of the conversation.
 * Not retryable: the same store compiles to the same nothing. A compile that
 * holds a summary counts as holding conversation, whatever the summary
 * covers.
 *
 * `message` says so to the caller. `residentNote` is the reason the agent's
 * own `[inference-failed]` notice gives. Where the budget leaves room for any
 * conversation, it names the newest row that the compile left out: a stored
 * context injection by its namespace, a framework notice as one, and any
 * other row from its metadata, block types and own-row stamp, never its
 * text. Only for the passthrough strategy does it say what keeps the
 * conversation out and what the agent can do. It isn't enumerable, so
 * printing the error leaves the row's sender and channel out.
 * `operatorNote` gives the operator the strategy, the budget's figures, the
 * row left out by its id and kind, and what to change, with no sender or
 * channel: it can reach observers who may not read messages.
 */
export class EmptyCompileError extends Error {
  readonly retryable = false;
  readonly budgetTokens: number;
  readonly reserveTokens: number;
  readonly strategy?: string;
  declare readonly residentNote: string;
  readonly operatorNote: string;

  constructor(budgetTokens: number, reserveTokens: number, newest: NewestRow = {}, strategy?: string) {
    super('the compile selected none of the conversation in the agent\'s window, so its request was not sent');
    const usable = budgetTokens - reserveTokens;
    const passthrough = strategy === 'passthrough';
    this.name = 'EmptyCompileError';
    this.budgetTokens = budgetTokens;
    this.reserveTokens = reserveTokens;
    if (strategy !== undefined) this.strategy = strategy;
    Object.defineProperty(this, 'residentNote', { value: residentReason(usable, newest, passthrough), enumerable: false });
    const selector = strategy ? `the ${strategy} strategy` : 'the compile';
    const leftOut = rowShown(newest);
    this.operatorNote = usable <= 0
      ? `${selector} selected none of the agent's conversation; contextBudgetTokens (${budgetTokens}) leaves no room once ` +
        `${reserveTokens} tokens are held back for the reply and any pending tool results: raise contextBudgetTokens.`
      : `${selector} selected none of the agent's conversation; ` +
        `${usable} of a ${budgetTokens}-token budget is usable after ${reserveTokens} held back for the reply and any pending tool results.` +
        (leftOut ? ` The newest row it left out is ${leftOut}.` : '') +
        (passthrough
          ? ` If that row is larger than ${usable} tokens, it and everything before it stay out of every compile ` +
            'until the budget can hold it or the row is removed: raise contextBudgetTokens, up to the model\'s own context window.'
          : ' Raise contextBudgetTokens, or check the strategy\'s selection.');
  }
}

/** Whether `err` is an EmptyCompileError, from this copy of the package or another, by its name. */
export function isEmptyCompileError(err: unknown): err is EmptyCompileError {
  return err instanceof EmptyCompileError || (err instanceof Error && err.name === 'EmptyCompileError');
}

function rowShown(newest: NewestRow): string | undefined {
  const id = newest.rowId !== undefined ? ` (row ${newest.rowId})` : '';
  if (newest.injection !== undefined) return `a context injection from ${newest.injection}${id}`;
  if (newest.notice) return `a framework notice${id}`;
  return id ? `a conversation row${id}` : undefined;
}

function residentReason(usable: number, newest: NewestRow, passthrough: boolean): string {
  if (usable <= 0) {
    return 'the context budget leaves no room for any of your conversation once the room held back for the reply ' +
      'and any pending tool results is set aside, so the budget must be raised';
  }
  const named = newestNamed(newest);
  if (!passthrough) return `none of your conversation reached your context${named ? `. ${named}` : ''}`;
  const that = newest.injection !== undefined || newest.notice ? 'that row' : named ? 'that message' : 'the newest message in your conversation';
  const remedy = newest.toolResult === 'own' ? ', and a call that returns less may fit'
    : newest.injection === undefined && !newest.notice && newest.toolResult === undefined && newest.own === undefined && newest.sender !== undefined
      ? ', and you can ask for it in smaller parts'
      : '';
  return `none of your conversation reached your context.${named ? ` ${named}.` : ''} ` +
    `If ${that} is too large for your context, it and everything before it stay out of what you see ` +
    `until it is removed or your budget is raised${remedy}`;
}

function newestNamed(newest: NewestRow): string | undefined {
  if (newest.injection !== undefined) return `The newest row left out of your context is a context injection from ${newest.injection}`;
  if (newest.notice) return 'The newest row left out of your context is a framework notice';
  const lead = 'The newest message in your conversation';
  if (newest.toolResult) return `${lead} is a tool result${newest.tool ? ` from ${newest.tool}` : ''}`;
  if (newest.own === 'tool-call') return `${lead} is your own tool call`;
  if (newest.own === 'message') return `${lead} is one you wrote`;
  if (newest.sender !== undefined && newest.channel !== undefined) return `${lead} is from ${newest.sender} in ${newest.channel}`;
  if (newest.sender !== undefined) return `${lead} is from ${newest.sender}`;
  if (newest.channel !== undefined) return `${lead} is in ${newest.channel}`;
  return undefined;
}
