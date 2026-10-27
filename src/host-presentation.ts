/**
 * The host's own toolsets (MCPL RFC-014 §8.5 host-made toolsets, §8.1 surface
 * presentation): how tools outside an agent's tool list are presented, for
 * the framework's built-in tools and for MCPL servers alike. It's host
 * presentation, not an MCPL wire change: it works for every server, with or
 * without RFC-014.
 *
 * - **The built-in toolset** (`settings`): the host tools an agent reaches
 *   for rarely (its settings, wake rules, observers, MCPL administration,
 *   status reads, modules' utilities, and every tool the agent hid from its
 *   own list). None of them is in the tool list; `toolsets--open` shows them,
 *   `toolsets--act` calls them while it's open.
 * - **MCPL server tabs**: each server is presented to each agent one of three
 *   ways. `full`: its tools in the tool list, as before. `tab` (a hidden
 *   tab): connected, its events still arrive, but none of its tools is in the
 *   tool list; `toolsets--open {server}` shows them and lets `toolsets--act`
 *   call them, `toolsets--close {server}` hides them again. `closed-tab`:
 *   disconnected until `toolsets--open {server}` reconnects it.
 *
 * The tool list (the request's header) changes only when a server switches
 * between full and a tab, or a tool is hidden or shown: opening, acting in and
 * closing a toolset never change it, so the prompt cache stays.
 *
 * State lives in one JSON file per store (`config/toolsets.json`): per agent,
 * which host toolsets are open and each server's presentation where it
 * differs from the configured default; per server (host-wide, since a
 * connection is the host's), whether it is disconnected as a closed tab.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDefinition } from './types/events.js';
import { checkArgs, firstSentence, renderToolDefinition, signature } from './mcpl/tool-signature.js';
import { META_TOOL_NAMES } from './mcpl/toolset-host.js';

/** The built-in toolset's name, as agents address it (`toolsets--open {toolset: "settings"}`). */
export const BUILTIN_TOOLSET = 'settings';

/** How a server is presented: in the tool list, as a tab (connected, hidden), or as a closed tab (disconnected). */
export type ServerPresentation = 'full' | 'tab' | 'closed-tab';

export const SERVER_PRESENTATIONS: readonly ServerPresentation[] = ['full', 'tab', 'closed-tab'];

/** A server as the host's presentation knows it. */
export interface PresentedServer {
  id: string;
  /** The operator's default for it (McplServerConfig.presentation), full when unset. */
  configured: ServerPresentation;
  /** Whether it's connected now. */
  connected: boolean;
}

export interface HostPresentationDeps {
  /** Every tool the agent may call now, before the tool list is trimmed (the "available" surface). */
  available(agentName: string): ToolDefinition[];
  /** Whether a tool belongs to the built-in toolset by the framework's or its module's placement. */
  placedInBuiltin(toolName: string): boolean;
  /** The tools the agent has hidden from its own list (tool presentation), by name. */
  hidden(agentName: string): ReadonlySet<string>;
  /** The MCPL server a tool name reaches, or null for a host tool. */
  serverOf(toolName: string): string | null;
  /** Every server the host has configured: connected, or kept as a closed tab. */
  servers(): PresentedServer[];
  /** Whether the agent can call the meta-tools: without them the host presents nothing out of the tool list. */
  canUseMeta(agentName: string): boolean;
  /** Disconnect a server, keeping its configuration to connect it again. */
  disconnect(serverId: string): Promise<void>;
  /** Connect a server kept as a closed tab, with its configuration and credentials. */
  reconnect(serverId: string): Promise<void>;
  /** Where a change of the tool list is said: logs. */
  log(line: string): void;
  /** Whether a host tool is a module utility: never in the tool list, whatever else. */
  isUtility(toolName: string): boolean;
  /** The resident agents of this host (no forks, ephemeral runs or the subconscious). */
  residents(): string[];
}

interface AgentState {
  /** Host toolsets this agent has open: `settings`, or a server's tab as `server:<id>`. */
  open: string[];
  /** Server presentations the agent chose, where they differ from the configured default. */
  servers: Record<string, 'full' | 'tab'>;
}

