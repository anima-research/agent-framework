/**
 * MCPL RFC-014 (tool presence, toolsets and surfaces): one server's tool
 * presence as the host keeps it.
 *
 * The server's tool list stays its whole truth (RFC §2 principle 1); hints say
 * which tools are static (the API tool list, as before) and which are dynamic
 * (announced in the conversation as they come and go, and called through the
 * host's `act`). Per server this keeps:
 *
 *  - the tool definitions (tools/list) and the toolset declarations (manifest);
 *  - which declared toolsets and instances are open (toolsets/open results,
 *    toolsets/list, hint `toolsets` entries), and which undeclared groups the
 *    host opened itself (RFC §5.4: the server is never told);
 *  - the server's visibility statements per instance, and definition
 *    overrides, from hint changes applied in `rev` order, each at most once.
 *    One apply path serves every carrier: a call's, an open's or a close's
 *    result, a push's `hints`, a standalone `tools/hints`. `tools/list`
 *    (`mcpl/rev`) and `toolsets/list` are statements later changes build on;
 *  - which definitions the model has been shown, so a tool's first sentence
 *    is said once.
 *
 * Every mutation is bracketed by view() snapshots, and diff() turns the
 * difference into what the model reads. Nothing here does I/O: the
 * controller (toolset-host.ts) feeds it what the connection read.
 *
 * Ported from mcpl-cc-bridge's presence.ts, the reference host.
 */
import { objectSignature, renderToolLines, toolDigest, type HintedTool, type Shown } from './tool-signature.js';

export interface ToolsetDecl {
  title?: string;
  summary?: string;
  default?: 'open' | 'closed';
  instances?: boolean;
  options?: unknown;
}
export interface Suggestion { toolset: string; instance?: string; action: 'open' | 'close'; reason: string }
export interface OpenRecord { toolset: string; instance?: string; title?: string }
/** RFC-014 §5.3: an instance that ended other than by a toolsets/close. */
export interface Ended { id?: string; toolset: string; instance?: string; reason: string }
export type Presence = 'static' | 'dynamic';

/** The names of the host's meta-tools, as the model calls them. */
export interface MetaToolNames { open: string; act: string; look: string; close: string }

/** Toolset-less dynamic tools live under this key: always "open", visible per the server. */
export const NO_TOOLSET = '';
export const keyOf = (toolset: string, instance?: string): string => `${toolset}\u0000${instance ?? ''}`;
export const splitKey = (key: string): { toolset: string; instance?: string } => {
  const [toolset, instance] = key.split('\u0000');
  return { toolset: toolset ?? '', ...(instance ? { instance } : {}) };
};

interface Entry { title?: string; tools: Map<string, HintedTool> }
/** What the model may use right now: per key, the visible tools. Open-but-empty keys are present with no tools. */
export type View = Map<string, Entry>;

export interface Change {
  key: string;
  toolset: string;
  instance?: string;
  title?: string;
  opened: boolean;
  closed: boolean;
  retitled: boolean;
  appeared: HintedTool[];
  gone: string[];
  redefined: HintedTool[];
  /** The visible tools after the change. */
  now: HintedTool[];
}
export interface ChangeSet {
  changes: Change[];
  suggest: Suggestion[];
  notes: string[];
  /** Ended records' notes, by id: rendered while the id is untold, told once the set reaches an agent (markTold). */
  ended?: Array<{ id: string; note: string }>;
  /** false when its taker showed the change without its blocks (a look that restates the present shows the live catalog instead): told() then counts none of its definitions shown, while a notice that tells it still shows them. */
  blocksShown?: false;
}

export const emptyChange = (): ChangeSet => ({ changes: [], suggest: [], notes: [] });
export const isEmptyChange = (c: ChangeSet): boolean => !c.changes.length && !c.suggest.length && !c.notes.length && !c.ended?.length;
/** Whether a change to one key shows that key's tools in a block: what render prints and markShown counts as shown. */
const showsBlock = (c: Change): boolean => !c.closed && (c.opened || c.appeared.length > 0 || c.redefined.length > 0 || c.gone.length > 0);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * RFC-014 §6.1: revs on a connection are consecutive (1, 2, 3 …), and changes
 * apply in rev order, which on stdio and WebSocket is arrival order.
 *  applied: a rev above the last, applied; `skipped` when it isn't exactly
 *           the last + 1 (a message was lost unread): recover.
 *  behind:  at or below the last, not applied: recover.
 */
