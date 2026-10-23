/**
 * A capacity storm on one model: the provider answering turn calls with
 * overloaded errors (HTTP 529, the retry decision's `overloaded` class). A
 * storm is provider-wide, so it is held for every agent calling that model
 * rather than retried inside each call: membrane retries nothing on a turn
 * call the framework drives (`retry: false`), and the framework holds each
 * agent on the model
 * until its own release point, with backoff into minutes, until a call on
 * the model succeeds.
 *
 * The schedule is the retry decision's overloaded class (membrane's
 * `@animalabs/membrane/retry`, delayFor), on membrane's own overloaded
 * settings (10 s, doubling, at most 5 minutes), stepped once a round: step n
 * is attempt n, with no attempt bound, since a storm holds rather than gives
 * up. Each agent's release point is its own draw of the class's equal
 * jitter, in the second half of the current step, so the agents on a model
 * try spread through it rather than together: the first try's 529 starts
 * the next step and holds every agent not yet released under it. A 529 from
 * a call sent before the current step began joins the storm without
 * stepping it, so one round's failures from many agents step it once.
 *
 * A storm nothing steps or ends lapses (STORM_LAPSE_MS): once every agent on
 * the model has gone quiet, no call is left that could tell whether the
 * model still answers 529, so a later 529 arms a storm of its own, from the
 * first step, rather than stepping one from long ago.
 *
 * This is bookkeeping only, in memory: a restart, or stop(), forgets a
 * storm, and the first turn after it tries at once. Holding turns, sleeping
 * an ephemeral run and clearing holds at a success are the framework's.
 */

import { delayFor, MEMBRANE_RETRY_SETTINGS, type RetrySettings } from '@animalabs/membrane/retry';

/**
 * How long a storm stands with nothing stepping it, after the later of its
 * current step's end (every agent's point in it has passed) and the last call
 * sent into it: by then, going by how long overloaded errors take to come
 * back, each call sent into it has brought back its 529, which would have
 * stepped it, or its answer, which would have ended it. A proxy's log of 527
 * overloaded errors from Claude models, recorded June to October 2026, had
 * each back within 207 s of its send (half within 2.7 s, 99 in 100 within
 * 98 s), 52 of them mid-stream; none took longer.
 *  - Too short: a late 529 finds the storm lapsed and arms nothing, so its
 *    turn's retry is the error policy's: a turn on its last try, or under a
 *    host's policy that doesn't retry, ends. The next 529 arms a storm from
 *    the first step: shorter steps into a model still overloaded.
 *  - Too long: a quiet storm's next 529, after a recovery nothing saw, steps
 *    it on rather than arming one at the first step, so its agents wait a
 *    longer step than they need; no turn ends for it.
 */
export const STORM_LAPSE_MS = 300_000;

export interface ProviderStorm {
  readonly model: string;
  /** When the storm began (its first 529). */
  readonly since: number;
  /** The round the current step belongs to. Rounds are numbered across every
   *  storm and every storm's end, so a call stamped in an earlier storm's
   *  round, or before an earlier storm armed and ended, never matches. */
  round: number;
  /** The current step, from 1: the retry decision's attempt. */
  step: number;
  /** The current step's length, the decision's un-jittered delay at `step`. */
  stepMs: number;
  stepStartedAt: number;
  /** When a turn call was last sent into the storm (sent), or its arming. */
  lastSentAt: number;
  /** The provider's words from the latest 529, bounded by the caller. */
  reason: string;
  /** Whether the storm's long-storm alert has gone. */
  alerted: boolean;
  /** Each agent's release point in the current round, set when the round
   *  first asks for it. Cleared when the step advances. A point is a
   *  reservation, not a hold: whether its agent still waits for it is the
   *  framework's to say. */
  readonly releaseAt: Map<string, number>;
}

export type StormChange = 'armed' | 'advanced' | 'joined';

export class ProviderStorms {
  /** The settings the storm's steps are drawn on, by the decision's
   *  overloaded class: membrane's own. */
  settings: RetrySettings = { overloaded: MEMBRANE_RETRY_SETTINGS.overloaded };
  random: () => number = Math.random;
  /** How long a storm nothing steps stands (STORM_LAPSE_MS). */
  lapseMs = STORM_LAPSE_MS;
  /** Told of each lapse, when a read finds it, so it can be said. */
  onLapse: ((storm: ProviderStorm, now: number) => void) | undefined;

  private readonly storms = new Map<string, ProviderStorm>();
  /** For each model whose storm has ended, the round its end took. */
  private readonly ended = new Map<string, number>();
  private rounds = 0;

  /** The round current on `model`, for stamping a call: the storm's, or with
   *  none on it, the round its last storm's end took (undefined if it never
   *  had one). */
  roundOf(model: string, now = Date.now()): number | undefined {
    return this.live(model, now)?.round ?? this.ended.get(model);
  }

