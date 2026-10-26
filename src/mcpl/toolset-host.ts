/**
 * MCPL RFC-014, host side: per server, the controller that feeds the
 * server's tool presence (tool-presence.ts) from what its connection reads,
 * sends toolsets/open, close and list, recovers from a lost rev, and renders
 * what changed; and the hub that holds every server's controller for the
 * meta-tools (toolsets-module.ts) and for reminders.
 *
 * Hint changes apply as their message is read (RFC §6.1); a static↔dynamic
 * move takes effect when a tools/list states it (§4.1), and the model's tool
 * list shows it at its next rebuild; until then the tool is called at either
 * place (§4.2). The connection's read tap hands
 * the controller every result of a hinted request (awaited or not, while no
 * more than 1,000 hinted requests await an answer), each tools/list whole, every push/event and every tools/hints, of the
 * current transport, synchronously and in arrival order, before anything
 * routes the message or anything read after it is handled.
 * What a message's changes did to the model's view is kept by the object
 * that carried them (`readChanges`), so whoever later handles that object
 * (the tool result, the push, the meta-tool) renders it next to the content.
 *
 * Reminders (RFC §8.3): after each compile built to send, the hub reads
 * which open toolsets' markers (`[server/toolset:instance]`) the request
 * carried. A marker an agent has had in view, gone from a later request
 * (compressed, or out of the window), makes a reminder due for that agent,
 * which the toolsets module gathers at its next start as a stored
 * `afterUser` injection.
 */
import { McplRequestError, type McplServerConnection, type HintRead } from './server-connection.js';
import type { McplServerConfig } from './types.js';
import { isToolAllowed } from './tool-policy.js';
import { redactServerText } from './protocol-family.js';
import { logDetail, logValueRedacted } from './log-value.js';
import {
  ToolPresence, emptyChange, isEmptyChange, keyOf,
  type ChangeSet, type MetaToolNames, type Presence,
} from './tool-presence.js';
import type { HintedTool } from './tool-signature.js';

/** The meta-tools' module, whose tools are `toolsets--open` and so on. */
export const TOOLSETS_MODULE = 'toolsets';
export const META_TOOL_NAMES: MetaToolNames = {
  open: `${TOOLSETS_MODULE}--open`,
  act: `${TOOLSETS_MODULE}--act`,
  look: `${TOOLSETS_MODULE}--look`,
  close: `${TOOLSETS_MODULE}--close`,
};

/** How long an open or close is waited for. A late result still applies when it's read. */
export const TOOLSET_REQUEST_TIMEOUT_MS = 60_000;
/** A toolsets/list after a (re)connect or in a recovery. */
const LIST_TIMEOUT_MS = 15_000;
/** A toolsets/list that only refreshes titles for look. */
const REFRESH_TIMEOUT_MS = 5_000;
/** A burst of anomalies is one recovery. */
const RECOVERY_DEBOUNCE_MS = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const metaHints = (res: Record<string, unknown>): unknown => (isObj(res._meta) ? res._meta['mcpl/hints'] : undefined);

export interface ToolsetHostDeps {
  /** A standalone notice into the conversation: a tools/hints change, a late
   *  result's, a reconnect's adoption, a recovery's. `invite`: it suggests an
   *  open. The host applies its usual rules for events. */
  notify(serverId: string, text: string, opts: { invite: boolean }): boolean;
  /** Whether the server's changes may be put into the conversation unasked
   *  (its `pushEvents` grant): notices and reminders. */
  canNotify(serverId: string): boolean;
  /** The operator's log. */
  log(line: string): void;
  /** How a static tool is named in the tool list (`prefix--tool`). */
  listedName(serverId: string, tool: string): string;
  /** Where the model's published tool list last put a server's tool:
   *  offered in it (static), listed but not offered (dynamic), or undefined
   *  where it isn't published. RFC §4.2: until its move applies, a tool
   *  keeps working where it is. */
  published?(serverId: string, tool: string): Presence | undefined;
}

