/**
 * autoContinue (AgentConfig.autoContinue, docs/auto-continue.md): a turn the
 * model ends itself is followed by another, unless it ended on a skip. This
 * module holds what doesn't need the framework: which ends continue, and the
 * row the next turn reads.
 */

import { NOTICE_TAG } from './notice-tags.js';

/** The reason on a continuation's wake (InferenceRequest.reason). */
export const AUTO_CONTINUE_REASON = 'auto-continue';

/**
 * Stop reasons of a turn the model ended itself. The others don't continue:
 * a refusal has its own handling (retries, rewind, the reaction), a
 * `max_tokens` end was cut off rather than chosen, and `no_progress` and
 * `round_limit` are the stall guard's verdict that the turn wasn't moving.
 */
export const AUTO_CONTINUE_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence']);

/**
 * The row a continuation's turn reads. It names the agent (residents read
 * one shared message slot), says another turn starts, says how to stop
 * (`stop`, an imperative such as "call skip_reply") and that anything written
 * without it is sent as usual, and, on the last continuation of a run, that
 * the agent waits for the next event after it. When some or all of the last
 * turn's closing words were held because a send that turn may already have
 * posted where they were going, it says so. Short,
 * neutral and event-shaped on purpose: it rides as a system row in the
 * window, where instruction blocks about output have tripped classifiers,
 * and wording that reads as a lapse or a budget invites a published reply.
 */
export function autoContinueNotice(opts: {
  agentName: string;
  stop: string;
  last: boolean;
  heldAfterSend?: boolean;
}): string {
  return `[${NOTICE_TAG.continue}] ${opts.agentName}, another turn starts now.` +
    (opts.heldAfterSend
      ? ' Some or all of your closing words last turn were held, not sent: a send that turn may already have posted where they were going.'
      : '') +
    ` If you're done, ${opts.stop}; anything you write without it is sent as usual.` +
    (opts.last ? ' This is the last continuation in a row: after this turn you wait for the next event either way.' : '');
}
