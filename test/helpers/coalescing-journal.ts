import type { CoalescingChange } from '../../src/mcpl/push-coalescer.js';
import type { CoalescingJournalItem, StoredCoalescingTable } from '../../src/mcpl/coalescing-store.js';

export const JOURNALED: StoredCoalescingTable = { version: 1, receipts: [], subjects: [], journal: 0 };

export const numbered = (changes: readonly CoalescingChange[]): CoalescingJournalItem[] =>
  changes.map((change, i) => ({ ...change, seq: i + 1 }));