/** One server's RFC-014 state and traffic. Lives as long as the server's
 *  configuration, across reconnects and the server's restarts (its `ended`
 *  ids and what the model was shown carry over), in memory only. */
export class ToolsetController {
  readonly presence: ToolPresence;
  private connection: McplServerConnection | null = null;
  /** The transport epoch the presence's revs belong to. */
  private epoch = -1;
  /** What applying a message's hints changed, by the object that carried them. */
  private readonly readChanges = new WeakMap<object, ChangeSet>();
  /** Results whose change no one has taken yet, in the order they were read, with their method (tellUnlessClaimed). */
  private readonly unclaimed = new Map<object, string>();
  /** eventIds of pushes read on this transport (bounded): a repeat's hints are ignored (RFC §6.1). */
  private seenEvents = new Set<string>();
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering = false;
  private recoverAgain = false;

  constructor(
    readonly serverId: string,
    private config: McplServerConfig,
    private readonly deps: ToolsetHostDeps,
  ) {
    this.presence = new ToolPresence(
      serverId,
      META_TOOL_NAMES,
      (tool) => isToolAllowed(tool, this.config),
      (tool) => deps.listedName(serverId, tool),
      (tool) => deps.published?.(serverId, tool),
    );
  }

  private log(line: string): void {
    this.deps.log(`${this.serverId}: ${line}`);
  }

  private field(value: unknown): string {
    return logValueRedacted(value, (text) => redactServerText(text, this.config));
  }

  private failure(error: unknown): string {
    return logDetail(redactServerText(error instanceof Error ? error.message : String(error), this.config));
  }

  /** A restart can bring a new configuration under the same id. */
  setConfig(config: McplServerConfig): void {
    this.config = config;
  }

  /** Tap this connection (a connect or a restart's new one). */
  attach(connection: McplServerConnection): void {
    if (this.connection !== connection) {
      this.connection?.setReadTap(null);
      // A new connection numbers its transports from 0 again.
      this.epoch = -1;
    }
    this.connection = connection;
    connection.setReadTap((read, epoch) => this.onRead(connection, read, epoch));
  }

  release(): void {
    if (this.connection) this.detach(this.connection);
  }

  /** The server's connection is gone for good (disconnected, removed). */
  detach(connection: McplServerConnection): void {
    if (this.connection !== connection) return;
    connection.setReadTap(null);
    this.connection = null;
    this.epoch = -1;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    // Nothing of it presents any more; what the agent was told (ended ids,
    // definitions shown) is kept for a next connection.
    this.presence.deactivate();
  }

  /** Whether the meta-tools speak for this server now. */
  get presents(): boolean {
    return this.presence.presents;
  }

  /** The live connection, for a request. */
  private live(): McplServerConnection {
    const c = this.connection;
    if (!c || !c.isConnected) throw new McplRequestError(`${this.serverId} is not connected right now; try again later`, 'not-sent');
    this.sync(c.transportEpoch, c);
    return c;
  }

  /**
   * A new transport: revs start over (RFC §6.1), and its advertisement says
   * whether hints are in effect. Read from the connection, which holds the
   * advertisement before its transport can deliver anything.
   */
  private sync(epoch: number, connection: McplServerConnection): void {
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    this.seenEvents = new Set();
    this.presence.beginConnection(connection.toolsetDeclarations, true);
  }

  // ── RFC §6.1: apply on arrival ──