export interface ApplyOutcome { applied: boolean; skipped: boolean; behind: boolean; suggest: Suggestion[]; unlisted: boolean }

/** What a hint `definition` may change (RFC §6.1): everything else stays the listed tool's. */
interface DefOverride { description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }

/** The fields a hint definition may change (RFC §6.1); `name` and all of `_meta` are ignored. */
export function overrideOf(d: Record<string, unknown>): DefOverride {
  return {
    ...(typeof d.description === 'string' ? { description: d.description } : {}),
    ...(isObj(d.inputSchema) ? { inputSchema: d.inputSchema } : {}),
    ...(isObj(d.annotations) ? { annotations: d.annotations } : {}),
  };
}

export class ToolPresence {
  /** Hints are in effect on the current connection: the host advertised toolHints and the server did too. */
  active = false;
  declared: Record<string, ToolsetDecl> = {};
  surface: { title?: string; summary?: string } | null = null;
  /** The last rev read on this connection (RFC §6.1); 0 at each connect. */
  rev = 0;
  private tools = new Map<string, HintedTool>();
  private open = new Map<string, OpenRecord>();
  private groups = new Set<string>();
  private visible = new Map<string, Set<string>>();
  /** Definition overrides from hints: per key (an instance's own, or a toolset's), per tool. */
  private defs = new Map<string, Map<string, DefOverride>>();
  /** `ended` ids told to the agent, kept while the server still reports them (RFC §5.3). */
  private toldEnded = new Set<string>();
  /** Moves a tools/list made that the model's tool list doesn't show yet: told once a rebuild has published them. */
  private pendingMoves = new Map<string, Presence>();
  /** Digests of definitions the model has been shown with their first sentence. */
  readonly shown = new Set<string>();

  constructor(
    readonly server: string,
    /** The meta-tools' names, for the hints rendered text gives. */
    readonly names: MetaToolNames,
    /** The host's tool policy (enabledTools/disabledTools): a tool it refuses is as if unlisted. */
    private readonly allowed: (tool: string) => boolean = () => true,
    /** How a static tool is named in the API tool list, for `look`. */
    private readonly listedName: (tool: string) => string = (tool) => tool,
    /** Where the model's published tool list last put a tool, if it's there (shownAs). */
    private readonly published: (tool: string) => Presence | undefined = () => undefined,
  ) {}

  // ── connection lifecycle ──

  /** A new connection: revs start over; hints count only when both sides advertised toolHints. */
  beginConnection(mcpl: Record<string, unknown> | null | undefined, hostHints: boolean): void {
    this.rev = 0;
    // RFC §6.1: hint _meta and tools/hints from a server that did not advertise toolHints are ignored.
    const active = hostHints && !!mcpl && mcpl.toolHints === true;
    if (!active) {
      if (this.active) this.deactivate();
      return;
    }
    this.active = true;
    this.setManifest(mcpl);
  }

  /** Toolset declarations and the surface hint, from initialize or a manifest re-fetch. */
  setManifest(mcpl: Record<string, unknown> | null | undefined): void {
    const prev = this.declared;
    const decl: Record<string, ToolsetDecl> = {};
    if (mcpl && isObj(mcpl.toolsets)) {
      for (const [name, d] of Object.entries(mcpl.toolsets)) {
        if (!isObj(d) || !name) continue;
        decl[name] = {
          ...(str(d.title) ? { title: str(d.title) } : {}),
          ...(str(d.summary) ? { summary: str(d.summary) } : {}),
          default: d.default === 'open' ? 'open' : 'closed',
          ...(d.instances === true ? { instances: true } : {}),
          ...(isObj(d.options) ? { options: d.options } : {}),
        };
      }
    }
    this.declared = decl;
    for (const name of Object.keys(decl)) this.groups.delete(name);
    this.surface = mcpl && isObj(mcpl.surface) ? { title: str(mcpl.surface.title), summary: str(mcpl.surface.summary) } : null;
    // RFC §5.1: removing a toolset, or turning its instances on or off, ends
    // its open instances; one that becomes undeclared starts closed under the
    // host's gating.
    for (const [k, r] of [...this.open]) {
      if (!decl[r.toolset] || !!decl[r.toolset]!.instances !== !!prev[r.toolset]?.instances) this.dropKey(k);
    }
    for (const name of Object.keys(prev)) {
      if (decl[name]) continue;
      this.groups.delete(name);
      for (const k of new Set([...this.visible.keys(), ...this.defs.keys()])) if (splitKey(k).toolset === name) this.dropKey(k);
    }
  }

