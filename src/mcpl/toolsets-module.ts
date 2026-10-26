/**
 * The host's own interface to MCPL dynamic tools (RFC-014 §8.2): four tools,
 * constant and static, aggregated across every server that presents
 * toolsets.
 *
 *   toolsets--open  {server?, toolset?, instance?, options?}
 *   toolsets--act   {server?, tool, instance?, args?}
 *   toolsets--look  {server?, toolset?, instance?, tool?}
 *   toolsets--close {server?, toolset?, instance?}
 *
 * Dynamic tools never enter the API tool list: changing it rebuilds the
 * prompt cache. They're announced in the conversation (in these tools'
 * results, in the results of calls that changed them, in push events and in
 * notices) and called through `toolsets--act`, which this module only
 * resolves (resolveAct): the framework dispatches the call it resolves to
 * down the same path as a direct call of the server's tool. The module is registered when a server is
 * configured with `toolHints: true`; its tools never change after that.
 *
 * Its gatherContext publishes the RFC §8.3 reminder, as a stored `afterUser`
 * injection, when an agent's earlier announcements of an open toolset have
 * left its context (ToolsetHub.observeCompile).
 *
 * Ported from mcpl-cc-bridge's meta-tools.ts, the reference host.
 */
import type { EventResponse, Module, ModuleContext, ModuleContextInjection, ProcessState } from '../types/module.js';
import type { ProcessEvent, ToolCall, ToolDefinition, ToolResult } from '../types/events.js';
import { unknownToolMessage } from '../modules/unknown-tool.js';
import { META_TOOL_NAMES, TOOLSETS_MODULE, type ToolsetController, type ToolsetHub } from './toolset-host.js';
import { keyOf, type ChangeSet } from './tool-presence.js';
import { checkArgs, jsonText, renderToolDefinition, type HintedTool } from './tool-signature.js';

/** The namespace a reminder's stored injection carries. */
export const TOOLSETS_REMINDER_NAMESPACE = 'mcpl-toolsets';

const META_TOOLS: ToolDefinition[] = [
  {
    name: 'open',
    description:
      'Open a toolset of an MCPL server (a game, a building mode, a card table) so its tools can be called with toolsets--act. ' +
      'Returns what the server shows on opening and the tools available now. server may be left out when one server has the toolset, ' +
      'and toolset when the server has only one; instance names a separate copy where a toolset allows several (two games at once); ' +
      'options as toolsets--look lists them.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'the MCPL server id' },
        toolset: { type: 'string' },
        instance: { type: 'string', description: 'a name for this copy (toolsets with instances only)' },
        options: { type: 'object', description: 'toolset options, as toolsets--look shows them' },
      },
    },
  },
  {
    name: 'act',
    description:
      'Call a tool that was announced in the conversation (a tool of an open toolset, or another dynamic tool); they are not in your tool list. ' +
      'args are the arguments its signature shows; instance picks the open copy when several are open; server is needed only when two servers have the tool. ' +
      'Returns the server\'s result, then any change it made in which tools are available, unless that change already went out as a notice (or was due as one and none could be written). toolsets--look shows what is available now.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'the MCPL server id (only needed when two servers have the tool)' },
        tool: { type: 'string' },
        instance: { type: 'string', description: 'which open copy (only needed when several are open)' },
        args: { type: 'object' },
      },
      required: ['tool'],
    },
  },
  {
    name: 'look',
    description:
      'Show what is open and what can be opened on MCPL servers, with the tools usable now: announcements earlier in the conversation may be out of date. ' +
      'With tool: that tool\'s full description and input schema. With toolset or instance: just that one.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        toolset: { type: 'string' },
        instance: { type: 'string' },
        tool: { type: 'string' },
      },
    },
  },
  {
    name: 'close',
    description: 'Close an open toolset or instance: its tools and its events stop. Closing a game in progress may count as leaving it.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'the MCPL server id (may be left out when one server has the toolset open)' },
        toolset: { type: 'string', description: 'may be left out when only one thing is open on the server' },
        instance: { type: 'string' },
      },
    },
  },
];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Block = { type: string; text?: string; [k: string]: unknown };

class MetaError extends Error {}
const fail = (message: string): never => {
  throw new MetaError(message);
};

/** A text-only result. */
const textResult = (text: string): ToolResult => ({ success: true, data: text });

/** Adjacent text blocks merged, so a result reads as one message. */
function mergeText(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && !b.text) continue;
    const prev = out[out.length - 1];
    if (b.type === 'text' && prev?.type === 'text') out[out.length - 1] = { type: 'text', text: `${prev.text}\n${b.text}` };
    else out.push(b);
  }
  return out;
}