  private onRead(connection: McplServerConnection, read: HintRead, epoch: number): void {
    if (connection !== this.connection) return;
    this.sync(epoch, connection);
    if (read.kind === 'result') {
      this.readResult(read.method, read.params, read.result as Record<string, unknown>, read.awaited, read.straddled === true);
      return;
    }
    if (!this.presence.active || !isObj(read.params)) return;
    const p = read.params;
    if (read.kind === 'hints') {
      const cs = this.applyHints(p, 'tools/hints');
      // Carrier 3: a change with nothing to say, told on its own.
      this.deliver(cs);
      return;
    }
    if (p.hints === undefined) return;
    // RFC §7: a push carrying hints is never coalesced; when its changes
    // would apply is undefined, so they're ignored and the state re-read.
    if (p.coalesce !== undefined && p.coalesce !== null) {
      this.log(`push ${this.field(p.eventId ?? '')} carries hints and coalesce (RFC-014 §7 forbids it): its hints are ignored; recovering`);
      this.scheduleRecovery();
      return;
    }
    // RFC §6.1: never retried, so a seen eventId is a duplicate whose hints applied once.
    const eventId = typeof p.eventId === 'string' || typeof p.eventId === 'number' ? String(p.eventId) : '';
    if (eventId) {
      if (this.seenEvents.has(eventId)) {
        this.log(`push ${this.field(eventId)} was read before: its hints are ignored`);
        return;
      }
      this.seenEvents.add(eventId);
      if (this.seenEvents.size > 1000) this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    // Applied now, before (and whatever) the host decides about the push.
    const cs = this.applyHints(p.hints, 'push');
    this.readChanges.set(p, cs);
    this.tellUnlessClaimed(p, cs, 'push/event');
  }

  private readResult(method: string, params: Record<string, unknown>, res: Record<string, unknown>, awaited: boolean, straddled: boolean): void {
    let cs: ChangeSet;
    switch (method) {
      case 'tools/list': {
        if (!Array.isArray(res.tools)) return;
        cs = this.readToolList(res.tools as HintedTool[], res);
        if (straddled && !this.recovering) {
          this.log('tools/list pages carried different revs, so its earlier pages are older than changes read between them: recovering');
          this.scheduleRecovery();
        }
        this.deliver(cs);
        return;
      }
      case 'toolsets/list':
        cs = this.readToolsetList(res);
        break;
      case 'toolsets/open': {
        if (!this.presence.active) return;
        cs = this.applyHints(metaHints(res), 'toolsets/open');
        const before = this.presence.view();
        const toolset = typeof res.toolset === 'string' ? res.toolset : String(params.toolset ?? '');
        const instance = typeof res.instance === 'string' && res.instance ? res.instance : typeof params.instance === 'string' ? params.instance : undefined;
        this.presence.noteOpened(toolset, instance, typeof res.title === 'string' && res.title ? res.title : undefined);
        cs.changes.push(...this.presence.diff(before, this.presence.view()).changes);
        break;
      }
      case 'toolsets/close': {
        if (!this.presence.active) return;
        // RFC §5.2: the hint changes the close caused ride in its result, like an open's.
        cs = this.applyHints(metaHints(res), 'toolsets/close');
        const before = this.presence.view();
        this.presence.noteClosed(String(params.toolset ?? ''), typeof params.instance === 'string' ? params.instance : undefined);
        cs.changes.push(...this.presence.diff(before, this.presence.view()).changes);
        break;
      }
      default:
        if (!this.presence.active) return;
        cs = this.applyHints(metaHints(res), method);
    }
    if (awaited) {
      this.readChanges.set(res, cs);
      this.tellUnlessClaimed(res, cs, method);
    } else {
      // RFC §6.1: a result nobody waits for any more (it timed out) applies
      // all the same, and its change is told on its own.
      this.log(`late ${method} result read: its hint changes applied`);
      this.deliver(cs);
    }
  }

  /**
   * The one apply path (RFC §6.1) for a HintChanges from any carrier, as its
   * message is read. Revs are consecutive: anything but the last + 1 means a
   * message was lost or misordered, and the host recovers.
   */
  private applyHints(h: unknown, source: string): ChangeSet {
    if (h === undefined || !this.presence.active) return emptyChange();
    const before = this.presence.view();
    const last = this.field(this.presence.rev);
    const r = this.presence.apply(h);
    const rev = this.field((h as { rev?: unknown } | null)?.rev);
    if (r.behind) {
      this.log(`hint change rev ${rev} (${source}) is not after rev ${last}: ignored; recovering from tools/list and toolsets/list`);
      this.scheduleRecovery();
    } else if (r.skipped) {
      this.log(`hint change rev ${rev} (${source}) after rev ${last}: a rev was lost; applied, and recovering from tools/list and toolsets/list`);
      this.scheduleRecovery();
    } else if (!r.applied) {
      this.log(`a malformed hint change (${source}) was ignored`);
    }
    if (r.unlisted) {
      this.log(`hint change rev ${rev} (${source}) names a tool tools/list hasn't listed: recovering from tools/list and toolsets/list`);
      this.scheduleRecovery();
    }
    const cs = this.presence.diff(before, this.presence.view());
    cs.suggest.push(...r.suggest);
    return cs;
  }

  /** tools/list, as read: definitions and presence as of its `mcpl/rev`, which takes no rev of its own (RFC §4.1). */
  private readToolList(tools: HintedTool[], last: Record<string, unknown>): ChangeSet {
    const before = this.presence.view();
    this.presence.setTools(tools);
    if (this.presence.active && this.presence.noteListRev(isObj(last._meta) ? last._meta['mcpl/rev'] : undefined)) {
      this.log(`tools/list was written after rev ${this.field(isObj(last._meta) ? last._meta['mcpl/rev'] : '')}, past the last rev read: a message was lost; recovering`);
      this.scheduleRecovery();
    }
    return this.presence.diff(before, this.presence.view());
  }

  /** toolsets/list, as read: a full statement of dynamic-tool state under its own rev (RFC §5.3, §6.1). */
  private readToolsetList(res: Record<string, unknown>): ChangeSet {
    if (!this.presence.active) return emptyChange();
    if (!Array.isArray(res.open)) {
      this.log('a toolsets/list result with no open list was ignored');
      return emptyChange();
    }
    const before = this.presence.view();
    const { lost, ended, suggest, skipped, unlisted } = this.presence.adopt(res);
    if (skipped && !this.recovering) {
      // Per-instance state is restated in full; what else was lost (presence) comes from tools/list.
      this.log('toolsets/list skipped a rev: re-reading tools/list');
      this.scheduleRecovery();
    }
    if (unlisted && !this.recovering) {
      this.log('toolsets/list names a tool tools/list hasn\'t listed: re-reading tools/list');
      this.scheduleRecovery();
    }
    const cs = this.presence.diff(before, this.presence.view());
    cs.suggest.push(...suggest);
    // A lost toolset gets its note, not also a "closed" line.
    cs.changes = cs.changes.filter((c) => !lost.some((o) => keyOf(o.toolset, o.instance) === c.key));
    const told = this.presence.adoptionNotes(lost, ended);
    cs.notes.push(...told.notes);
    if (told.ended.length) cs.ended = [...(cs.ended ?? []), ...told.ended];
    return cs;
  }

  /** A change with nothing else to ride on, told as a notice, after every result's change still unclaimed. */
  private deliver(cs: ChangeSet): void {
    this.tellUnclaimed();
    this.notice(cs);
  }

  /**
   * Unclaimed carriers' changes, told as notices in the order they were read,
   * through `upTo` when given. When no notice can be written, a push keeps its
   * change for the framework's push path, which takes it when the push gets
   * there; a result's is dropped, whether or not its caller is still to
   * resume.
   */
  private tellUnclaimed(upTo?: object): void {
    for (const [res, method] of [...this.unclaimed]) {
      this.unclaimed.delete(res);
      const cs = this.readChanges.get(res) ?? emptyChange();
      const sent = this.notice(cs);
      if (sent !== 'refused' || method !== 'push/event') this.readChanges.delete(res);
      if (sent === 'told') this.log(`${method}'s tool change wasn't shown with it: told as a notice`);
      if (res === upTo) return;
    }
  }

  /** Whether a notice was written, there was nothing left to tell (`empty`), or one couldn't be written (`refused`). */
  private notice(cs: ChangeSet): 'told' | 'empty' | 'refused' {
    if (isEmptyChange(cs)) return 'empty';
    const text = this.presence.render(cs, { mark: false });
    if (!text) return 'empty';
    if (!this.deps.notify(this.serverId, text, { invite: cs.suggest.some((s) => s.action === 'open') })) return 'refused';
    this.presence.markTold(cs.ended);
    this.presence.markShown(cs);
    return 'told';
  }

  /**
   * A dynamic tool called by its namespaced name, as if it were listed (a
   * model imitating an earlier call, a module): refused, so every call into
   * a toolset goes through act, which knows its instance and gates closed
   * groups (RFC §5.4, §5.5). Null for any other tool, including one the tool
   * list last published or the server's latest tools/list puts as static
   * (shownAs: RFC §4.2, until its move applies).
   */
  dynamicCallRefusal(tool: string, calledAs: string): string | null {
    if (!this.presence.active || !this.presence.tool(tool) || this.presence.shownAs(tool, 'static')) return null;
    return `There's no tool "${calledAs}" in your tool list, so nothing ran: ${tool} is a dynamic tool of ${this.serverId}, ` +
      `called with ${META_TOOL_NAMES.act} {server:"${this.serverId}", tool:"${tool}", args}. ${this.presence.toolStatus(tool)}.`;
  }

  /**
   * An awaited result's change is told by whoever renders that result, when
   * the result goes to the agent: the model's own call of a tool (its tool
   * result), a meta-tool. One no one renders by the time the awaiting code has
   * run (the next macrotask), such as the result of a call the framework makes
   * itself (a reaction, a send, an accounted side effect), is told as a notice
   * instead, as a standalone tools/hints is (RFC §6.1: every change reaches the
   * agent once), or dropped as tellUnclaimed says when none can be written.
   */
  private tellUnlessClaimed(res: object, cs: ChangeSet, method: string): void {
    if (isEmptyChange(cs)) return;
    this.unclaimed.set(res, method);
    setImmediate(() => {
      if (this.unclaimed.has(res)) this.tellUnclaimed(res);
    });
  }


  /**
   * The change a carrier's hints made (a tool result, a push's params), taken
   * by a caller that shows it to an agent with the carrier: it isn't told as a
   * notice, and the caller says when it has reached an agent (told). Call it
   * synchronously as the carrier is read, before the next macrotask, when an
   * unclaimed carrier's change goes out as a notice instead (tellUnclaimed
   * says what happens when none can be written). A change already gone that
   * way is empty here. Unclaimed carriers read before this one
   * are told first, as notices, so no later change is shown before them.
   */
  takeChange(carrier: unknown): ChangeSet {
    if (!isObj(carrier)) return emptyChange();
    if (this.unclaimed.has(carrier)) {
      let before: object | undefined;
      for (const res of this.unclaimed.keys()) {
        if (res === carrier) break;
        before = res;
      }
      if (before) this.tellUnclaimed(before);
    }
    this.unclaimed.delete(carrier);
    return this.readChanges.get(carrier) ?? emptyChange();
  }

  /** A change its taker showed to an agent: its ended records count as told, and the definitions it describes as shown, unless the taker showed it without its blocks (`blocksShown: false`). */
  told(cs: ChangeSet): void {
    this.presence.markTold(cs.ended);
    if (cs.blocksShown !== false) this.presence.markShown(cs);
  }

  /** A change its taker couldn't show, told as a notice instead, or dropped when none can be written. */
  tell(cs: ChangeSet): void {
    this.notice(cs);
  }

  private changeOf(carrier: object): ChangeSet {
    return this.readChanges.get(carrier) ?? emptyChange();
  }

  // ── recovery (RFC §6.1) ──

  private scheduleRecovery(): void {
    if (!this.presence.active) return;
    if (this.recovering) {
      this.recoverAgain = true;
      return;
    }
    if (this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.recover();
    }, RECOVERY_DEBOUNCE_MS);
    this.recoveryTimer.unref?.();
  }