interface StateDoc {
  version: 1;
  agents: Record<string, AgentState>;
  /** Servers disconnected as closed tabs (true), or connected against a closed-tab default (false). */
  closed: Record<string, boolean>;
}

const emptyDoc = (): StateDoc => ({ version: 1, agents: {}, closed: {} });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseDoc(raw: string): StateDoc {
  const parsed = JSON.parse(raw) as unknown;
  if (!isObj(parsed) || parsed.version !== 1) throw new Error('not a version 1 toolsets state');
  const doc = emptyDoc();
  if (isObj(parsed.agents)) {
    for (const [name, value] of Object.entries(parsed.agents)) {
      if (!isObj(value)) continue;
      const open = Array.isArray(value.open) ? value.open.filter((x): x is string => typeof x === 'string') : [];
      const servers: Record<string, 'full' | 'tab'> = {};
      if (isObj(value.servers)) {
        for (const [id, mode] of Object.entries(value.servers)) if (mode === 'full' || mode === 'tab') servers[id] = mode;
      }
      doc.agents[name] = { open, servers };
    }
  }
  if (isObj(parsed.closed)) {
    for (const [id, closed] of Object.entries(parsed.closed)) if (typeof closed === 'boolean') doc.closed[id] = closed;
  }
  return doc;
}

const tabKey = (serverId: string) => `server:${serverId}`;

/** What a call through `toolsets--act` reaches when it's a host toolset's tool. */
export type HostActTarget =
  | { kind: 'call'; name: string; args: Record<string, unknown> }
  | { kind: 'refused'; error: string };

export class HostPresentation {
  private doc: StateDoc;

