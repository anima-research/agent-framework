/**
 * history--folds: when your rendered context changed resolution, which spans
 * changed, and what the rounds that confirmed them cost — read from the
 * context manager's fold journal (shelf-381). Nothing here is ever injected
 * into context; the journal is only read when this tool is called.
 */

import type { ContextManager, FoldChange, FoldForm, FoldLayoutRun, FoldReceipt } from '@animalabs/context-manager';
import type { ToolDefinition, ToolResult } from '../../types/events.js';

export interface FoldsInput {
  since?: string;
  limit?: number;
  branch?: string;
}

export const FOLDS_TOOL: ToolDefinition = {
  name: 'folds',
  description:
    'Your fold record: each time a provider round that stood showed you history at a different ' +
    'resolution than the previous one on the same branch, one receipt lists every run of messages ' +
    'whose form changed — raw, partial raw (cut), a summary (its level, id and method), a different ' +
    'summary, or omitted from the window — with store sequences and message ids, estimated tokens ' +
    'before and after, the cause when recorded, and that round\'s provider usage (input, cache read, ' +
    'cache write; unknown when not reported). That usage belongs to the whole round: no part of it is ' +
    'the cost of the fold, and what a fold lost is not measured — compare a summary with its source ' +
    'through `extract`. Messages that arrived since the previous round are arrivals, not folds. The ' +
    'first receipt on a branch is a baseline: the layout as rendered then, with history before it ' +
    'unknown. Each receipt describes the spans as rendered when it was written, even if messages were ' +
    'edited or removed since. Newest first.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      since: { type: 'string', description: 'A receipt id (only receipts after it) or an ISO 8601 time (receipts accepted at or after it).' },
      limit: { type: 'number', description: 'Max receipts (default 10, cap 100).' },
      branch: { type: 'string', description: 'Branch name; your current branch when omitted. Any branch the journal has seen, including a deleted one.' },
    },
  },
};

function formText(form: FoldForm): string {
  if (form.form === 'raw') return form.partial ? 'raw (partial)' : 'raw';
  if (form.form === 'omitted') return 'omitted';
  const ids = form.summaries
    .map((s) => `${s.id} L${s.level}${s.method !== 'unknown' ? ` ${s.method}` : ''}${s.partial ? ' (cut)' : ''}`)
    .join(', ');
  return `summary L${form.level} [${ids}]`;
}

function spanText(first: FoldChange['first'], last: FoldChange['last'], messages: number | undefined): string {
  const span = first.sequence === last.sequence ? `#${first.sequence}` : `#${first.sequence}–#${last.sequence}`;
  const count = messages !== undefined ? `, ${messages} message${messages === 1 ? '' : 's'}` : '';
  return `${span} (${first.messageId}${first.messageId !== last.messageId ? ` … ${last.messageId}` : ''}${count})`;
}

function changeLine(change: FoldChange): string {
  return `${spanText(change.first, change.last, change.messages)}: ${formText(change.before)} → ${formText(change.after)} ` +
    `(≈${change.estimatedTokensBefore} → ≈${change.estimatedTokensAfter} tokens)`;
}

function runLine(run: FoldLayoutRun): string {
  return `${spanText(run.first, run.last, run.messages)}: ${formText(run.form)} (≈${run.estimatedTokens} tokens)`;
}

/** How a strategy can render history, as a sentence. */
export function foldingSentence(strategy: string, forms: ReadonlyArray<'raw' | 'summary' | 'omitted'> | null): string {
  if (!forms) return `The ${strategy} strategy does not report its rendered layout, so no fold receipts are kept for it.`;
  if (!forms.includes('summary') && !forms.includes('omitted')) return `The ${strategy} strategy never folds: it renders all history raw.`;
  if (!forms.includes('summary')) {
    return `The ${strategy} strategy never summarizes: it renders history raw and leaves out what does not fit, which receipts report as omitted.`;
  }
  return `The ${strategy} strategy folds history into summaries and can leave spans out; receipts record each change.`;
}

export function handleFolds(cm: ContextManager, input: FoldsInput): ToolResult {
  const forms = cm.describeRenderedForms();
  const result = cm.listFoldReceipts({
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
  });
  const newest = result.receipts[0];
  const source = newest ? newest.source : null;
  const receipts = result.receipts.map((r: FoldReceipt) => ({
    id: r.id,
    kind: r.kind,
    acceptedAt: r.acceptedAt,
    strategy: r.strategy,
    cause: r.cause,
    renderedTokens: r.renderedTokens,
    roundUsage: { input: r.usage.input, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite },
    ...(r.kind === 'baseline'
      ? { historyBefore: 'unknown', layout: (r.layout ?? []).map(runLine) }
      : { changes: (r.changes ?? []).map(changeLine) }),
    ...(source && JSON.stringify(r.source) !== JSON.stringify(source) ? { source: r.source } : {}),
  }));
  return {
    success: true,
    data: {
      branch: result.branch,
      latestReceiptId: result.latestId,
      folding: foldingSentence(forms.strategy, forms.forms),
      ...(source ? { source } : {}),
      receipts,
      ...(result.note ? { note: result.note } : {}),
      ...(receipts.length === 0 && !result.note ? { note: 'No receipts on this branch yet (none since `since`, if given).' } : {}),
    },
  };
}