  /**
   * Recovering: re-read tools/list (presence, declared definitions), then
   * toolsets/list (dynamic-tool state in full), so every tool the statement
   * names is already known; each applies where it's read. What changed is
   * told. (stdio and WebSocket deliver in order, so no early rev is held.)
   */
  private async recover(): Promise<void> {
    const connection = this.connection;
    if (!connection || !connection.isConnected) return;
    this.recovering = true;
    try {
      await this.ownToolList(connection);
      // RFC §6.1: toolsets/list after tools/list, so every tool it names is known.
      if (connection !== this.connection) return;
      const lists = await this.ownToolsetList(connection, LIST_TIMEOUT_MS, 'recovery');
      if (connection !== this.connection) return;
      this.deliver(lists);
    } finally {
      this.recovering = false;
      if (this.recoverAgain) {
        this.recoverAgain = false;
        this.scheduleRecovery();
      }
    }
  }

  /** The tap applies the list and tells its change as it's read. */
  private async ownToolList(connection: McplServerConnection): Promise<void> {
    try {
      await connection.sendToolsList();
    } catch (error) {
      this.log(`tools/list failed: ${this.failure(error)}`);
    }
  }

  private async ownToolsetList(connection: McplServerConnection, timeoutMs: number, why: string): Promise<ChangeSet> {
    try {
      const r = await connection.sendToolsetsList(timeoutMs);
      return this.takeChange(r);
    } catch (error) {
      this.log(`toolsets/list (${why}) failed: ${this.failure(error)}`);
      return emptyChange();
    }
  }