/** Content blocks as a result: content when anything isn't text, else its text. */
function blocksResult(blocks: Block[], isError = false): ToolResult {
  const merged = mergeText(blocks);
  if (isError) {
    const text = merged.map((b) => (b.type === 'text' ? b.text ?? '' : `[${b.type}]`)).join('\n');
    return { success: false, isError: true, error: text || 'the server answered with an error' };
  }
  if (merged.every((b) => b.type === 'text')) return textResult(merged.map((b) => b.text ?? '').join('\n'));
  return { success: true, data: merged, dataIsContent: true };
}

const asBlocks = (content: unknown[]): Block[] => content.filter((b): b is Block => isObj(b) && typeof b.type === 'string');


// ── choosing the server ──

function pick(hub: ToolsetHub, server: unknown): ToolsetController {
  const id = str(server);
  const ids = hub.presenting().map((c) => c.serverId);
  if (!id) {
    if (ids.length === 1) return hub.get(ids[0]!)!;
    return fail(`name a server: ${ids.join(', ') || '(no MCPL server presents toolsets now)'}`);
  }
  const c = hub.get(id);
  if (!c) return fail(`no server "${id}" presents toolsets; the ones that do: ${ids.join(', ') || 'none'}`);
  if (!c.presence.active) return fail(`${id} sends no tool hints now: its tools are in your tool list`);
  return c;
}

/**
 * RFC §8.2: `server` may be left out; the name decides, when exactly one
 * presenting server has it. Two or more: name the server.
 */
function owner(hub: ToolsetHub, server: unknown, has: (c: ToolsetController) => boolean, what: string): ToolsetController {
  if (str(server)) return pick(hub, server);
  const owners = hub.presenting().filter(has);
  if (owners.length === 1) return owners[0]!;
  return fail(owners.length
    ? `${what} is on several servers (${owners.map((c) => c.serverId).join(', ')}): add server`
    : `no server that presents toolsets has ${what}`);
}

/** What a `toolsets--act` call resolves to: the server's tool, its instance and arguments. */
export type ActTarget = { ok: true; serverId: string; tool: string; instance?: string; args: Record<string, unknown> } | { ok: false; error: string };

/**
 * Resolve a `toolsets--act` call (RFC §8.2) to the dynamic tool it calls,
 * or the reason it can't be sent. The framework then dispatches it exactly as
 * a direct call of that tool, with `_meta["mcpl/instance"]` added (RFC §5.5).
 * Refused here, before anything is sent: a tool no presenting server has, a
 * static tool (it's in the tool list), an instance that isn't named where
 * several are open, a group the host has closed (RFC §5.4), and arguments
 * that don't fit the definition in force for that instance (RFC §6.1).
 */
export function resolveAct(hub: ToolsetHub, input: unknown): ActTarget {
  try {
    const args = isObj(input) ? input : {};
    const tool = str(args.tool) ?? fail('name the tool');
    const c = owner(hub, args.server, (x) => !!x.presence.tool(tool), `a tool "${tool}"`);
    const p = c.presence;
    if (!p.tool(tool)) fail(`${c.serverId} has no tool "${tool}": ${META_TOOL_NAMES.look} {server:"${c.serverId}"} shows what's available`);
    if (p.presenceOf(tool) === 'static') fail(`${tool} is not a dynamic tool: ${p.toolStatus(tool)}. Call it there.`);
    if (args.args !== undefined && !isObj(args.args)) fail('args must be an object of the tool\'s arguments');
    const callArgs = (args.args ?? {}) as Record<string, unknown>;
    let instance = str(args.instance);
    const ts = p.toolsetOf(tool);
    const declared = ts !== undefined && p.isDeclared(ts);
    const withInstances = declared && !!p.declared[ts!]!.instances;
    if (withInstances && !instance) {
      // RFC §5.5: the instance rides in _meta; with exactly one open, it's that one.
      const open = p.openRecords(ts);
      if (open.length === 1) instance = open[0]!.instance;
      else if (!open.length) fail(`${tool} belongs to ${ts}, which isn't open: ${p.openHint(ts!)}`);
      else fail(`several ${ts} instances are open (${open.map((o) => o.instance).join(', ')}): say which with instance`);
    }
    if (instance && !withInstances) fail(`${tool} ${ts ? `belongs to ${ts}, which has no instances` : 'belongs to no toolset'}: call it without instance`);
    // RFC §5.4: the host gates calls into an undeclared group it has closed.
    if (ts && !declared && !p.isOpen(ts)) fail(`${tool} is in ${ts}, which isn't open: ${p.openHint(ts)}`);
    // RFC §6.1: arguments are checked against the definition in force for
    // that instance: its own from hints (the legal moves of one game), else
    // the toolset's, else the listed one.
    const key = ts ? keyOf(ts, withInstances ? instance : undefined) : keyOf('');
    const problem = checkArgs(p.defOf(key, tool).inputSchema, callArgs);
    if (problem) {
      fail(`Invalid arguments for ${tool} in ${p.label(key)}: ${problem}. Nothing was sent; ` +
        `${META_TOOL_NAMES.look} {server:"${c.serverId}", tool:"${tool}"${instance ? `, instance:"${instance}"` : ''}} shows its current definition.`);
    }
    return { ok: true, serverId: c.serverId, tool, ...(instance ? { instance } : {}), args: callArgs };
  } catch (error) {
    if (error instanceof MetaError) return { ok: false, error: error.message };
    throw error;
  }
}

