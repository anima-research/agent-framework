/**
 * Tool classes (MCPL RFC-008) — a coarse, fixed vocabulary for what a tool
 * DOES, used as a key for host policy (RFC-007's argument exclusions today;
 * approvals, audit grouping and caps later).
 *
 * A class is a HINT at the tier of MCP `annotations`, never a grant: it
 * confers no authority, gates no method, and never changes what the model
 * sees. The providing server declares it on its MCP tool definition as
 * `_meta["mcpl/class"]`; the host computes an EFFECTIVE class per tool from
 * (in precedence order, first source that yields a class wins entirely):
 *
 *   1. operator override (FrameworkConfig.toolClassOverrides),
 *   2. the host's own knowledge of tools it implements (BUILTIN_TOOL_CLASSES
 *      plus FrameworkConfig.hostToolClasses for an embedding host's modules),
 *   3. the server's declaration.
 *
 * An UNCLASSED tool is handled as the most restrictive class for every
 * question asked of it (RFC-008 §5.2): classing is how a tool earns looser
 * handling, never how it is denied. A tool with several classes gets the
 * union of their restrictions (§5.3).
 */

import { globMatch } from './tool-glob.js';

export const TOOL_CLASSES = [
  'comms',
  'memory',
  'notes',
  'files',
  'shell',
  'web',
  'computer',
  'media',
  'body',
  'control',
] as const;

export type ToolClass = (typeof TOOL_CLASSES)[number];

const CLASS_SET: ReadonlySet<string> = new Set(TOOL_CLASSES);

export function isToolClass(value: unknown): value is ToolClass {
  return typeof value === 'string' && CLASS_SET.has(value);
}

/** The `_meta` key a server declares a tool's class under (RFC-008 §3). */
export const TOOL_CLASS_META_KEY = 'mcpl/class';

/**
 * Classes whose arguments are ordinarily safe to show an observer (RFC-007
 * §4.3's recommended default `inputs` policy). `memory`, `notes` and
 * `control` are left to explicit operator choice; `comms` is never a choice.
 */
export const DEFAULT_INPUT_CLASSES: readonly ToolClass[] = [
  'computer',
  'shell',
  'files',
  'web',
  'media',
  'body',
];

/**
 * Classes of the tools this framework implements itself — the host's own
 * knowledge (RFC-008 §5.1 source 2). Keys use the RFC-007 §6.2 pattern
 * grammar over the model-facing tool name. Anything not listed here, not
 * overridden and not declared by its server is UNCLASSED, which is the
 * restrictive answer — so an omission here fails closed.
 */
export const BUILTIN_TOOL_CLASSES: Readonly<Record<string, readonly ToolClass[]>> = {
  // Synthesized channel tools: speech to and from people (RFC-008 §4:
  // speech that reaches a person is comms, wherever it goes).
  'channel_*': ['comms'],
  // Deliberately staying silent in a conversation is still about that
  // conversation; its reason text can quote it.
  skip_reply: ['comms'],
  // The agent's private interior.
  think: ['memory'],
  journal: ['memory'],
  // Host and agent settings, wake policy, routing help.
  utils: ['control'],
  agent_settings: ['control'],
  gate_status: ['control'],
  tune_out: ['control'],
  sleep: ['control'],
  wake: ['control'],
  wake_add_rule: ['control'],
  wake_remove_rule: ['control'],
  event_tags: ['control'],
  prose_help: ['control'],
  // Files and blobs in the agent's own stores.
  save_recent_image: ['files'],
  read_image: ['files'],
  // RFC-005 references resolve to the agent's own or private documents, not
  // the public network (RFC-008 §4: private fetches are files/notes).
  fetch_reference: ['files'],
  // Runs code that may do anything: the class describes the tool.
  code_execution: ['shell'],
  // Built-in modules.
  'discord--*': ['comms'],
  'history--*': ['memory'],
  'workspace--*': ['files'],
  'health--*': ['control'],
  'api--*': ['control'],
};

/**
 * Read a server's class declaration from a tool definition's `_meta`.
 * Returns the known classes it names (deduplicated, in order), or undefined
 * when it names none — which makes the tool unclassed. Unknown strings are
 * ignored for policy and logged (RFC-008 §3, vectors 3 and 4); a non-array
 * value is malformed and ignored the same way.
 */
export function parseDeclaredClasses(meta: unknown, toolName = '(unnamed)'): ToolClass[] | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const raw = (meta as Record<string, unknown>)[TOOL_CLASS_META_KEY];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.error(`[mcpl] ${toolName}: _meta["${TOOL_CLASS_META_KEY}"] is not an array — treated as unclassed`);
    return undefined;
  }
  const out: ToolClass[] = [];
  for (const value of raw) {
    if (isToolClass(value)) {
      if (!out.includes(value)) out.push(value);
    } else {
      console.error(`[mcpl] ${toolName}: unknown tool class ${JSON.stringify(value)} ignored (RFC-008 §3)`);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate a pattern → classes table from configuration. Unknown class
 * strings are dropped with a diagnostic; an entry left with no class is
 * dropped entirely (it cannot classify anything).
 */
export function normalizeClassTable(
  table: Record<string, readonly string[]> | undefined,
  label: string,
): Array<[string, ToolClass[]]> {
  if (!table) return [];
  const out: Array<[string, ToolClass[]]> = [];
  for (const [pattern, classes] of Object.entries(table)) {
    const known: ToolClass[] = [];
    for (const c of Array.isArray(classes) ? classes : []) {
      if (isToolClass(c)) {
        if (!known.includes(c)) known.push(c);
      } else {
        console.error(`[mcpl] ${label}["${pattern}"]: unknown tool class ${JSON.stringify(c)} ignored`);
      }
    }
    if (known.length > 0) out.push([pattern, known]);
  }
  return out;
}

export type ToolClassSource = 'override' | 'host' | 'server' | 'none';

export interface EffectiveToolClass {
  /** Empty for an unclassed tool. */
  classes: ToolClass[];
  source: ToolClassSource;
}

/**
 * Compute a tool's effective class (RFC-008 §5.1). `overrides` and `host`
 * are ordered pattern tables (first matching pattern wins within a source);
 * the first SOURCE that yields a class wins entirely — sources never merge,
 * so an override can tighten or correct a server's declaration.
 */
export function resolveToolClass(
  toolName: string,
  declared: readonly ToolClass[] | undefined,
  tables: {
    overrides: ReadonlyArray<readonly [string, readonly ToolClass[]]>;
    host: ReadonlyArray<readonly [string, readonly ToolClass[]]>;
  },
): EffectiveToolClass {
  for (const [pattern, classes] of tables.overrides) {
    if (globMatch(pattern, toolName)) return { classes: [...classes], source: 'override' };
  }
  for (const [pattern, classes] of tables.host) {
    if (globMatch(pattern, toolName)) return { classes: [...classes], source: 'host' };
  }
  if (declared && declared.length > 0) return { classes: [...declared], source: 'server' };
  return { classes: [], source: 'none' };
}