  /**
   * After every (re)connect, once its policy has settled (RFC §5.3): tools/list
   * then toolsets/list, the truth. What the server reports open is adopted
   * (a game kept across the reconnect); what the host believed open and it
   * doesn't report is closed, never re-opened here, since opening can start a
   * new game. What ended meanwhile is told, each `ended` id once.
   */
  async connected(connection: McplServerConnection): Promise<void> {
    if (connection !== this.connection || !connection.isConnected) return;
    this.sync(connection.transportEpoch, connection);
    if (!this.presence.active) return;
    const epoch = connection.transportEpoch;
    await this.ownToolList(connection);
    if (connection !== this.connection || connection.transportEpoch !== epoch) return;
    const lists = await this.ownToolsetList(connection, LIST_TIMEOUT_MS, 'after connecting');
    if (connection !== this.connection || connection.transportEpoch !== epoch) return;
    this.deliver(lists);
  }

  /**
   * Re-read what the server holds open (titles, visibility) without telling
   * it, for look. Returns what the re-read changed, taken from the notice it
   * would otherwise get when `shown` (its result reaches an agent): look then
   * either shows it (told) or hands it back (tell). Otherwise the change is
   * left to its notice, and returned to be shown to the caller alone. Null
   * when nothing was read.
   */
  async refreshOpen(opts: { shown: boolean }): Promise<ChangeSet | null> {
    if (!this.presence.active) return null;
    const connection = this.connection;
    if (!connection || !connection.isConnected) return null;
    try {
      const r = await connection.sendToolsetsList(REFRESH_TIMEOUT_MS);
      if (!isObj(r)) return null;
      return opts.shown ? this.takeChange(r) : this.changeOf(r);
    } catch (error) {
      this.log(`toolsets/list (look) failed: ${this.failure(error)}`);
      return null;
    }
  }

