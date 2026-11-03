import { logValue } from './log-value.js';

/**
 * At most one host line a minute for a refusal a server keeps repeating for
 * as long as a standing condition lasts: messages for a channel it never
 * registered, or channel-scoped pushes to a channel it hasn't declared or may
 * not use. A server that never registered a busy channel would otherwise
 * print a line for every message in it. Only the line is held back: every
 * refusal is still answered and traced. Each lane keeps its own records, as
 * its lines are its own.
 *
 * Per server and channel, the first refusal prints. After that a refusal
 * prints only once a minute has passed since that channel's last line, and
 * its line names how many were held back since. The minute is timed with a
 * monotonic clock, so a step of the wall clock can't silence a channel. A
 * refusal within a minute of the channel's last line is counted into its
 * next line, whatever happens to the channel in between (it may be
 * registered, unregistered or reconnected).
 *
 * A record is keyed by the channel as its line prints it (logValue), so two
 * ids share one exactly when their lines name them alike, which only ids
 * over 256 units can. The records cover the 1,000 most recently refused
 * channels: a new channel evicts the least recently refused one, with its
 * minute and any count it held, and that channel's next refusal prints as a
 * first.
 */
export class RefusalLines {
  /** By key, from the least recently refused channel to the most. */
  private readonly records = new Map<string, { at: number; since: number }>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Record one refusal for a server's channel. Returns null when its line is
   * held back, or else how many of the channel's refusals were held back
   * since its last line (0 for its first).
   */
  admit(serverId: string, channelId: string): number | null {
    // logValue never prints a NUL, so the key's last NUL keeps the two apart
    // whatever a server id holds.
    const key = `${serverId}\u0000${logValue(channelId)}`;
    const now = this.now();
    const record = this.records.get(key);
    if (record) this.records.delete(key);
    else if (this.records.size >= MAX_CHANNELS) this.records.delete(this.records.keys().next().value!);
    if (!record || now - record.at >= EVERY_MS) {
      this.records.set(key, { at: now, since: 0 });
      return record?.since ?? 0;
    }
    record.since++;
    this.records.set(key, record);
    return null;
  }
}

/** A channel's line prints at most this often. */
const EVERY_MS = 60_000;
/** The channels the records cover at once. */
const MAX_CHANNELS = 1_000;