  /** RFC §5.1: a server that withdraws toolHints is hint-less from then on: every tool static, nothing dynamic presented. */
  deactivate(): void {
    this.active = false;
    this.declared = {};
    this.surface = null;
    this.open.clear();
    this.groups.clear();
    this.visible.clear();
    this.defs.clear();
    this.pendingMoves.clear();
  }

  /** tools/list: every definition, visible or not (RFC §4.1). A tool the host's policy refuses is left out. */
  setTools(list: HintedTool[]): void {
    const seen = new Map([...this.tools.keys()].map((name) => [name, this.presenceOf(name)]));
    const named = list.filter((t) => isObj(t) && typeof t.name === 'string');
    this.tools = new Map();
    for (const t of named) if (this.allowed(t.name) && !this.tools.has(t.name)) this.tools.set(t.name, t);
    for (const set of this.visible.values()) for (const n of [...set]) if (!this.tools.has(n)) set.delete(n);
    // RFC §4.1: the list states each tool's presence, and presence follows
    // it. A changed presence is a move the model's tool list shows at its
    // next rebuild (§4.2; applyMoves); one the list reverses before then
    // never reached that list.
    for (const name of [...this.pendingMoves.keys()]) if (!this.tools.has(name)) this.pendingMoves.delete(name);
    for (const name of this.active ? this.tools.keys() : []) {
      const was = seen.get(name);
      const listed = this.listedPresence(name);
      if (this.pendingMoves.has(name)) {
        if (this.pendingMoves.get(name) !== listed) this.pendingMoves.delete(name);
      } else if (was !== undefined && was !== listed) {
        this.pendingMoves.set(name, listed);
      }
    }
    // The list's `mcpl/visible` is the server's word only where nothing else
    // speaks: toolset-less dynamic tools and undeclared groups. For a declared
    // toolset it's an aggregate ("visible in some open instance"); per-instance
    // state comes from toolsets/list and hint changes (RFC §4.1, §5.3).
    for (const t of this.tools.values()) {
      if (this.listedPresence(t.name) !== 'dynamic') continue;
      const ts = this.toolsetOf(t.name);
      if (ts && this.isDeclared(ts)) continue;
      this.setVisible(keyOf(ts ?? NO_TOOLSET), t.name, t._meta?.['mcpl/visible'] !== false);
    }
  }

  // ── reading ──

  /** Whether the meta-tools speak for this server: hints in effect and something dynamic. */
  get presents(): boolean {
    if (!this.active) return false;
    if (Object.keys(this.declared).length) return true;
    for (const n of this.tools.keys()) if (this.presenceOf(n) === 'dynamic') return true;
    return false;
  }

  get allTools(): HintedTool[] {
    return [...this.tools.values()];
  }

  tool(name: string): HintedTool | undefined {
    return this.tools.get(name);
  }

  toolsetOf(name: string): string | undefined {
    const m = this.tools.get(name)?._meta;
    return m && typeof m['mcpl/toolset'] === 'string' && m['mcpl/toolset'] ? (m['mcpl/toolset'] as string) : undefined;
  }

  /** As the list states it: a toolset's tool is dynamic whatever a hint says (RFC §4.1). */
  presenceOf(name: string): Presence {
    if (!this.active) return 'static';
    return this.listedPresence(name);
  }

  /** RFC §4.2: "Until it applies the move, the tool keeps working where it
   *  is." Whether a tool is at `place` in the tool list last published, or
   *  in the server's latest tools/list (its presence). Until a rebuild
   *  applies a move the two differ, and a call is taken at either. */
  shownAs(name: string, place: Presence): boolean {
    if (!this.active) return place === 'static';
    return this.published(name) === place || this.listedPresence(name) === place;
  }

  private listedPresence(name: string): Presence {
    if (this.toolsetOf(name)) return 'dynamic';
    return this.tools.get(name)?._meta?.['mcpl/presence'] === 'dynamic' ? 'dynamic' : 'static';
  }