  // ── the host's acts ──

  /** toolsets/open (RFC §5.2). The server's refusal rejects. Its change is
   *  taken when `shown` (its result reaches an agent), else left to its
   *  notice and returned for the caller alone; close's is the same. */
  async open(toolset: string, instance: string | undefined, options: Record<string, unknown> | undefined, opts: { shown: boolean }): Promise<{
    key: string; title?: string; content: unknown[]; change: ChangeSet; adopted: boolean;
  }> {
    const connection = this.live();
    const r = await connection.sendToolsetsOpen({ toolset, ...(instance ? { instance } : {}), ...(options ? { options } : {}) }, TOOLSET_REQUEST_TIMEOUT_MS);
    const res = isObj(r) ? r : {};
    const inst = typeof res.instance === 'string' && res.instance ? res.instance : instance;
    // RFC §5.2: a proposed name is used as given or the open refused.
    if (instance && inst !== instance) this.log(`proposed instance ${this.field(instance)} came back as ${this.field(inst)} (RFC-014 §5.2 forbids renaming): using the server's`);
    const key = keyOf(toolset, this.presence.declared[toolset]?.instances ? inst : undefined);
    const title = typeof res.title === 'string' && res.title ? res.title : this.presence.openRecords().find((o) => keyOf(o.toolset, o.instance) === key)?.title;
    return {
      key,
      ...(title ? { title } : {}),
      content: Array.isArray(res.content) ? res.content : [],
      change: opts.shown ? this.takeChange(res) : this.changeOf(res),
      adopted: res.adopted === true,
    };
  }

