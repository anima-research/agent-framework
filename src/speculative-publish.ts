/**
 * Speculative channel chunks (docs/speculative-channel-chunks.md): while the
 * model writes a `channel_publish` call to a channel that opted in
 * (`capabilities.streaming.speculative`), the call's `content` (or `text`)
 * argument goes to the channel's server as `channels/outgoing/chunk`
 * deltas, ahead of the publish, so a voice server can start speaking. The
 * publish stays authoritative: its success ends the stream with
 * `channels/outgoing/complete` carrying the full text, and anything else
 * (the call cut off, refused, failed, never run, or published elsewhere)
 * ends it with empty content and `cancelled: true`.
 *
 * This file holds the pure parts: an incremental reader of the call's
 * argument JSON as it streams (PublishArgsReader), and the streams of one
 * inference (SpeculativePublishStreams). The framework feeds them and the
 * channel registry sends what they produce.
 */

import type { ChannelRef } from './mcpl/channel-registry.js';

const SEND_KEYS = new Set(['content', 'text']);
const NAME_KEYS = new Set(['channelId', 'serverId']);

type ReaderState =
  | 'start' | 'key-or-end' | 'key-next' | 'key' | 'colon' | 'value' | 'string' | 'nested' | 'scalar' | 'after-value' | 'done' | 'failed';

/**
 * Reads a tool call's argument JSON fragment by fragment, as the provider
 * streams it (Anthropic `input_json_delta`). It follows the top-level object
 * only: `channelId` and `serverId` once their strings close, and the text of
 * the first of `content` / `text` as it arrives, with JSON escapes decoded
 * (`\n`, `\"`, `\uXXXX`, a surrogate pair split across fragments). Any other
 * value is skipped. Input that isn't a JSON object stops the reader
 * (`failed`); the finished call's own input stays authoritative.
 */
export class PublishArgsReader {
  channelId?: string;
  serverId?: string;
  /** Which of `content` / `text` is streamed: the first one met. */
  sendKey?: 'content' | 'text';
  /** Everything streamed of that value so far. */
  sent = '';
  /**
   * `channelId` or `serverId` came as something other than a string. Dispatch
   * reads such a selector its own way (a truthy one names no channel), so
   * nothing about the call's channel can be told from here.
   */
  badSelector = false;

  private state: ReaderState = 'start';
  private key = '';
  /** A name value (channelId, serverId) as it is read. */
  private value = '';
  /** The string value being read is the one streamed. */
  private streaming = false;
  /** The streamed value has closed; a repeat of its key isn't streamed. */
  private streamed = false;
  /** An escape being read: '' after the backslash, then 'u' and its hex digits. */
  private escape: string | null = null;
  /** A decoded high surrogate, held until its low half arrives. */
  private pendingHigh: string | null = null;
  /** Inside a skipped object or array: its depth, and whether in a string there. */
  private depth = 0;
  private nestedString = false;
  private nestedEscape = false;
  /** A skipped value's raw text (an object, an array, a number or a literal), checked when it closes. */
  private skipped = '';

  get failed(): boolean { return this.state === 'failed'; }
  /** The top-level object closed. */
  get done(): boolean { return this.state === 'done'; }

  /** Reads a fragment; returns the text of the streamed value it added. */
  push(fragment: string): string {
    let out = '';
    for (const ch of fragment) {
      if (this.state === 'done') {
        if (!isWhitespace(ch)) this.state = 'failed';
        continue;
      }
      if (this.state === 'failed') break;
      out += this.step(ch);
    }
    this.sent += out;
    return out;
  }

  /** A skipped value closed: it has to be valid JSON, or the call can't parse and won't run. */
  private closeSkipped(): string {
    const raw = this.skipped;
    this.skipped = '';
    try {
      JSON.parse(raw);
    } catch {
      return this.fail();
    }
    this.state = 'after-value';
    return '';
  }

  private fail(): string {
    this.state = 'failed';
    return '';
  }