  isDeclared(toolset: string): boolean {
    return Object.hasOwn(this.declared, toolset);
  }

  /** Undeclared toolset names the server's tools are tagged with (RFC §5.4). */
  get undeclaredGroups(): string[] {
    const out = new Set<string>();
    for (const n of this.tools.keys()) {
      const ts = this.toolsetOf(n);
      if (ts && !this.isDeclared(ts)) out.add(ts);
    }
    return [...out];
  }

  openRecords(toolset?: string): OpenRecord[] {
    return [...this.open.values()].filter((r) => toolset === undefined || r.toolset === toolset);
  }

  isOpen(toolset: string, instance?: string): boolean {
    return this.isDeclared(toolset) ? this.open.has(keyOf(toolset, instance)) : this.groups.has(toolset);
  }

  get openGroups(): string[] {
    return [...this.groups];
  }

  /**
   * The definition the model sees, and the host checks arguments against, for
   * `name` in `key`: the instance's own (a hint definition with `instance`),
   * else the toolset's (one without), else the listed one (RFC §6.1).
   */
  defOf(key: string, name: string): HintedTool {
    const listed = this.tools.get(name)!;
    const { toolset } = splitKey(key);
    const o = this.defs.get(key)?.get(name) ?? (toolset ? this.defs.get(keyOf(toolset))?.get(name) : undefined);
    return o ? { ...listed, ...o } : listed;
  }

  view(): View {
    const v: View = new Map();
    for (const [key, r] of this.open) v.set(key, { title: r.title, tools: new Map() });
    for (const g of this.groups) if (!this.isDeclared(g)) v.set(keyOf(g), { tools: new Map() });
    for (const name of this.tools.keys()) {
      if (this.presenceOf(name) !== 'dynamic') continue;
      const ts = this.toolsetOf(name);
      if (ts && this.isDeclared(ts)) {
        for (const [key, r] of this.open) if (r.toolset === ts && this.visible.get(key)?.has(name)) v.get(key)!.tools.set(name, this.defOf(key, name));
      } else if (ts) {
        // Two controllers (RFC §4.1, §5.4): the host has the group open AND the server says visible.
        const key = keyOf(ts);
        if (this.groups.has(ts) && this.visible.get(key)?.has(name)) v.get(key)!.tools.set(name, this.defOf(key, name));
      } else {
        const key = keyOf(NO_TOOLSET);
        if (this.visible.get(key)?.has(name)) {
          if (!v.has(key)) v.set(key, { tools: new Map() });
          v.get(key)!.tools.set(name, this.defOf(key, name));
        }
      }
    }
    return v;
  }