  /** toolsets/close (RFC §5.2). */
  async close(toolset: string, instance: string | undefined, opts: { shown: boolean }): Promise<{ content: unknown[]; change: ChangeSet }> {
    const connection = this.live();
    const r = await connection.sendToolsetsClose({ toolset, ...(instance ? { instance } : {}) }, TOOLSET_REQUEST_TIMEOUT_MS);
    const res = isObj(r) ? r : {};
    return { content: Array.isArray(res.content) ? res.content : [], change: opts.shown ? this.takeChange(res) : this.changeOf(res) };
  }

  /** Open or close an undeclared group (RFC §5.4): the host's own act; the server isn't told. */
  setGroupOpen(group: string, open: boolean): ChangeSet {
    const before = this.presence.view();
    if (open) this.presence.openGroup(group);
    else this.presence.closeGroup(group);
    return this.presence.diff(before, this.presence.view());
  }

  /**
   * A manifest re-fetch (RFC §5.1): the `toolsets` domain's declarations, as
   * the server sent them. A toolset removed ends its instances; a server
   * that withdraws toolHints is hint-less from then on. What changed is told.
   */
  manifestChanged(declarations: Record<string, unknown> | null): void {
    const before = this.presence.view();
    const wasActive = this.presence.active;
    if (!declarations || declarations.toolHints !== true) {
      if (!wasActive) return;
      this.presence.deactivate();
      this.log('the server withdrew toolHints: every tool is static from now on');
      const cs = this.presence.diff(before, this.presence.view());
      cs.notes.push(`${this.serverId} no longer presents toolsets: its tools are called directly now, by name, not through ${META_TOOL_NAMES.act}.`);
      this.deliver(cs);
      return;
    }
    if (!wasActive) {
      // Hints that arrive by a manifest change take effect at the next
      // connection's handshake: revs belong to a connection's first message.
      this.log('the server now advertises toolHints: in effect from its next connection');
      return;
    }
    this.presence.setManifest(declarations);
    this.deliver(this.presence.diff(before, this.presence.view()));
  }