  private step(ch: string): string {
    switch (this.state) {
      case 'start':
        if (isWhitespace(ch)) return '';
        if (ch === '{') { this.state = 'key-or-end'; return ''; }
        return this.fail();
      case 'key-or-end':
        if (isWhitespace(ch)) return '';
        if (ch === '"') { this.state = 'key'; this.key = ''; return ''; }
        if (ch === '}') { this.state = 'done'; return ''; }
        return this.fail();
      case 'key-next':
        // After a comma a key has to follow.
        if (isWhitespace(ch)) return '';
        if (ch === '"') { this.state = 'key'; this.key = ''; return ''; }
        return this.fail();
      case 'key': {
        const decoded = this.stringChar(ch);
        if (decoded === null) {
          this.key += this.pendingHigh ?? '';
          this.pendingHigh = null;
          this.state = 'colon';
          return '';
        }
        this.key += decoded;
        return '';
      }
      case 'colon':
        if (isWhitespace(ch)) return '';
        if (ch === ':') { this.state = 'value'; return ''; }
        return this.fail();
      case 'value':
        if (isWhitespace(ch)) return '';
        if (ch === '"') {
          this.state = 'string';
          this.value = '';
          if (SEND_KEYS.has(this.key) && this.sendKey === undefined) this.sendKey = this.key as 'content' | 'text';
          this.streaming = this.key === this.sendKey && !this.streamed;
          return '';
        }
        if (NAME_KEYS.has(this.key)) this.badSelector = true;
        if (ch === '{' || ch === '[') {
          this.state = 'nested';
          this.depth = 1;
          this.nestedString = false;
          this.nestedEscape = false;
          this.skipped = ch;
          return '';
        }
        if (/[-0-9tfn]/.test(ch)) { this.state = 'scalar'; this.skipped = ch; return ''; }
        return this.fail();
      case 'string': {
        const decoded = this.stringChar(ch);
        if (decoded === null) {
          // A lone high surrogate the string ends on is its last unit.
          const held = this.pendingHigh ?? '';
          this.pendingHigh = null;
          if (this.key === 'channelId') this.channelId = this.value + held;
          else if (this.key === 'serverId') this.serverId = this.value + held;
          const out = this.streaming ? held : '';
          if (this.streaming) this.streamed = true;
          this.streaming = false;
          this.state = 'after-value';
          return out;
        }
        if (NAME_KEYS.has(this.key)) this.value += decoded;
        return this.streaming ? decoded : '';
      }
      case 'nested':
        this.skipped += ch;
        if (this.nestedString) {
          if (this.nestedEscape) this.nestedEscape = false;
          else if (ch === '\\') this.nestedEscape = true;
          else if (ch === '"') this.nestedString = false;
          return '';
        }
        if (ch === '"') this.nestedString = true;
        else if (ch === '{' || ch === '[') this.depth++;
        else if (ch === '}' || ch === ']') {
          if (--this.depth === 0) return this.closeSkipped();
        }
        return '';
      case 'scalar':
        if (/[\w.+-]/.test(ch)) {
          this.skipped += ch;
          return '';
        }
        this.closeSkipped();
        return (this.state as ReaderState) === 'failed' ? '' : this.step(ch);
      case 'after-value':
        if (isWhitespace(ch)) return '';
        if (ch === ',') { this.state = 'key-next'; return ''; }
        if (ch === '}') { this.state = 'done'; return ''; }
        return this.fail();
      default:
        return '';
    }
  }

  /**
   * One character of a JSON string: its decoded text ('' while an escape or
   * a high surrogate is pending), or null at the closing quote.
   */
  private stringChar(ch: string): string | null {
    if (this.escape !== null) {
      if (this.escape === '') {
        if (ch === 'u') { this.escape = 'u'; return ''; }
        this.escape = null;
        const simple = SIMPLE_ESCAPES[ch];
        return simple === undefined ? this.fail() : this.unit(simple);
      }
      if (!/[0-9a-fA-F]/.test(ch)) { this.escape = null; return this.fail(); }
      this.escape += ch;
      if (this.escape.length < 5) return '';
      const unit = String.fromCharCode(parseInt(this.escape.slice(1), 16));
      this.escape = null;
      return this.unit(unit);
    }
    if (ch === '\\') { this.escape = ''; return ''; }
    if (ch === '"') return null;
    // JSON strings hold no raw control characters.
    if (ch < ' ') return this.fail();
    return this.unit(ch);
  }

  /** A decoded character, with a high surrogate held until what follows it. */
  private unit(text: string): string {
    const code = text.charCodeAt(0);
    const held = this.pendingHigh ?? '';
    this.pendingHigh = null;
    if (text.length === 1 && code >= 0xd800 && code <= 0xdbff) {
      this.pendingHigh = text;
      return held;
    }
    return held + text;
  }
}

/** JSON's whitespace: space, tab, line feed, carriage return. */
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** Where a speculative stream's messages go: the channel registry's side. */
export interface SpeculativeStreamSink {
  /**
   * The channel a call naming this channel publishes to, when that channel
   * takes speculative chunks (it opted in, and its server may stream);
   * null for any other, or a name that picks no single channel. `partial`:
   * the call is still being written and has no serverId yet, so one may
   * follow; only a name that can't come to mean another channel then
   * resolves.
   */
  target(named: { channelId: string; serverId?: string }, options?: { partial?: boolean }): ChannelRef | null;
  /** The same, for a finished call that names no channel: where its publish defaults to. */
  defaultTarget(input: Record<string, unknown>): ChannelRef | null;
  chunk(to: ChannelRef, streamId: string, seq: number, content: string): void;
  complete(to: ChannelRef, streamId: string, content: string, cancelled: boolean): void;
}

