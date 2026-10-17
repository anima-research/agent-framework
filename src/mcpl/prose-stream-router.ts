/**
 * Incremental prose router: turns a stream of text deltas into a stream of
 * (channelId, delta) pairs AS THE MODEL GENERATES, so downstream surfaces
 * (voice synthesis, streamed message rendering, future platforms) can act on
 * speech before the turn completes. This is the emission half of MCPL Spec
 * 14.3 (`channels/outgoing/chunk`) — the notification has existed in the
 * wire types since the spec landed; this class is what finally produces it.
 *
 * Correctness contract: routing decisions here MUST agree with the delivery
 * path (deliverProse/parseProsePrefix). Both use prose-grammar.ts; this
 * router additionally holds back exactly as much text as needed to make each
 * line's decision — the start of a line is buffered only until it either
 * cannot be a `>>` prefix (flush as body) or its prefix token (+ optional
 * ` !` modifier) completes (switch target, swallow the prefix). Body text
 * after the decision point streams through with zero added latency.
 *
 * Suppression is fail-closed: text whose destination is unknown (explicit
 * mode before the first `>>`, unresolvable/ambiguous targets, `>>skip_reply`)
 * emits NOTHING — the delivery path will bounce/retain it; a stream consumer
 * must never see text that delivery would refuse to send. Text for a channel
 * the `speakable` option refuses emits nothing either.
 *
 * Three modes, mirroring proseRouting:
 *  - explicit: parse `>>` prefixes. A fresh turn's stream starts suppressed;
 *              a later stream of the turn starts at the turn's destination,
 *              and each round's end returns the stream to it (retarget).
 *  - hybrid:   parse `>>>` envelopes, with the turn's locus as the
 *              fallback. An envelope with no target, or `>>>skip_reply`,
 *              holds back what follows until a later `>>>` names a target.
 *  - locus:    NO prefix parsing (locus mode's `>>` lines are plain text);
 *              everything streams to the turn's locus.
 */

export interface RoutedDelta {
  channelId: string;
  delta: string;
}

type State = 'line-start' | 'indent' | 'maybe-prefix' | 'prefix-gap' | 'prefix-token' | 'after-token' | 'body';

/** Whitespace as the delivery path reads it (`trimStart()`, `\s`, `\S`). */
const isSpace = (ch: string): boolean => /\s/.test(ch);

export class ProseStreamRouter {
  private target: string | null;
  private state: State = 'line-start';
  private held = '';      // text held while a line's decision is pending
  private token = '';     // the >>spec token being accumulated
  private sawBang = false;
  private accumulated = new Map<string, string>();

  constructor(
    private opts: {
      /** explicit parses `>>`; hybrid parses `>>>` while retaining locus fallback. */
      mode: 'explicit' | 'hybrid' | 'locus';
      /** Initial destination: the turn's locus (locus and hybrid mode); in
       *  explicit mode, null on a fresh turn, or the turn's destination on a
       *  later stream of the turn. */
      initialTarget: string | null;
      /** Resolve a `>>spec` to a channelId, or null (unresolved/ambiguous). */
      resolve: (spec: string) => string | null;
      /** Whether speech may be published to this channel now. Text for a
       *  channel it refuses is neither emitted nor kept for outgoing/complete,
       *  so the stream's end can't carry it there should that change before
       *  the stream ends. Asked as the text is routed, while delivery decides
       *  when its round is admitted: text refused here stays out of the
       *  stream even if the channel accepts speech again by then and the
       *  round posts it. Every channel, when left out. */
      speakable?: (channelId: string) => boolean;
    },
  ) {
    this.target = opts.initialTarget;
    if (opts.mode === 'locus') this.state = 'body';
  }

  /** Per-channel full text emitted so far (for outgoing/complete). */
  byChannel(): ReadonlyMap<string, string> {
    return this.accumulated;
  }

  /**
   * Point the stream at a destination decided outside it. Explicit mode does
   * this at each round's end, with the turn's destination: a private round's
   * prefixes, a `>>skip_reply` envelope and a target that didn't resolve all
   * leave that destination as it was, though the stream followed them while
   * the round was written.
   */
  retarget(target: string | null): void {
    this.target = target;
  }

  /**
   * Drop everything routed so far and return to the constructed state.
   *
   * For a membrane refusal retry (RetryingEvent): the abandoned attempt's
   * prose must not survive into the new one, and `accumulated` feeds
   * outgoing/complete — leaving it would finalize text the model never
   * actually said in the attempt that stands.
   */
  reset(): void {
    this.target = this.opts.initialTarget;
    this.state = this.opts.mode === 'locus' ? 'body' : 'line-start';
    this.held = '';
    this.token = '';
    this.sawBang = false;
    this.accumulated = new Map();
  }

  feed(delta: string): RoutedDelta[] {
    const out: RoutedDelta[] = [];
    for (const ch of delta) this.step(ch, out);
    return this.keep(out);
  }

  /**
   * The end of a segment: one round's text, which delivery parses on its
   * own. The pending line's decision is made now. Held line-start text can
   * no longer become a prefix, so it is body. A prefix whose target is
   * written but has no body takes effect, as delivery reads `>>#chan` with
   * nothing after it. The next segment starts a new line.
   */
  endSegment(): RoutedDelta[] {
    const out: RoutedDelta[] = [];
    if (this.state === 'indent') this.emit(this.held, out);
    if (this.state === 'maybe-prefix') {
      // Hybrid's `>>>` with nothing after it is an envelope with no target:
      // delivery bounces it and holds back what follows. Anything else held
      // is text to delivery, explicit's bare `>>` included.
      const arrows = this.held.trimStart();
      if (this.opts.mode === 'hybrid' && arrows === '>>>') this.target = null;
      else this.emit(this.held, out);
    }
    // Hybrid's `>>>` and a gap with nothing after it: no target either.
    if (this.state === 'prefix-gap') this.target = null;
    if (this.state === 'prefix-token') this.applyTarget();
    this.held = '';
    this.token = '';
    if (this.opts.mode !== 'locus') this.state = 'line-start';
    return this.keep(out);
  }