  /** At a rebuild of the model's tool list (RFC §4.2), tell where the tools it moved went: `moves`, those still pending, or every one pending. A move a list has undone since the rebuild listed the server isn't told; the next rebuild publishes the undoing. */
  applyMoves(moves?: Array<{ name: string; to: Presence }>): void {
    const moved = this.presence.applyMoves(moves);
    if (!moved.length) return;
    const cs = emptyChange();
    cs.notes.push(...moved.map(({ name, to }) => to === 'dynamic'
      ? `${name} left your tool list: it's announced when available, and called with ${META_TOOL_NAMES.act} {server:"${this.serverId}", tool:"${name}", args}.`
      : `${name} is in your tool list now, as ${this.deps.listedName(this.serverId, name)}.`));
    this.deliver(cs);
  }
}

/** Every server's controller, for the meta-tools and reminders. */
export class ToolsetHub {
  private readonly controllers = new Map<string, ToolsetController>();
  /** Per agent: the markers it has had in view (seen), and whether a reminder is due. */
  private readonly seen = new Map<string, Set<string>>();
  private readonly due = new Set<string>();

  constructor(private readonly deps: ToolsetHostDeps) {}

  /** The controller for a server, made at its first connect. */
  controllerFor(config: McplServerConfig): ToolsetController {
    let c = this.controllers.get(config.id);
    if (!c) {
      c = new ToolsetController(config.id, config, this.deps);
      this.controllers.set(config.id, c);
    } else {
      c.setConfig(config);
    }
    return c;
  }

  get(serverId: string): ToolsetController | undefined {
    return this.controllers.get(serverId);
  }

  /** A server's configuration went (removed): its controller lets go of the
   *  connection it holds, and is forgotten, so a server added later under
   *  the same id starts from nothing. */
  forget(serverId: string): void {
    this.controllers.get(serverId)?.release();
    this.controllers.delete(serverId);
  }

  all(): ToolsetController[] {
    return [...this.controllers.values()];
  }

  /** The servers the meta-tools speak for now. */
  presenting(): ToolsetController[] {
    return this.all().filter((c) => c.presents);
  }

  /** Every open key's marker, across servers. */
  private openMarkers(): string[] {
    return this.all().flatMap((c) => (c.presence.active ? c.presence.openKeys().map((k) => c.presence.label(k)) : []));
  }

  /**
   * A compile built to send for `agentName` (RFC §8.3): which open toolsets'
   * announcements the request carries. One the agent has had in view and the
   * request no longer carries (compressed, or out of the window) makes a
   * reminder due.
   */
  observeCompile(agentName: string, messages: readonly unknown[]): void {
    const open = this.openMarkers();
    if (open.length === 0) {
      this.seen.delete(agentName);
      this.due.delete(agentName);
      return;
    }
    const text = compiledText(messages);
    const seen = this.seen.get(agentName) ?? new Set<string>();
    let missing = false;
    for (const marker of open) {
      if (text.includes(marker)) seen.add(marker);
      else if (seen.has(marker)) missing = true;
    }
    for (const marker of [...seen]) if (!open.includes(marker)) seen.delete(marker);
    this.seen.set(agentName, seen);
    // Due until a request carries every marker the agent has seen again: a
    // gather that doesn't send (a preview) leaves it due for the next start.
    if (missing) this.due.add(agentName);
    else this.due.delete(agentName);
  }

  /** The reminder due for `agentName`, or null when none is. */
  reminderFor(agentName: string): string | null {
    if (!this.due.has(agentName)) return null;
    const parts = this.presenting().filter((c) => this.deps.canNotify(c.serverId)).map((c) => c.presence.reminder()).filter((r): r is string => !!r);
    if (parts.length === 0) return null;
    return `Open toolsets (a reminder: their earlier announcements have left your context):\n${parts.join('\n')}`;
  }
}

/** The text a compiled request carries, for marker search: text blocks and tool results' text, at any depth. */
function compiledText(messages: readonly unknown[]): string {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (!isObj(v)) return;
    if (typeof v.text === 'string') out.push(v.text);
    if (v.content !== undefined) walk(v.content, depth + 1);
  };
  for (const m of messages) walk(isObj(m) ? m.content : undefined, 0);
  return out.join('\n');
}