type StreamPhase = 'streaming' | 'called' | 'dispatched';

interface PublishStream {
  readonly toolId: string;
  readonly streamId: string;
  readonly reader: PublishArgsReader;
  phase: StreamPhase;
  /** The opted-in channel the chunks go to, once known. */
  target?: ChannelRef;
  /** Streams nothing more: its arguments stopped parsing, or its channel changed after chunks went out. */
  dead: boolean;
  /** Read but not yet sent: what arrived before the channel was known. */
  held: string;
  seq: number;
  /** The finished call's text, the one its publish posts. */
  finalText?: string;
}

const sameChannel = (a: ChannelRef, b: ChannelRef) => a.serverId === b.serverId && a.channelId === b.channelId;

/**
 * The speculative streams of one inference stream, one per `channel_publish`
 * call the model writes, keyed by the call's id.
 *
 * - streaming: the call is being written. Text of its `content` goes out as
 *   chunks once its channel is known (`channelId` read and, where it takes
 *   one, `serverId`; for a call that names none, the default once the call
 *   is finished); before that it is held. The channel is resolved again as
 *   arguments arrive: one that changes after chunks went out cancels the
 *   stream.
 * - called: the finished call arrived (onToolCalls).
 * - dispatched: its publish is under way (dispatch); `published` ends it.
 *
 * A stream ends exactly once: `complete` with the full text when the
 * publish was delivered to the channel the chunks went to, else `complete`
 * with empty content and `cancelled`. A call that sent no chunk ends with
 * nothing sent. The sink's sends never throw out of here.
 */
export class SpeculativePublishStreams {
  private readonly streams = new Map<string, PublishStream>();

  constructor(private readonly sink: SpeculativeStreamSink) {}

  /** A fragment of a call's argument JSON. Only `channel_publish` calls are read. */
  onInputDelta(toolId: string | undefined, toolName: string | undefined, fragment: string): void {
    if (!toolId || toolName !== 'channel_publish') return;
    let stream = this.streams.get(toolId);
    if (!stream) {
      stream = { toolId, streamId: `spec_${toolId}`, reader: new PublishArgsReader(), phase: 'streaming', dead: false, held: '', seq: 0 };
      this.streams.set(toolId, stream);
    }
    if (stream.phase !== 'streaming' || stream.dead) return;
    const text = stream.reader.push(fragment);
    if (stream.reader.failed || stream.reader.badSelector) {
      // Not JSON this reader follows (the call won't parse, so it won't run),
      // or a selector that isn't a string, which the publish reads otherwise.
      this.kill(stream);
      return;
    }
    stream.held += text;
    if (stream.reader.channelId !== undefined) {
      const serverId = stream.reader.serverId;
      const now = this.resolve(() => this.sink.target({
        channelId: stream.reader.channelId!,
        ...(serverId ? { serverId } : {}),
      }, serverId ? undefined : { partial: true }));
      if (!this.retarget(stream, now)) return;
    }
    this.flush(stream);
  }

