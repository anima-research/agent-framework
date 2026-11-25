export interface NewestRow {
  sender?: string;
  channel?: string;
  toolResult?: 'own' | 'other';
  own?: 'tool-call' | 'message';
}

/**
 * Thrown before a request is sent when its compile selected none of the
 * conversation the agent's window holds. Sent, such a request is refused by
 * the provider, or answered with a turn that sees none of the conversation.
 * Not retryable: the same store compiles to the same nothing.
 *
 * `message` says so to the caller. `residentNote` is the reason the agent's
 * own `[inference-failed]` notice gives. Where the budget leaves room for any
 * conversation, it names the newest row from its metadata, block types and
 * own-row stamp, never its text, and only for the passthrough strategy does
 * it say what keeps the conversation out and what the agent can do. It isn't
 * enumerable, so printing the error leaves the row's sender and channel out.
 * `operatorNote` gives the operator the strategy, the budget's figures and
 * what to change, with no sender or channel: it can reach observers who may
 * not read messages.
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
    this.operatorNote = usable <= 0
      ? `${selector} selected none of the agent's conversation; contextBudgetTokens (${budgetTokens}) leaves no room once ` +
        `${reserveTokens} tokens are held back for the reply and any pending tool results: raise contextBudgetTokens.`
      : `${selector} selected none of the agent's conversation; ` +
        `${usable} of a ${budgetTokens}-token budget is usable after ${reserveTokens} held back for the reply and any pending tool results` +
        (passthrough
          ? `. If the newest message in its conversation is larger than ${usable} tokens, ` +
            'it and everything before it stay out of every compile until the budget can hold it or it is removed: raise contextBudgetTokens.'
          : ': raise contextBudgetTokens, or check the strategy\'s selection.');
  }
}

/** Whether `err` is an EmptyCompileError, from this copy of the package or another, by its name. */
export function isEmptyCompileError(err: unknown): err is EmptyCompileError {
  return err instanceof EmptyCompileError || (err instanceof Error && err.name === 'EmptyCompileError');
}

function residentReason(usable: number, newest: NewestRow, passthrough: boolean): string {
  if (usable <= 0) {
    return 'the context budget leaves no room for any of your conversation once the room held back for the reply ' +
      'and any pending tool results is set aside, so the budget must be raised';
  }
  const named = newestNamed(newest);
  if (!passthrough) return `none of your conversation reached your context${named ? `. ${named}` : ''}`;
  const that = named ? 'that message' : 'the newest message in your conversation';
  const remedy = newest.toolResult === 'own' ? ', and a call that returns less may fit'
    : newest.toolResult === undefined && newest.own === undefined && newest.sender !== undefined ? ', and you can ask for it in smaller parts'
    : '';
  return `none of your conversation reached your context.${named ? ` ${named}.` : ''} ` +
    `If ${that} is too large for your context, it and everything before it stay out of what you see ` +
    `until it is removed or your budget is raised${remedy}`;
}

function newestNamed(newest: NewestRow): string | undefined {
  const lead = 'The newest message in your conversation';
  if (newest.toolResult) return `${lead} is a tool result`;
  if (newest.own === 'tool-call') return `${lead} is your own tool call`;
  if (newest.own === 'message') return `${lead} is one you wrote`;
  if (newest.sender !== undefined && newest.channel !== undefined) return `${lead} is from ${newest.sender} in ${newest.channel}`;
  if (newest.sender !== undefined) return `${lead} is from ${newest.sender}`;
  if (newest.channel !== undefined) return `${lead} is in ${newest.channel}`;
  return undefined;
}