export class ToolsetsModule implements Module {
  readonly name = TOOLSETS_MODULE;

  constructor(private readonly hub: ToolsetHub) {}

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return META_TOOLS;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /** RFC §8.3: the reminder due for this agent, stored where compile() would place it. */
  async gatherContext(agentName: string): Promise<ModuleContextInjection[]> {
    const reminder = this.hub.reminderFor(agentName);
    if (!reminder) return [];
    return [{ namespace: TOOLSETS_REMINDER_NAMESPACE, position: 'afterUser', content: [{ type: 'text', text: reminder }] }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const args = isObj(call.input) ? call.input : {};
    try {
      switch (call.name) {
        case 'open': return await this.open(args);
        case 'act': return this.act(args);
        case 'look': return await this.look(args);
        case 'close': return await this.close(args);
        default: return { success: false, isError: true, error: unknownToolMessage(this.name, call.name, META_TOOLS) };
      }
    } catch (error) {
      const message = error instanceof MetaError
        ? error.message
        : `${META_TOOL_NAMES[call.name as keyof typeof META_TOOL_NAMES] ?? call.name}: ${error instanceof Error ? error.message : String(error)}`;
      return { success: false, isError: true, error: message };
    }
  }

  private toolsAt(c: ToolsetController, key: string): HintedTool[] {
    return [...(c.presence.view().get(key)?.tools.values() ?? [])];
  }

  /** A change set rendered without the key the caller already showed whole. */
  private renderOthers(c: ToolsetController, cs: ChangeSet, key: string): string {
    return c.presence.render({ ...cs, changes: cs.changes.filter((ch) => ch.key !== key) });
  }

  // ── the tools ──

  private async open(args: Record<string, unknown>): Promise<ToolResult> {
    let toolset = str(args.toolset);
    const c = toolset && !str(args.server)
      ? owner(this.hub, undefined, (x) => x.presence.isDeclared(toolset!) || x.presence.undeclaredGroups.includes(toolset!), `a toolset "${toolset}"`)
      : pick(this.hub, args.server);
    const p = c.presence;
    const openable = [...Object.keys(p.declared), ...p.undeclaredGroups];
    if (!toolset) {
      if (openable.length !== 1) fail(`${c.serverId} has ${openable.length ? `several toolsets: name one of ${openable.join(', ')}` : 'no toolsets'}`);
      toolset = openable[0]!;
    }
    const instance = str(args.instance);
    if (args.options !== undefined && !isObj(args.options)) fail('options must be an object');
    const options = args.options as Record<string, unknown> | undefined;

    if (p.isDeclared(toolset)) {
      if (instance && !p.declared[toolset]!.instances) fail(`${c.serverId}/${toolset} has no instances: open it without one`);
      let opened: Awaited<ReturnType<ToolsetController['open']>>;
      try {
        opened = await c.open(toolset, instance, options);
      } catch (error) {
        return fail(`${c.serverId} did not open ${toolset}: ${error instanceof Error ? error.message : String(error)}`);
      }
      // RFC §5.2: opening what is open adopts it; its content says which options weren't applied.
      const blocks: Block[] = [
        { type: 'text', text: `${p.label(opened.key)}${opened.title ? ` ${opened.title}` : ''}${opened.adopted ? ' (already open)' : ''}` },
        ...asBlocks(opened.content),
      ];
      const tail = [...p.toolBlock(opened.key, this.toolsAt(c, opened.key), { headed: false })];
      const gone = opened.change.changes.find((ch) => ch.key === opened.key)?.gone ?? [];
      if (gone.length) tail.push(`now unavailable: ${gone.join(', ')}`);
      const others = this.renderOthers(c, opened.change, opened.key);
      if (others) tail.push(others);
      const close = p.closeHint(opened.key);
      if (close) tail.push(`${close} closes it.`);
      blocks.push({ type: 'text', text: tail.join('\n') });
      c.told(opened.change);
      return blocksResult(blocks);
    }
    if (p.undeclaredGroups.includes(toolset)) {
      // RFC §5.4: a grouping the server offers but doesn't track: the host opens it, the server isn't told.
      if (instance || options) fail(`${c.serverId}/${toolset} takes no instance or options (the server doesn't declare it)`);
      const cs = c.setGroupOpen(toolset, true);
      const key = keyOf(toolset);
      const lines = [`${p.label(key)} open.`, ...p.toolBlock(key, this.toolsAt(c, key), { headed: false })];
      const others = this.renderOthers(c, cs, key);
      if (others) lines.push(others);
      lines.push(`${p.closeHint(key)} closes it.`);
      return textResult(lines.join('\n'));
    }
    return fail(`${c.serverId} has no toolset "${toolset}"${openable.length ? `; it has ${openable.join(', ')}` : ''}`);
  }

  /**
   * act is dispatched by the framework, not here: it resolves the call
   * (resolveAct) and sends it down the same path as a direct call of the
   * server's tool, so state, results, refusals and lifecycle are the same.
   * A caller that reaches the module itself gets the resolution's refusal,
   * or this.
   */
  private act(args: Record<string, unknown>): ToolResult {
    const target = resolveAct(this.hub, args);
    if (!target.ok) return { success: false, isError: true, error: target.error };
    return { success: false, isError: true, error: `${META_TOOL_NAMES.act} is dispatched by the framework; nothing was sent` };
  }

  /** look restates the present: titles and visibility are re-read from the servers first (toolsets/list). */
  private async look(args: Record<string, unknown>): Promise<ToolResult> {
    const server = str(args.server);
    const targets = server ? [this.hub.get(server)].filter((c): c is ToolsetController => !!c && c.presents) : this.hub.presenting();
    const read = (await Promise.all(targets.map(async (c) => ({ c, cs: await c.refreshOpen().catch(() => null) }))))
      .filter((r): r is { c: ToolsetController; cs: ChangeSet } => r.cs !== null);
    let result: ToolResult;
    try {
      result = this.lookNow(args, server, str(args.tool));
    } catch (error) {
      for (const { c, cs } of read) c.tell(cs);
      throw error;
    }
    const restates = !str(args.tool) && !str(args.toolset) && !str(args.instance);
    if (result.isError || typeof result.data !== 'string' || !restates) {
      for (const { c, cs } of read) c.tell(cs);
      return result;
    }
    const lines = read.flatMap(({ c, cs }) => {
      const shown = [...cs.suggest.map((s) => c.presence.renderSuggestion(s)), ...c.presence.untoldNotes(cs), ...cs.notes];
      c.told(cs);
      return shown;
    });
    return lines.length ? textResult(`${result.data}\n${lines.join('\n')}`) : result;
  }

  private lookNow(args: Record<string, unknown>, server: string | undefined, tool: string | undefined): ToolResult {
    if (!server) {
      if (tool) return this.lookTool(owner(this.hub, undefined, (c) => !!c.presence.tool(tool), `a tool "${tool}"`), tool, str(args.instance));
      const ts = str(args.toolset);
      const inst = str(args.instance);
      if (ts || inst) {
        const c = owner(this.hub, 
          undefined,
          (x) => (ts ? x.presence.isDeclared(ts) || x.presence.undeclaredGroups.includes(ts) : true) && (!inst || x.presence.openRecords().some((o) => o.instance === inst)),
          ts ? `a toolset "${ts}"${inst ? ` with instance "${inst}"` : ''}` : `an open instance "${inst}"`,
        );
        return this.lookNow(args, c.serverId, tool);
      }
      const all = this.hub.presenting();
      if (!all.length) return textResult('No MCPL server presents toolsets or dynamic tools now; every tool is in your tool list.');
      return textResult(all.map((c) => c.presence.catalog()).join('\n\n'));
    }
    const c = pick(this.hub, server);
    if (tool) return this.lookTool(c, tool, str(args.instance));
    const p = c.presence;
    let toolset = str(args.toolset);
    const instance = str(args.instance);
    if (!toolset && instance) toolset = p.openRecords().find((o) => o.instance === instance)?.toolset ?? fail(`no open instance "${instance}" on ${c.serverId}`);
    if (!toolset) return textResult(p.catalog());
    if (p.isOpen(toolset, instance) || (!instance && p.openRecords(toolset).length === 1)) {
      const rec = p.isDeclared(toolset) ? (instance ? p.openRecords(toolset).find((o) => o.instance === instance) : p.openRecords(toolset)[0]) : undefined;
      const key = keyOf(toolset, rec?.instance);
      const lines = p.toolBlock(key, this.toolsAt(c, key), { describeAll: true, title: rec?.title });
      const close = p.closeHint(key);
      if (close) lines.push(`${close} closes it.`);
      return textResult(lines.join('\n'));
    }
    const d = p.declared[toolset];
    if (d) {
      const open = p.openRecords(toolset);
      return textResult([
        `${c.serverId}/${toolset}${d.title ? ` — ${d.title}` : ''}${d.summary ? `: ${d.summary}` : ''}`,
        open.length ? `open: ${open.map((o) => o.instance ?? toolset).join(', ')}` : 'not open',
        ...(d.instances ? ['several can be open at once; name each with instance'] : []),
        ...(d.options ? [`options: ${jsonText(d.options)}`] : []),
        `${p.openHint(toolset)} opens it.`,
      ].join('\n'));
    }
    if (p.undeclaredGroups.includes(toolset)) {
      const names = p.allTools.filter((t) => p.toolsetOf(t.name) === toolset).map((t) => t.name);
      return textResult(`${c.serverId}/${toolset}: ${names.join(', ')}; not open: ${p.openHint(toolset)} opens it.`);
    }
    return fail(`${c.serverId} has no toolset "${toolset}"`);
  }

  private lookTool(c: ToolsetController, tool: string, instance: string | undefined): ToolResult {
    const p = c.presence;
    if (!p.tool(tool)) fail(`${c.serverId} has no tool "${tool}"`);
    const ts = p.toolsetOf(tool);
    const where = [...p.view().entries()].filter(([, e]) => e.tools.has(tool)).map(([k]) => k);
    const key = instance && ts ? keyOf(ts, instance) : where[0];
    const def = key ? p.defOf(key, tool) : p.tool(tool)!;
    return textResult(`${renderToolDefinition(def)}\n${p.toolStatus(tool)}`);
  }

  private async close(args: Record<string, unknown>): Promise<ToolResult> {
    const named = str(args.toolset);
    const c = named && !str(args.server)
      ? owner(this.hub, undefined, (x) => x.presence.isOpen(named, str(args.instance)) || x.presence.openRecords(named).length > 0, `an open toolset "${named}"`)
      : pick(this.hub, args.server);
    const p = c.presence;
    let toolset = named;
    let instance = str(args.instance);
    if (!toolset) {
      const open = [
        ...p.openRecords().filter((o) => !instance || o.instance === instance),
        ...(instance ? [] : p.openGroups.map((g) => ({ toolset: g, instance: undefined as string | undefined }))),
      ];
      if (open.length !== 1) {
        fail(open.length
          ? `several are open on ${c.serverId}: name one of ${open.map((o) => `${o.toolset}${o.instance ? `:${o.instance}` : ''}`).join(', ')}`
          : `nothing is open on ${c.serverId}`);
      }
      toolset = open[0]!.toolset;
      instance = open[0]!.instance;
    }
    if (p.isDeclared(toolset!)) {
      // As open refuses one: a toolset without instances is closed without one.
      if (instance && !p.declared[toolset!]!.instances) fail(`${c.serverId}/${toolset} has no instances: close it without one`);
      if (p.declared[toolset!]!.instances && !instance) {
        const open = p.openRecords(toolset);
        if (open.length !== 1) fail(open.length ? `several ${toolset} instances are open (${open.map((o) => o.instance).join(', ')}): say which` : `${toolset} is not open`);
        instance = open[0]!.instance;
      }
      let closed: Awaited<ReturnType<ToolsetController['close']>>;
      try {
        closed = await c.close(toolset!, instance);
      } catch (error) {
        return fail(`${c.serverId} did not close ${toolset}${instance ? `:${instance}` : ''}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const key = keyOf(toolset!, instance);
      const change = p.render(closed.change) || `${p.label(key)} closed.`;
      c.told(closed.change);
      return blocksResult([...asBlocks(closed.content), { type: 'text', text: change }]);
    }
    if (p.undeclaredGroups.includes(toolset!)) {
      if (instance) fail(`${c.serverId}/${toolset} takes no instance (the server doesn't declare it)`);
      if (!p.isOpen(toolset!)) fail(`${c.serverId}/${toolset} is not open`);
      const cs = c.setGroupOpen(toolset!, false);
      return textResult(p.render(cs) || `${p.label(keyOf(toolset!))} closed.`);
    }
    return fail(`${c.serverId} has no toolset "${toolset}"`);
  }
}