  constructor(private readonly deps: HostPresentationDeps, private readonly statePath: string | null) {
    this.doc = emptyDoc();
    if (statePath && existsSync(statePath)) {
      try {
        this.doc = parseDoc(readFileSync(statePath, 'utf8'));
      } catch (error) {
        // Kept, not written over: moved aside, so what an agent chose can be
        // read back by whoever runs the host.
        const aside = `${statePath}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        let moved = false;
        try { renameSync(statePath, aside); moved = true; } catch { /* left where it is */ }
        deps.log(`[toolsets] ${statePath} can't be read (${error instanceof Error ? error.message : String(error)}); `
          + (moved ? `moved aside to ${aside}; ` : 'left as it is, and not written to; ')
          + 'starting from the configured presentation');
        if (!moved) this.unwritable = true;
      }
    }
  }

  /** An unreadable state file that couldn't be moved aside is never written over. */
  private unwritable = false;
  /** Reconnects of closed tabs under way, so two opens make one connect. */
  private reconnecting = new Map<string, Promise<void>>();

  private save(): void {
    if (!this.statePath || this.unwritable) return;
    // An agent with nothing open and nothing chosen has no state to keep.
    for (const [name, a] of Object.entries(this.doc.agents)) {
      if (a.open.length === 0 && Object.keys(a.servers).length === 0) delete this.doc.agents[name];
    }
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.doc, null, 2) + '\n');
      renameSync(tmp, this.statePath);
    } catch (error) {
      this.deps.log(`[toolsets] couldn't save ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private agent(name: string): AgentState {
    return (this.doc.agents[name] ??= { open: [], servers: {} });
  }

  // ── what's known ──

  /** Whether the host presents anything outside this agent's tool list. */
  active(agentName: string): boolean {
    return this.deps.canUseMeta(agentName);
  }

  private server(id: string): PresentedServer | undefined {
    return this.deps.servers().find((s) => s.id === id);
  }

  /** Whether a server is kept disconnected as a closed tab (host-wide). */
  isClosedTab(serverId: string): boolean {
    const set = this.doc.closed[serverId];
    if (set !== undefined) return set;
    // A configured closed tab is closed until it's connected (by an open, or
    // a runtime connect that didn't ask).
    const server = this.server(serverId);
    return server?.configured === 'closed-tab' && !server.connected;
  }

  /** How a server is presented to an agent now. */
  presentation(agentName: string, serverId: string): ServerPresentation {
    if (this.isClosedTab(serverId)) return 'closed-tab';
    const chosen = this.doc.agents[agentName]?.servers[serverId];
    if (chosen) return chosen;
    const configured = this.server(serverId)?.configured ?? 'full';
    return configured === 'closed-tab' ? 'tab' : configured;
  }

  /** Servers to leave unconnected at startup: closed tabs, by state or by configured default. */
  startClosed(configs: ReadonlyArray<{ id: string; presentation?: ServerPresentation }>): Set<string> {
    const out = new Set<string>();
    for (const c of configs) {
      const set = this.doc.closed[c.id];
      if (set === true || (set === undefined && c.presentation === 'closed-tab')) out.add(c.id);
    }
    return out;
  }

  isOpen(agentName: string, key: string): boolean {
    return this.doc.agents[agentName]?.open.includes(key) ?? false;
  }

  private setOpen(agentName: string, key: string, open: boolean): void {
    const a = this.agent(agentName);
    const has = a.open.includes(key);
    if (open && !has) a.open.push(key);
    if (!open && has) a.open = a.open.filter((k) => k !== key);
    this.save();
  }

  // ── the tool list ──

  /** The tool list an agent is shown: what it may call, less the built-in toolset and its tabs. */
  header(agentName: string, tools: ToolDefinition[]): ToolDefinition[] {
    // Without the meta-tools nothing is presented out of the tool list, but a
    // utility still isn't in it: it was never a tool-list tool.
    if (!this.active(agentName)) return tools.filter((t) => isMetaTool(t.name) || !this.deps.isUtility(t.name));
    return tools.filter((t) => !this.outOfHeader(agentName, t.name));
  }

  private outOfHeader(agentName: string, name: string): boolean {
    if (isMetaTool(name)) return false;
    // A utility is never a tool-list tool, presented here or not.
    if (this.deps.isUtility(name)) return true;
    const server = this.deps.serverOf(name);
    if (server) return this.presentation(agentName, server) !== 'full';
    return this.deps.placedInBuiltin(name);
  }

  /** The built-in toolset's tools for an agent: its placed tools, and the host tools it hid. */
  builtinTools(agentName: string): ToolDefinition[] {
    const hidden = this.deps.hidden(agentName);
    return this.deps.available(agentName).filter((t) =>
      !isMetaTool(t.name) && this.deps.serverOf(t.name) === null && (this.deps.placedInBuiltin(t.name) || hidden.has(t.name)));
  }

  /** A server's tab's tools for an agent: all of them in a tab, its hidden ones while it's full. */
  tabTools(agentName: string, serverId: string): ToolDefinition[] {
    const full = this.presentation(agentName, serverId) === 'full';
    const hidden = this.deps.hidden(agentName);
    return this.deps.available(agentName).filter((t) => this.deps.serverOf(t.name) === serverId && (!full || hidden.has(t.name)));
  }

  // ── what an agent is told ──

  private announce(label: string, tools: ToolDefinition[], closeHint: string): string {
    const lines = [`${label} open: call these with ${META_TOOL_NAMES.act} {tool, args}; they aren't in your tool list.`];
    if (!tools.length) lines.push('  (none right now)');
    for (const t of tools) {
      const sentence = firstSentence(t.description);
      lines.push(`  ${signature(t)}${sentence ? ` — ${sentence}` : ''}`);
    }
    lines.push(`${closeHint} closes it.`);
    return lines.join('\n');
  }

  private builtinLabel = `[${BUILTIN_TOOLSET}]`;
  private tabLabel = (serverId: string) => `[tab ${serverId}]`;

  /** The catalog lines `toolsets--look` begins with. */
  catalog(agentName: string): string[] {
    const builtin = this.builtinTools(agentName);
    const lines = [
      `${this.builtinLabel} the host's settings and controls (${builtin.length} tool${builtin.length === 1 ? '' : 's'}): ` +
        (this.isOpen(agentName, BUILTIN_TOOLSET)
          ? `open — ${META_TOOL_NAMES.look} {toolset:"${BUILTIN_TOOLSET}"} lists them`
          : `closed — ${META_TOOL_NAMES.open} {toolset:"${BUILTIN_TOOLSET}"} opens it`),
    ];
    for (const s of this.deps.servers()) {
      const mode = this.presentation(agentName, s.id);
      const tabTools = this.tabTools(agentName, s.id);
      if (mode === 'full') {
        if (tabTools.length) lines.push(`${this.tabLabel(s.id)} in your tool list; ${tabTools.length} hidden tool${tabTools.length === 1 ? '' : 's'} in its tab (${this.isOpen(agentName, tabKey(s.id)) ? 'open' : `closed — ${META_TOOL_NAMES.open} {server:"${s.id}"} opens it`})`);
        else lines.push(`${this.tabLabel(s.id)} in your tool list — ${META_TOOL_NAMES.close} {server:"${s.id}"} moves it to a tab`);
      } else if (mode === 'tab') {
        lines.push(`${this.tabLabel(s.id)} a tab, connected (${tabTools.length} tool${tabTools.length === 1 ? '' : 's'}): ` +
          (this.isOpen(agentName, tabKey(s.id)) ? 'open' : `hidden — ${META_TOOL_NAMES.open} {server:"${s.id}"} opens it`) +
          `; ${META_TOOL_NAMES.open} {server:"${s.id}", full:true} puts it back in your tool list`);
      } else {
        lines.push(`${this.tabLabel(s.id)} a closed tab, disconnected: ${META_TOOL_NAMES.open} {server:"${s.id}"} connects and opens it`);
      }
    }
    return lines;
  }

  /** `toolsets--look {toolset:"settings"}` or `{server}`: one host toolset's tools. */
  lookToolset(agentName: string, which: { builtin: true } | { serverId: string }): string {
    if ('builtin' in which) {
      const tools = this.builtinTools(agentName);
      const open = this.isOpen(agentName, BUILTIN_TOOLSET);
      return [
        `${this.builtinLabel} ${open ? 'open' : 'closed'}${open ? '' : ` — ${META_TOOL_NAMES.open} {toolset:"${BUILTIN_TOOLSET}"} opens it`}`,
        ...tools.map((t) => `  ${signature(t)}${firstSentence(t.description) ? ` — ${firstSentence(t.description)}` : ''}`),
      ].join('\n');
    }
    const { serverId } = which;
    const mode = this.presentation(agentName, serverId);
    if (mode === 'closed-tab') return `${this.tabLabel(serverId)} a closed tab, disconnected: ${META_TOOL_NAMES.open} {server:"${serverId}"} connects and opens it.`;
    const tools = this.tabTools(agentName, serverId);
    const open = this.isOpen(agentName, tabKey(serverId));
    const head = mode === 'full'
      ? `${this.tabLabel(serverId)} in your tool list${tools.length ? `; its hidden tools (${open ? 'open' : 'closed'}):` : '.'}`
      : `${this.tabLabel(serverId)} a tab, connected, ${open ? 'open' : `hidden — ${META_TOOL_NAMES.open} {server:"${serverId}"} opens it`}:`;
    return [head, ...tools.map((t) => `  ${signature(t)}${firstSentence(t.description) ? ` — ${firstSentence(t.description)}` : ''}`)].join('\n');
  }

  /** `toolsets--look {tool}` for a host toolset's tool, or null when no host toolset has it. */
  lookTool(agentName: string, tool: string): string | null {
    const all = [...this.builtinTools(agentName), ...this.deps.servers().flatMap((s) => this.tabTools(agentName, s.id))];
    const def = all.find((t) => t.name === tool);
    if (!def) return null;
    return `${renderToolDefinition(def)}\n${this.homeOf(agentName, def.name)}`;
  }

  private homeOf(agentName: string, name: string): string {
    const server = this.deps.serverOf(name);
    if (server) return `in ${this.tabLabel(server)} (${this.isOpen(agentName, tabKey(server)) ? 'open' : 'closed'})`;
    return `in ${this.builtinLabel} (${this.isOpen(agentName, BUILTIN_TOOLSET) ? 'open' : 'closed'})`;
  }

  // ── open and close ──

  /** `toolsets--open {toolset:"settings"}`. */
  openBuiltin(agentName: string): string {
    this.setOpen(agentName, BUILTIN_TOOLSET, true);
    return this.announce(this.builtinLabel, this.builtinTools(agentName), `${META_TOOL_NAMES.close} {toolset:"${BUILTIN_TOOLSET}"}`);
  }

  /** `toolsets--close {toolset:"settings"}`. */
  closeBuiltin(agentName: string): string {
    const was = this.isOpen(agentName, BUILTIN_TOOLSET);
    this.setOpen(agentName, BUILTIN_TOOLSET, false);
    return was ? `${this.builtinLabel} closed.` : `${this.builtinLabel} wasn't open.`;
  }

  /** Whether a server id names a server the host presents (connected, or a closed tab). */
  knows(serverId: string): boolean {
    return this.server(serverId) !== undefined;
  }

  /** Connect a closed tab again: one connect, whoever else asks meanwhile. */
  private async reconnect(serverId: string): Promise<void> {
    let pending = this.reconnecting.get(serverId);
    if (!pending) {
      pending = (async () => {
        await this.deps.reconnect(serverId);
        this.doc.closed[serverId] = false;
      })().finally(() => this.reconnecting.delete(serverId));
      this.reconnecting.set(serverId, pending);
    }
    await pending;
  }

  /**
   * `toolsets--open {server}`: a closed tab is connected again; a tab's tools
   * are shown and callable through act; with `full`, the server goes back
   * into the tool list (one change of the tool list).
   */
  async openServer(agentName: string, serverId: string, opts: { full?: boolean } = {}): Promise<string> {
    const said: string[] = [];
    if (this.isClosedTab(serverId) || this.reconnecting.has(serverId)) {
      await this.reconnect(serverId);
      said.push(`${serverId} connected.`);
    }
    const a = this.agent(agentName);
    try {
      if (opts.full) {
        const was = this.presentation(agentName, serverId);
        a.servers[serverId] = 'full';
        a.open = a.open.filter((k) => k !== tabKey(serverId));
        said.push(was === 'full'
          ? `${serverId} is in your tool list already.`
          : `${serverId}'s tools are back in your tool list from your next request (your tool list changed, so that request writes its prompt cache again).`);
        return said.join('\n');
      }
      if (this.presentation(agentName, serverId) === 'full' && !this.tabTools(agentName, serverId).length) {
        said.push(`${serverId}'s tools are in your tool list: call them by name. ${META_TOOL_NAMES.close} {server:"${serverId}"} moves it to a tab.`);
        return said.join('\n');
      }
      if (!a.open.includes(tabKey(serverId))) a.open.push(tabKey(serverId));
      said.push(this.announce(this.tabLabel(serverId), this.tabTools(agentName, serverId), `${META_TOOL_NAMES.close} {server:"${serverId}"}`));
      return said.join('\n');
    } finally {
      this.save();
    }
  }

  /**
   * The other resident agents a server's disconnect would take it from. One
   * the host presents things to out of its tool list uses the server while
   * it's in that list or its tab is open; one that can't use the meta-tools
   * has every server in its list and couldn't open a closed tab again, so it
   * always does. A connection is the host's, so one agent's closed tab is
   * every agent's.
   */
  private otherUsers(agentName: string, serverId: string): string[] {
    return this.deps.residents().filter((other) => other !== agentName
      && (!this.active(other) || this.presentation(other, serverId) === 'full' || this.isOpen(other, tabKey(serverId))));
  }

  /**
   * `toolsets--close {server}`: a server in the tool list moves to a tab (one
   * change of the tool list); an open tab is hidden; with `disconnect`, the
   * server is disconnected as a closed tab until it's opened again, unless
   * another resident agent still uses it. The disconnect comes first: one
   * that fails changes nothing.
   */
  async closeServer(agentName: string, serverId: string, opts: { disconnect?: boolean } = {}): Promise<string> {
    const was = this.presentation(agentName, serverId);
    const wasOpen = this.isOpen(agentName, tabKey(serverId));
    let disconnected = false;
    if (opts.disconnect && !this.isClosedTab(serverId)) {
      const users = this.otherUsers(agentName, serverId);
      if (users.length) {
        return `${serverId} wasn't disconnected: ${users.join(', ')} still ${users.length === 1 ? 'uses' : 'use'} it, ` +
          `and a connection is the host's, every agent's. Nothing was changed. ` +
          `${META_TOOL_NAMES.close} {server:"${serverId}"} without disconnect moves it out of your own tool list.`;
      }
      await this.deps.disconnect(serverId);
      this.doc.closed[serverId] = true;
      disconnected = true;
    }
    const said: string[] = [];
    const a = this.agent(agentName);
    try {
      if (was === 'full') {
        a.servers[serverId] = 'tab';
        said.push(`${serverId}'s tools leave your tool list from your next request (your tool list changed, so that request writes its prompt cache again); its tab: ${META_TOOL_NAMES.open} {server:"${serverId}"}.`);
      } else if (wasOpen) {
        said.push(disconnected ? `${this.tabLabel(serverId)} hidden.` : `${this.tabLabel(serverId)} hidden; it stays connected.`);
      }
      a.open = a.open.filter((k) => k !== tabKey(serverId));
      if (disconnected) said.push(`${serverId} disconnected: none of its events reach you until ${META_TOOL_NAMES.open} {server:"${serverId}"} connects it again.`);
      else if (opts.disconnect) said.push(`${serverId} is disconnected already.`);
    } finally {
      this.save();
    }
    if (!said.length) said.push(`${this.tabLabel(serverId)} is hidden already.`);
    return said.join('\n');
  }

  /** A server connected by other means (an operator's connect, a deploy): no longer a closed tab. */
  noteConnected(serverId: string): void {
    if (this.doc.closed[serverId] === true) {
      this.doc.closed[serverId] = false;
      this.save();
    }
  }

  /** A server removed for good (an operator's disconnect): nothing of its tab is kept. */
  noteRemoved(serverId: string): void {
    let changed = false;
    if (serverId in this.doc.closed) { delete this.doc.closed[serverId]; changed = true; }
    for (const a of Object.values(this.doc.agents)) {
      if (serverId in a.servers) { delete a.servers[serverId]; changed = true; }
      const open = a.open.filter((k) => k !== tabKey(serverId));
      if (open.length !== a.open.length) { a.open = open; changed = true; }
    }
    if (changed) this.save();
  }

  // ── act ──

  /**
   * `toolsets--act` for a host toolset's tool: the call it makes, under the
   * tool's own name; a refusal when its toolset isn't open or its arguments
   * don't fit its definition; null when no host toolset has the tool (an
   * RFC-014 dynamic tool's call goes on to the server's toolsets). A
   * server's tool may be named in full, or bare with `server`.
   */
  resolveAct(agentName: string, input: unknown): HostActTarget | null {
    if (!this.active(agentName)) return null;
    const args = isObj(input) ? input : {};
    const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (!tool) return null;
    const server = typeof args.server === 'string' && args.server.trim() ? args.server.trim() : undefined;
    const builtin = this.builtinTools(agentName);
    const inTabs = this.deps.servers().filter((s) => !server || s.id === server).flatMap((s) => this.tabTools(agentName, s.id));
    const listed = (!server ? builtin.find((t) => t.name === tool) : undefined)
      ?? inTabs.find((t) => t.name === tool)
      ?? (server ? inTabs.find((t) => t.name.endsWith(`--${tool}`) && this.deps.serverOf(t.name) === server) : undefined);
    // A host toolset's tool the agent may not call isn't listed to it; its
    // call still goes on, by name, for dispatch to refuse as it would a
    // direct call, rather than reading as no such tool.
    const def: { name: string; inputSchema?: unknown } | undefined = listed
      ?? (!server && this.deps.serverOf(tool) === null && this.deps.placedInBuiltin(tool) ? { name: tool } : undefined);
    if (!def) {
      if (server && this.isClosedTab(server)) return { kind: 'refused', error: `${server} is a closed tab, disconnected: ${META_TOOL_NAMES.open} {server:"${server}"} connects it. Nothing was sent.` };
      return null;
    }
    if (args.args !== undefined && !isObj(args.args)) return { kind: 'refused', error: 'args must be an object of the tool\'s arguments; nothing was sent' };
    const home = this.deps.serverOf(def.name);
    const key = home ? tabKey(home) : BUILTIN_TOOLSET;
    if (!this.isOpen(agentName, key)) {
      const opener = home ? `${META_TOOL_NAMES.open} {server:"${home}"}` : `${META_TOOL_NAMES.open} {toolset:"${BUILTIN_TOOLSET}"}`;
      return { kind: 'refused', error: `${def.name} is in ${home ? this.tabLabel(home) : this.builtinLabel}, which isn't open: ${opener} opens it. Nothing was sent.` };
    }
    const callArgs = (args.args ?? {}) as Record<string, unknown>;
    // As a server's dynamic tool is checked before it's sent (RFC §6.1): the
    // arguments against the definition the agent was shown.
    if (def.inputSchema !== undefined) {
      const problem = checkArgs(def.inputSchema, callArgs);
      if (problem) {
        // A key the definition doesn't have is named too, since it's often
        // the cause of a missing one (a misspelling).
        const props = isObj(def.inputSchema) && isObj((def.inputSchema as Record<string, unknown>).properties)
          ? Object.keys((def.inputSchema as Record<string, unknown>).properties as Record<string, unknown>) : null;
        const unknown = props ? Object.keys(callArgs).filter((k) => !props.includes(k)) : [];
        const extra = unknown.length
          ? `; ${unknown.map((k) => JSON.stringify(k)).join(', ')} ${unknown.length === 1 ? "isn't one of its parameters" : "aren't among its parameters"}`
          : '';
        return { kind: 'refused', error: `Invalid arguments for ${def.name}: ${problem}${extra}. Nothing was sent; ${META_TOOL_NAMES.look} {tool:"${def.name}"} shows its definition.` };
      }
    }
    return { kind: 'call', name: def.name, args: callArgs };
  }

  // ── reminders (RFC-014 §8.3) ──

  /**
   * The open host toolsets of an agent: each one's marker (its announcement's
   * first words, which a reminder repeats) and its reminder, worked out only
   * when one is due. `dueWhenAbsent`: such a toolset is due whenever a
   * request doesn't carry its marker, even one never seen since the host
   * started (open across a restart).
   */
  openMarkers(agentName: string): Array<{ marker: string; reminder: () => string; dueWhenAbsent: true }> {
    if (!this.active(agentName)) return [];
    const out: Array<{ marker: string; reminder: () => string; dueWhenAbsent: true }> = [];
    for (const key of this.doc.agents[agentName]?.open ?? []) {
      if (key === BUILTIN_TOOLSET) {
        out.push({
          marker: `${this.builtinLabel} open`,
          dueWhenAbsent: true,
          reminder: () => `${this.builtinLabel} open: ${this.builtinTools(agentName).map((t) => t.name).join(', ') || '(none)'} — through ${META_TOOL_NAMES.act}; ${META_TOOL_NAMES.close} {toolset:"${BUILTIN_TOOLSET}"} closes it.`,
        });
      } else if (key.startsWith('server:')) {
        const id = key.slice('server:'.length);
        if (!this.knows(id) || this.isClosedTab(id)) continue;
        out.push({
          marker: `${this.tabLabel(id)} open`,
          dueWhenAbsent: true,
          reminder: () => `${this.tabLabel(id)} open: ${this.tabTools(agentName, id).map((t) => t.name).join(', ') || '(none)'} — through ${META_TOOL_NAMES.act}; ${META_TOOL_NAMES.close} {server:"${id}"} hides it.`,
        });
      }
    }
    return out;
  }
}

/** The meta-tools themselves never leave the tool list: they're how anything else is reached. */
export function isMetaTool(name: string): boolean {
  return name === META_TOOL_NAMES.open || name === META_TOOL_NAMES.act || name === META_TOOL_NAMES.look || name === META_TOOL_NAMES.close;
}