  /** End of stream: the last segment ends. */
  finish(): RoutedDelta[] {
    return this.endSegment();
  }

  private step(ch: string, out: RoutedDelta[]): void {
    switch (this.state) {
      case 'body':
        if (ch === '\n' && this.opts.mode !== 'locus') {
          this.emit('\n', out);
          this.state = 'line-start';
        } else {
          this.emit(ch, out);
        }
        return;

      case 'line-start':
        // Indentation before a prefix is held until the line's decision: the
        // delivery path reads an indented `>>` (explicit) or `>>>` (hybrid)
        // line as a prefix too, after any leading whitespace.
        if (ch !== '\n' && isSpace(ch)) {
          this.state = 'indent';
          this.held = ch;
          return;
        }
        if (ch === '>') { this.state = 'maybe-prefix'; this.held = '>'; return; }
        this.state = 'body';
        this.step(ch, out);
        return;

      case 'indent':
        if (ch !== '\n' && isSpace(ch)) { this.held += ch; return; }
        if (ch === '>') { this.held += ch; this.state = 'maybe-prefix'; return; }
        this.emit(this.held, out);
        this.held = '';
        this.state = 'body';
        this.step(ch, out);
        return;

      case 'maybe-prefix': {
        const prefix = this.opts.mode === 'hybrid' ? '>>>' : '>>';
        const arrows = this.held.trimStart();
        if (ch === '>' && arrows.length < prefix.length) {
          this.held += '>';
          return;
        }
        if (arrows === prefix) {
          if (this.opts.mode === 'hybrid' && (ch === ' ' || ch === '\t')) {
            this.held = '';
            this.state = 'prefix-gap';
            return;
          }
          if (isSpace(ch)) {
            if (this.opts.mode === 'explicit') {
              // `>>` and then whitespace is a quoted arrow: body text, since
              // delivery's prefix needs a target right after the arrows.
              this.emit(this.held, out);
            } else {
              // `>>>` and then whitespace other than a space or tab (a
              // newline included) is an envelope with no target. Delivery
              // bounces it and holds back what follows until a later `>>>`
              // names a target.
              this.target = null;
            }
            // The whitespace itself is body, a newline included.
            this.held = '';
            this.state = 'body';
            this.step(ch, out);
            return;
          }
          this.state = 'prefix-token';
          this.token = ch;
          this.held = '';
          return;
        }
        this.emit(this.held, out);
        this.held = '';
        this.state = 'body';
        this.step(ch, out);
        return;
      }

      case 'prefix-gap':
        if (ch === ' ' || ch === '\t') return;
        if (ch === '\n') { this.target = null; this.state = 'line-start'; return; }
        // Other whitespace can't start hybrid's target (`[ \t]*\S+`): an
        // envelope with no target, as above.
        if (isSpace(ch)) { this.target = null; this.state = 'body'; return; }
        this.state = 'prefix-token';
        this.token = ch;
        return;

      case 'prefix-token':
        if (ch === ' ' || ch === '\t') { this.applyTarget(); this.state = 'after-token'; this.sawBang = false; return; }
        if (ch === '\n') { this.applyTarget(); this.state = 'line-start'; return; }
        // Any other whitespace ends the token too (`\S+`), and starts the
        // body: the grammar's gap after a token is spaces and tabs only.
        if (isSpace(ch)) { this.applyTarget(); this.state = 'body'; this.step(ch, out); return; }
        this.token += ch;
        return;

      case 'after-token':
        // Grammar: `([ \t]+!)?[ \t]*` — one optional `!` immediately after the
        // first whitespace run is the continue-turn modifier, not body.
        if (ch === ' ' || ch === '\t') return;
        if (ch === '\n') { this.state = 'line-start'; return; }
        if (ch === '!' && !this.sawBang) { this.sawBang = true; return; }
        this.state = 'body';
        this.step(ch, out);
        return;
    }
  }

  private applyTarget(): void {
    const spec = this.token;
    this.token = '';
    if (spec === 'skip_reply') { this.target = null; return; }
    this.target = this.opts.resolve(spec);
  }

  private emit(text: string, out: RoutedDelta[]): void {
    if (this.target === null || !text) return;
    out.push({ channelId: this.target, delta: text });
  }

  /**
   * What one feed or segment end routed, less any channel `speakable`
   * refuses, kept for outgoing/complete. A feed runs without yielding, so
   * one answer per channel holds for all of it.
   */
  private keep(out: RoutedDelta[]): RoutedDelta[] {
    const kept = coalesce(out).filter((d) => this.opts.speakable?.(d.channelId) ?? true);
    for (const d of kept) this.accumulated.set(d.channelId, (this.accumulated.get(d.channelId) ?? '') + d.delta);
    return kept;
  }
}

function coalesce(deltas: RoutedDelta[]): RoutedDelta[] {
  const out: RoutedDelta[] = [];
  for (const d of deltas) {
    const last = out[out.length - 1];
    if (last && last.channelId === d.channelId) last.delta += d.delta;
    else out.push({ ...d });
  }
  return out;
}