  /**
   * A round's finished calls. A stream whose call isn't among them never ran
   * (the round was cut, or the call was dropped) and is cancelled. The
   * finished call's own arguments settle its channel: the one it names, or
   * its default where it names none.
   */
  onToolCalls(calls: ReadonlyArray<{ id: string; name: string; input?: unknown; unparseableInput?: string }>): void {
    const byId = new Map(calls.map((c) => [c.id, c]));
    for (const stream of [...this.streams.values()]) {
      if (stream.phase !== 'streaming') continue;
      const call = byId.get(stream.toolId);
      // A call membrane marked (its block cut off or out of order) is refused
      // at dispatch, so it never publishes.
      const input = (call?.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
      const badSelector = (['channelId', 'serverId'] as const).some((k) => input[k] !== undefined && typeof input[k] !== 'string');
      if (!call || call.name !== 'channel_publish' || stream.dead || call.unparseableInput !== undefined || badSelector) {
        this.cancel(stream);
        continue;
      }
      stream.phase = 'called';
      // The text the publish posts, read as it reads it (content ?? text).
      // Chunks that went out with other text (a text alias before content,
      // a repeated key) are cancelled.
      const posted = input.content ?? input.text;
      const text = typeof posted === 'string' ? posted : '';
      if (stream.seq > 0 && stream.reader.sent !== text) {
        this.cancel(stream);
        continue;
      }
      stream.finalText = text;
      const channelId = input.channelId;
      const final = typeof channelId === 'string'
        ? this.resolve(() => this.sink.target({
          channelId,
          ...(typeof input.serverId === 'string' && input.serverId ? { serverId: input.serverId } : {}),
        }))
        : this.resolve(() => this.sink.defaultTarget(input));
      if (!this.retarget(stream, final) || !stream.target) {
        this.cancel(stream);
        continue;
      }
      // Nothing went out yet: the finished call's text is what goes.
      if (stream.seq === 0) stream.held = text;
      this.flush(stream);
      if (stream.seq === 0) this.forget(stream);
    }
  }

  /** Whether a call has a stream still open. */
  has(callId: string): boolean {
    return this.streams.has(callId);
  }

  /**
   * The call's publish is starting: the stream it carries (so the server can
   * match the publish to the stream), when chunks went out for it, with the
   * channel they went to.
   */
  dispatch(callId: string): { streamId: string; channel: ChannelRef } | undefined {
    const stream = this.streams.get(callId);
    if (!stream || stream.phase === 'streaming') return undefined;
    stream.phase = 'dispatched';
    return stream.seq > 0 && stream.target ? { streamId: stream.streamId, channel: stream.target } : undefined;
  }

  /**
   * The call's publish ended: delivered to `destination`, or not. The stream
   * completes with the call's text when that is the channel it streamed to,
   * else it is cancelled.
   */
  published(callId: string, outcome: { delivered: boolean; destination?: ChannelRef }): void {
    const stream = this.streams.get(callId);
    if (!stream) return;
    const delivered = outcome.delivered && !!outcome.destination && !!stream.target
      && sameChannel(outcome.destination, stream.target);
    this.end(stream, delivered);
  }

  /** The call got its result some other way (refused before its publish, or never run): cancel. */
  settle(callId: string): void {
    const stream = this.streams.get(callId);
    if (stream) this.cancel(stream);
  }

  /**
   * The inference ended or restarted (a refusal retry): every stream whose
   * publish hasn't started is cancelled. Returns their call ids.
   */
  cancelPending(): string[] {
    const ended: string[] = [];
    for (const stream of [...this.streams.values()]) {
      if (stream.phase === 'dispatched') continue;
      ended.push(stream.toolId);
      this.cancel(stream);
    }
    return ended;
  }

  /**
   * The calls whose publish hasn't started and whose text already went out:
   * the ones cancelPending's cancel takes speech back from.
   */
  spokenPending(): string[] {
    return [...this.streams.values()]
      .filter((stream) => stream.phase !== 'dispatched' && stream.seq > 0 && !!stream.target)
      .map((stream) => stream.toolId);
  }

  get size(): number {
    return this.streams.size;
  }

  /**
   * The channel as resolved now. Before any chunk it simply becomes the
   * stream's (or none yet); after chunks went out, a different one (or none)
   * kills the stream. Returns whether the stream may go on.
   */
  private retarget(stream: PublishStream, now: ChannelRef | null): boolean {
    if (stream.target && now && sameChannel(stream.target, now)) return true;
    if (stream.seq > 0) {
      this.kill(stream);
      return false;
    }
    stream.target = now ?? undefined;
    return true;
  }

  /** Cancels what went out, and the call streams nothing more (its entry stays until its round ends). */
  private kill(stream: PublishStream): void {
    if (stream.target && stream.seq > 0) {
      const to = stream.target;
      this.send(() => this.sink.complete(to, stream.streamId, '', true));
    }
    stream.target = undefined;
    stream.dead = true;
  }

  private send(fn: () => void): void {
    try {
      fn();
    } catch { /* an observer surface: never disturb the turn */ }
  }

  private resolve(find: () => ChannelRef | null): ChannelRef | null {
    try {
      return find();
    } catch {
      return null;
    }
  }

  private flush(stream: PublishStream): void {
    if (!stream.target || !stream.held) return;
    const to = stream.target;
    const content = stream.held;
    stream.held = '';
    this.send(() => this.sink.chunk(to, stream.streamId, stream.seq, content));
    stream.seq++;
  }

  private cancel(stream: PublishStream): void {
    this.end(stream, false);
  }

  /** Ends a stream: completes it (delivered) or cancels it, where chunks went out. */
  private end(stream: PublishStream, delivered: boolean): void {
    this.forget(stream);
    if (!stream.target || stream.seq === 0) return;
    const to = stream.target;
    stream.target = undefined;
    this.send(() => this.sink.complete(to, stream.streamId, delivered ? stream.finalText ?? stream.reader.sent : '', !delivered));
  }

  private forget(stream: PublishStream): void {
    if (this.streams.get(stream.toolId) === stream) this.streams.delete(stream.toolId);
  }
}