  /** A turn call to `model` goes out now: its round, as roundOf, and the
   *  storm's lapse counts from it. */
  sent(model: string, now = Date.now()): number | undefined {
    const storm = this.live(model, now);
    if (storm) storm.lastSentAt = Math.max(storm.lastSentAt, now);
    return this.roundOf(model, now);
  }

  /** When `storm` lapses if nothing steps it or sends into it first. */
  lapsesAt(storm: ProviderStorm): number {
    return Math.max(storm.stepStartedAt + storm.stepMs, storm.lastSentAt) + this.lapseMs;
  }

  get(model: string, now = Date.now()): ProviderStorm | undefined {
    return this.live(model, now);
  }

  list(now = Date.now()): ProviderStorm[] {
    return [...this.storms.keys()].flatMap((model) => this.live(model, now) ?? []);
  }

  /** The storm on `model`, unless it has lapsed (STORM_LAPSE_MS): a lapse
   *  ends it here, as an answer would, its end taking a round, so a call sent
   *  into it arms nothing later. */
  private live(model: string, now: number): ProviderStorm | undefined {
    const storm = this.storms.get(model);
    if (storm && now >= this.lapsesAt(storm)) {
      this.storms.delete(model);
      this.ended.set(model, ++this.rounds);
      this.onLapse?.(storm, now);
      return undefined;
    }
    return storm;
  }

  /**
   * An overloaded failure of a call to `model`, sent in round `sentRound`
   * (its roundOf, or what `sent` gave, as it was sent). With no storm on the
   * model, a call sent since the model's last storm ended (or with none ever)
   * arms one; a call sent before a storm that has since ended arms nothing
   * (undefined): a call on the model has answered since it was sent, or the
   * storm lapsed with the call still out. With a storm on the model, a call
   * sent in its current round steps it: the next step starts now, and every
   * agent's release point is taken again in it. Any other call joins it as
   * it is, its agent held to its point like every agent on the model,
   * however old the call.
   */
  failed(model: string, sentRound: number | undefined, reason: string, now = Date.now()): { storm: ProviderStorm; change: StormChange } | undefined {
    const storm = this.live(model, now);
    if (!storm) {
      if (sentRound !== this.ended.get(model)) return undefined;
      const armed: ProviderStorm = {
        model, since: now, round: ++this.rounds, step: 1, stepMs: this.stepLength(1), stepStartedAt: now,
        lastSentAt: now, reason, alerted: false, releaseAt: new Map(),
      };
      this.storms.set(model, armed);
      return { storm: armed, change: 'armed' };
    }
    storm.reason = reason;
    if (sentRound !== storm.round) return { storm, change: 'joined' };
    storm.round = ++this.rounds;
    storm.step += 1;
    storm.stepMs = this.stepLength(storm.step);
    storm.stepStartedAt = now;
    storm.releaseAt.clear();
    return { storm, change: 'advanced' };
  }

  /**
   * When the storm on `model` releases `agentName`: its point in the current
   * round, taken the first time the round asks. Undefined when no storm is
   * on the model or the point has passed, so the agent may call.
   */
  holdUntil(agentName: string, model: string, now = Date.now()): number | undefined {
    const storm = this.live(model, now);
    if (!storm) return undefined;
    let at = storm.releaseAt.get(agentName);
    if (at === undefined) {
      at = storm.stepStartedAt + delayFor('overloaded', storm.step, this.settings, this.random).delayMs;
      storm.releaseAt.set(agentName, at);
    }
    return at > now ? at : undefined;
  }

  /**
   * An operator's release of `agentName` from the storm on `model`: the
   * agent may call now. Its success clears the storm for every agent; its
   * 529 holds it again. Only an agent the storm holds is released: one with
   * a point still ahead in this round, or one the framework says it holds
   * (`held`: an ephemeral run asleep in the storm, whose point a step may
   * have cleared). Returns the point it had (undefined if none), or null
   * when the storm holds no such agent (or there is no storm on the model).
   */
  release(agentName: string, model: string, now = Date.now(), held = false): { until: number | undefined } | null {
    const storm = this.live(model, now);
    const until = storm?.releaseAt.get(agentName);
    if (!storm || (!held && (until === undefined || until <= now))) return null;
    storm.releaseAt.set(agentName, now);
    return { until };
  }

  /** A call on `model` succeeded: the storm, if any, is over, and its end
   *  takes a round (roundOf). Returns it. */
  succeeded(model: string, now = Date.now()): ProviderStorm | undefined {
    const storm = this.live(model, now);
    if (storm) {
      this.storms.delete(model);
      this.ended.set(model, ++this.rounds);
    }
    return storm;
  }

  private stepLength(step: number): number {
    return delayFor('overloaded', step, this.settings).nominalMs;
  }

  /** Forget every storm, as a restart does. */
  clear(): void {
    this.storms.clear();
    this.ended.clear();
  }
}
