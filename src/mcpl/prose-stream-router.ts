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
 * must never see text that delivery would refuse to send.
 *
 * Two modes, mirroring proseRouting:
 *  - explicit: parse `>>` prefixes; initial target null (suppressed).
 *  - locus:    NO prefix parsing (locus mode's `>>` lines are plain text);
 *              everything streams to the frozen turn locus.
 */

export interface RoutedDelta {
  channelId: string;
  delta: string;
}

type State = 'line-start' | 'hybrid-indent' | 'maybe-prefix' | 'prefix-gap' | 'prefix-token' | 'after-token' | 'body';

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
      /** Initial destination: the frozen turn locus (locus mode) or null. */
      initialTarget: string | null;
      /** Resolve a `>>spec` to a channelId, or null (unresolved/ambiguous). */
      resolve: (spec: string) => string | null;
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
    return coalesce(out);
  }

  /** End of stream: flush any held line-start text (it can no longer become a
   *  complete prefix; an unterminated `>>tok` at EOF is routing metadata with
   *  no body — dropped, matching delivery which would deliver empty body). */
  finish(): RoutedDelta[] {
    const out: RoutedDelta[] = [];
    if (this.state === 'hybrid-indent') this.emit(this.held, out);
    if (this.state === 'maybe-prefix') {
      const full = this.opts.mode === 'hybrid' ? '>>>' : '>>';
      const arrows = this.opts.mode === 'hybrid' ? this.held.trimStart() : this.held;
      if (arrows !== full) this.emit(this.held, out);
    }
    // prefix-token / after-token at EOF: prefix without body — nothing to emit.
    this.held = '';
    this.state = 'line-start';
    return coalesce(out);
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
        if (this.opts.mode === 'hybrid' && (ch === ' ' || ch === '\t')) {
          this.state = 'hybrid-indent';
          this.held = ch;
          return;
        }
        if (ch === '>') { this.state = 'maybe-prefix'; this.held = '>'; return; }
        this.state = 'body';
        this.step(ch, out);
        return;

      case 'hybrid-indent':
        if (ch === ' ' || ch === '\t') { this.held += ch; return; }
        if (ch === '>') { this.held += ch; this.state = 'maybe-prefix'; return; }
        this.emit(this.held, out);
        this.held = '';
        this.state = 'body';
        this.step(ch, out);
        return;

      case 'maybe-prefix': {
        const prefix = this.opts.mode === 'hybrid' ? '>>>' : '>>';
        const arrows = this.opts.mode === 'hybrid' ? this.held.trimStart() : this.held;
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
          if (ch === '\n' || ch === ' ' || ch === '\t') {
            if (this.opts.mode === 'explicit') this.emit(this.held, out);
            this.held = '';
            this.state = ch === '\n' ? 'line-start' : 'body';
            if (ch !== '\n') this.step(ch, out);
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
        this.state = 'prefix-token';
        this.token = ch;
        return;

      case 'prefix-token':
        if (ch === ' ' || ch === '\t') { this.applyTarget(); this.state = 'after-token'; this.sawBang = false; return; }
        if (ch === '\n') { this.applyTarget(); this.state = 'line-start'; return; }
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
    this.accumulated.set(this.target, (this.accumulated.get(this.target) ?? '') + text);
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