  diff(before: View, after: View): ChangeSet {
    const out = emptyChange();
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(key);
      const a = after.get(key);
      const isGroupKey = splitKey(key).toolset !== NO_TOOLSET;
      const appeared: HintedTool[] = [];
      const redefined: HintedTool[] = [];
      for (const [n, d] of a?.tools ?? []) {
        const was = b?.tools.get(n);
        if (!was) appeared.push(d);
        else if (toolDigest(was) !== toolDigest(d)) redefined.push(d);
      }
      const gone = [...(b?.tools.keys() ?? [])].filter((n) => !a?.tools.has(n));
      const opened = isGroupKey && !b && !!a;
      const closed = isGroupKey && !!b && !a;
      const retitled = !!a && !!b && !!a.title && a.title !== b.title;
      if (!appeared.length && !redefined.length && !gone.length && !opened && !closed && !retitled) continue;
      out.changes.push({ key, ...splitKey(key), title: a?.title ?? b?.title, opened, closed, retitled, appeared, gone, redefined, now: [...(a?.tools.values() ?? [])] });
    }
    return out;
  }

  // ── the one apply path ──

  /** Apply a HintChanges (RFC §6.1) from any of its carriers, as it is read (see ApplyOutcome). */
  apply(h: unknown): ApplyOutcome {
    const none: ApplyOutcome = { applied: false, skipped: false, behind: false, suggest: [], unlisted: false };
    if (!isObj(h) || typeof h.rev !== 'number' || !Number.isFinite(h.rev)) return none;
    if (h.rev <= this.rev) return { ...none, behind: true };
    const skipped = h.rev !== this.rev + 1;
    this.rev = h.rev;
    return { ...none, applied: true, skipped, ...this.applyBody(h) };
  }

  /**
   * tools/list's `_meta["mcpl/rev"]` (RFC §4.1): the last rev the server had
   * sent when it wrote the list, which takes none itself. Read in order it
   * equals the last rev read; a higher one means a message was lost (true).
   */
  noteListRev(rev: unknown): boolean {
    if (typeof rev !== 'number' || !Number.isFinite(rev)) return false;
    const lost = rev > this.rev;
    this.rev = Math.max(this.rev, rev);
    return lost;
  }

  private applyBody(h: Record<string, unknown>): { suggest: Suggestion[]; unlisted: boolean } {
    let unlisted = false;
    for (const e of arr(h.toolsets)) {
      if (!isObj(e) || !str(e.toolset) || !this.isDeclared(e.toolset as string)) continue; // undeclared toolsets are host-local
      const ts = e.toolset as string;
      const withInstances = !!this.declared[ts]!.instances;
      const instance = withInstances ? str(e.instance) : undefined;
      if (withInstances && !instance) continue; // an instance-less statement about a toolset with instances names nothing
      const key = keyOf(ts, instance);
      // "open" opens, confirms, or (with a new title) retitles (RFC §6.1);
      // it may come from another connection of the same principal (§5.6).
      if (e.state === 'open') this.open.set(key, { toolset: ts, ...(instance ? { instance } : {}), title: str(e.title) ?? this.open.get(key)?.title });
      else if (e.state === 'closed') this.dropKey(key);
    }
    for (const e of arr(h.tools)) {
      if (!isObj(e) || !str(e.name)) continue;
      const name = e.name as string;
      if (!this.tools.has(name)) {
        if (this.allowed(name)) unlisted = true;
        continue;
      }
      // A hint's presence stages nothing: a hinted move takes effect when
      // the server's tools/list states it (RFC §4.1), as the rebuild's own
      // list does. A definition it gives is the tool's current one, kept
      // whatever its presence now, for when it's shown dynamic (§6.1).
      if (isObj(e.definition)) {
        const key = this.defKeyFor(name, str(e.instance));
        if (!this.defs.has(key)) this.defs.set(key, new Map());
        this.defs.get(key)!.set(name, overrideOf(e.definition));
      }
      if (typeof e.visible === 'boolean') for (const key of this.keysFor(name, str(e.instance))) this.setVisible(key, name, e.visible);
    }
    const suggest: Suggestion[] = [];
    for (const s of arr(h.suggest)) {
      if (!isObj(s) || !str(s.toolset) || (s.action !== 'open' && s.action !== 'close')) continue;
      suggest.push({ toolset: s.toolset as string, ...(str(s.instance) ? { instance: str(s.instance) } : {}), action: s.action, reason: str(s.reason) ?? '' });
    }
    return { suggest, unlisted };
  }

  /**
   * Where a definition lands (RFC §6.1): with `instance`, that instance's own;
   * without, the toolset's (for a toolset without instances, its only one's).
   */
  private defKeyFor(name: string, instance: string | undefined): string {
    const ts = this.toolsetOf(name);
    if (!ts) return keyOf(NO_TOOLSET);
    return keyOf(ts, this.declared[ts]?.instances ? instance : undefined);
  }

  /** Where a visibility statement lands. For a toolset with instances, `instance` is required; a statement without one is ignored. */
  private keysFor(name: string, instance: string | undefined): string[] {
    const ts = this.toolsetOf(name);
    if (!ts) return [keyOf(NO_TOOLSET)];
    const decl = this.declared[ts];
    if (!decl?.instances) return [keyOf(ts)];
    return instance ? [keyOf(ts, instance)] : [];
  }

  private setVisible(key: string, name: string, on: boolean): void {
    let s = this.visible.get(key);
    if (!s) this.visible.set(key, (s = new Set()));
    if (on) s.add(name);
    else s.delete(name);
  }

  private dropKey(key: string): void {
    this.open.delete(key);
    this.visible.delete(key);
    this.defs.delete(key);
  }

  /** The result of a toolsets/open: the instance is open whatever its hints say. */
  noteOpened(toolset: string, instance: string | undefined, title: string | undefined): void {
    if (!this.isDeclared(toolset)) return;
    const withInstances = !!this.declared[toolset]!.instances;
    if (withInstances && !instance) return;
    const key = keyOf(toolset, withInstances ? instance : undefined);
    this.open.set(key, { toolset, ...(withInstances && instance ? { instance } : {}), title: title ?? this.open.get(key)?.title });
  }

  /** toolsets/close succeeded: closed, whatever the hints said. */
  noteClosed(toolset: string, instance: string | undefined): void {
    this.dropKey(keyOf(toolset, this.declared[toolset]?.instances ? instance : undefined));
  }

  /**
   * toolsets/list (RFC §5.3): what the principal has open, with the full hint
   * state of its dynamic tools, the truth for declared toolsets and dynamic
   * tools outside them. Anything the host believed open and the server doesn't
   * report is closed, never re-opened here: opening can start a new game.
   * Returns what was lost, what the server says ended while no connection was
   * told, its suggestions, and whether its rev skipped one.
   */
  adopt(result: unknown): { lost: OpenRecord[]; ended: Ended[]; suggest: Suggestion[]; skipped: boolean; unlisted: boolean } {
    const had = [...this.open.values()];
    // A full statement: a dynamic tool not stated visible is invisible.
    // Undeclared groups stay as the host has them open or closed.
    for (const k of new Set([...this.open.keys(), ...this.visible.keys(), ...this.defs.keys()])) {
      if (this.isDeclared(splitKey(k).toolset)) this.dropKey(k);
      else {
        this.visible.delete(k);
        this.defs.delete(k);
      }
    }
    const r = isObj(result) ? result : {};
    for (const o of arr(r.open)) {
      if (!isObj(o) || !str(o.toolset)) continue;
      this.noteOpened(o.toolset as string, str(o.instance), str(o.title));
    }
    let suggest: Suggestion[] = [];
    let skipped = false;
    let unlisted = false;
    const h = isObj(r._meta) ? r._meta['mcpl/hints'] : undefined;
    if (isObj(h)) {
      ({ suggest, unlisted } = this.applyBody(h));
      // Its own rev, at its place in order (RFC §6.1).
      if (typeof h.rev === 'number' && Number.isFinite(h.rev)) {
        skipped = h.rev !== this.rev + 1;
        this.rev = Math.max(this.rev, h.rev);
      }
    }
    const ended: Ended[] = [];
    for (const e of arr(r.ended)) {
      if (!isObj(e) || !str(e.toolset)) continue;
      ended.push({ ...(str(e.id) ? { id: str(e.id) } : {}), toolset: e.toolset as string, ...(str(e.instance) ? { instance: str(e.instance) } : {}), reason: str(e.reason) ?? '' });
    }
    // RFC §5.3: a record is reported on every toolsets/list until it expires, and its id is never
    // reused, so an id the server no longer reports needn't be remembered.
    const reported = new Set(ended.flatMap((e) => (e.id ? [e.id] : [])));
    for (const id of [...this.toldEnded]) if (!reported.has(id)) this.toldEnded.delete(id);
    return { lost: had.filter((o) => !this.open.has(keyOf(o.toolset, o.instance))), ended, suggest, skipped, unlisted };
  }

  /**
   * What the agent should hear about an adoption: what ended while it was
   * away, each `ended` id until it has been told (RFC §5.3; markTold), and
   * what is closed now. An ended record with an id is in `ended`, rendered
   * while its id is untold.
   */
  adoptionNotes(lost: OpenRecord[], ended: Ended[]): { notes: string[]; ended: Array<{ id: string; note: string }> } {
    const notes: string[] = [];
    const told: Array<{ id: string; note: string }> = [];
    const endedKeys = new Set<string>();
    for (const e of ended) {
      if (!e.id || !this.toldEnded.has(e.id)) endedKeys.add(keyOf(e.toolset, e.instance));
      const note = `${this.label(keyOf(e.toolset, e.instance))} ended${e.reason ? `: ${e.reason}` : ''}.`;
      if (e.id) {
        if (!this.toldEnded.has(e.id)) told.push({ id: e.id, note });
      } else notes.push(note);
    }
    for (const o of lost) {
      if (endedKeys.has(keyOf(o.toolset, o.instance))) continue;
      notes.push(`${this.label(keyOf(o.toolset, o.instance))} is closed: ${this.server} no longer has it open. ${this.openHint(o.toolset)} starts a new one.`);
    }
    return { notes, ended: told };
  }

  /** The agent has been told these ended records (a notice written, a result it reads); the next statement forgets any it no longer reports. */
  markTold(ended: ChangeSet['ended']): void {
    for (const { id } of ended ?? []) this.toldEnded.add(id);
  }

  /** The definitions a change set's tool blocks describe have reached the model. */
  markShown(cs: ChangeSet): void {
    for (const c of cs.changes) if (showsBlock(c)) for (const t of c.now) this.shown.add(toolDigest(t));
  }

  /** A set's ended notes whose ids are still untold, each once. */
  untoldNotes(cs: ChangeSet): string[] {
    const seen = new Set<string>();
    return (cs.ended ?? []).filter(({ id }) => !this.toldEnded.has(id) && !seen.has(id) && !!seen.add(id)).map(({ note }) => note);
  }

  // ── host-made opens of undeclared groups (RFC §5.4) ──

  openGroup(g: string): void {
    this.groups.add(g);
  }

  closeGroup(g: string): void {
    this.groups.delete(g);
  }

  // ── boundaries ──

  /** The static↔dynamic moves the lists made since the last rebuild, still to be shown. */
  moves(): Array<{ name: string; to: Presence }> {
    return [...this.pendingMoves].map(([name, to]) => ({ name, to }));
  }

  /** At a rebuild of the model's tool list (RFC §4.2): those of `moves` still pending, now shown. */
  applyMoves(moves = this.moves()): Array<{ name: string; to: Presence }> {
    const out = moves.filter(({ name, to }) => this.pendingMoves.get(name) === to);
    for (const { name } of out) this.pendingMoves.delete(name);
    return out;
  }

  // ── rendering ──

  /** The marker a key's announcements begin with, `[server/toolset:instance]`, which a reminder looks for. */
  label(key: string): string {
    const { toolset, instance } = splitKey(key);
    return `[${this.server}${toolset ? `/${toolset}` : ''}${instance ? `:${instance}` : ''}]`;
  }

  callHint(key: string): string {
    const { instance } = splitKey(key);
    return `${this.names.act} {server:"${this.server}"${instance ? `, instance:"${instance}"` : ''}, tool, args}`;
  }

  closeHint(key: string): string | null {
    const { toolset, instance } = splitKey(key);
    if (!toolset) return null;
    return `${this.names.close} {server:"${this.server}", toolset:"${toolset}"${instance ? `, instance:"${instance}"` : ''}}`;
  }

  openHint(toolset: string, instance?: string): string {
    return `${this.names.open} {server:"${this.server}", toolset:"${toolset}"${instance ? `, instance:"${instance}"` : ''}}`;
  }

  /** The tool block for one key: its label, how to call, and the visible tools (new or changed ones described). */
  toolBlock(key: string, tools: HintedTool[], opts: { describeAll?: boolean; headed?: boolean; title?: string; seen?: Shown } = {}): string[] {
    const head = opts.headed === false ? '' : `${this.label(key)}${opts.title ? ` ${opts.title}` : ''} `;
    if (!tools.length) return [`${head}no tools available right now.`];
    return [`${head}tools now — ${this.callHint(key)}:`, ...renderToolLines(tools, opts.seen ?? this.shown, { describeAll: opts.describeAll })];
  }

  /**
   * What the model reads for a change set. `bare`: a key whose header the
   * caller already printed. `mark: false` renders without counting the
   * definitions it describes as shown, for text that may not reach the model
   * (markShown counts them once it has). `describeAll`: every tool with its
   * first sentence, as for a result that may reach no agent.
   */
  render(cs: ChangeSet, opts: { bare?: string; mark?: boolean; describeAll?: boolean } = {}): string {
    const local = new Set<string>();
    const seen: Shown = opts.mark === false ? { has: (d) => this.shown.has(d) || local.has(d), add: (d) => { local.add(d); } } : this.shown;
    const lines: string[] = [];
    for (const c of cs.changes) {
      const bare = opts.bare === c.key;
      if (c.closed) {
        lines.push(`${this.label(c.key)} closed.${c.gone.length ? ` Now unavailable: ${c.gone.join(', ')}.` : ''}`);
        continue;
      }
      const title = (c.opened || c.retitled) && !bare ? c.title : undefined;
      if (showsBlock(c)) lines.push(...this.toolBlock(c.key, c.now, { headed: !bare, title, seen, describeAll: opts.describeAll }));
      else if (title) lines.push(`${this.label(c.key)} ${title}`);
      if (c.gone.length) lines.push(`now unavailable: ${c.gone.join(', ')}`);
      if (c.opened && !bare) {
        const close = this.closeHint(c.key);
        if (close) lines.push(`${close} closes it.`);
      }
    }
    for (const s of cs.suggest) lines.push(this.renderSuggestion(s));
    lines.push(...this.untoldNotes(cs), ...cs.notes);
    return lines.join('\n');
  }

  /** RFC §6.2: a suggestion is shown, never acted on. */
  renderSuggestion(s: Suggestion): string {
    const what = `${s.toolset}${s.instance ? `:${s.instance}` : ''}`;
    const how = s.action === 'open' ? this.openHint(s.toolset, s.instance) : this.closeHint(keyOf(s.toolset, s.instance));
    return `${this.server} suggests ${s.action === 'open' ? 'opening' : 'closing'} ${what}${s.reason ? `: ${s.reason}` : ''} — ${how} if you want to (nothing was done).`;
  }

  /** The keys a reminder restates: every open key of this server's view. */
  openKeys(): string[] {
    return [...this.view().keys()];
  }

  /** RFC §8.3 reminder: what is open, its current tools (described), how to call and close it. Null when nothing is open. */
  reminder(): string | null {
    const v = this.view();
    if (!v.size) return null;
    const lines: string[] = [];
    for (const [key, e] of v) {
      lines.push(...this.toolBlock(key, [...e.tools.values()], { describeAll: true, title: e.title }));
      const close = this.closeHint(key);
      if (close) lines.push(`  ${close} closes it.`);
    }
    return lines.join('\n');
  }

  /** look naming this server: what is open (with tools) and what can be
   *  opened. `mark: false`, as for render, for a look whose result may
   *  reach no agent. */
  catalog(opts: { mark?: boolean } = {}): string {
    const lines: string[] = [];
    lines.push(this.surface ? `${this.server} — ${[this.surface.title, this.surface.summary].filter(Boolean).join(': ')}` : this.server);
    const v = this.view();
    if (v.size) {
      for (const [key, e] of v) {
        lines.push(...this.toolBlock(key, [...e.tools.values()], { describeAll: true, title: e.title, seen: opts.mark === false ? new Set<string>() : undefined }).map((l) => `  ${l}`));
        const close = this.closeHint(key);
        if (close) lines.push(`    ${close} closes it.`);
      }
    } else {
      lines.push('  nothing open');
    }
    const openable: string[] = [];
    for (const [name, d] of Object.entries(this.declared)) {
      if (!d.instances && this.isOpen(name)) continue;
      openable.push(
        `  ${name}${d.title ? ` — ${d.title}` : ''}${d.summary ? `: ${d.summary}` : ''}` +
          (d.instances ? ' (several can be open at once; name each with instance)' : '') +
          (d.options ? ` · options ${objectSignature(d.options)}` : ''),
      );
    }
    for (const g of this.undeclaredGroups) {
      if (this.groups.has(g)) continue;
      const names = this.allTools.filter((t) => this.toolsetOf(t.name) === g).map((t) => t.name);
      openable.push(`  ${g}: ${names.join(', ')}`);
    }
    if (openable.length) lines.push(`can open — ${this.names.open} {server:"${this.server}", toolset, instance?, options?}:`, ...openable);
    return lines.join('\n');
  }

  /** Where a tool can be called from now, for `look` naming it. */
  toolStatus(tool: string): string {
    if (this.presenceOf(tool) === 'static') return `static — called by name, as ${this.listedName(tool)}`;
    const where = [...this.view().entries()].filter(([, e]) => e.tools.has(tool)).map(([k]) => k);
    const ts = this.toolsetOf(tool);
    return where.length
      ? `available now in ${where.map((k) => this.label(k)).join(', ')} — ${this.names.act} {server:"${this.server}", tool:"${tool}"${where.length > 1 ? ', instance' : ''}, args}`
      : `not available right now${ts ? ` (toolset ${ts})` : ''}`;
  }

}
