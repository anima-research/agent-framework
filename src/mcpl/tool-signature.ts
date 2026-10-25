/**
 * How a dynamic tool reads to a model when it reaches the conversation
 * instead of the tool list (MCPL RFC-014 §8.3): a compact signature, its
 * first sentence the first time a definition is shown, the whole definition
 * on request. Also the host's own argument check against a tool's current
 * definition (RFC-014 §6.1: "the host checks arguments for that instance
 * against it").
 *
 * Ported from mcpl-cc-bridge's tool-render.ts and schema-check.ts, the
 * reference host of RFC-014. Dependency-free.
 */
import { createHash } from 'node:crypto';

export type JsonSchema = Record<string, unknown>;

/** A tool definition as a server lists it (MCP), with its `_meta` hints. */
export interface HintedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeSig(schema: JsonSchema | undefined, depth = 0): string {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) {
    // The enum is often the menu (a decision's options): all of it unless it is long.
    const vals = (schema.enum as unknown[]).map((v) => JSON.stringify(v));
    if (vals.length <= 8 || vals.join('|').length <= 400) return vals.join('|');
    let shown = 0;
    let len = 0;
    while (shown < vals.length && len + vals[shown]!.length < 300) {
      len += vals[shown]!.length + 1;
      shown++;
    }
    return `${vals.slice(0, Math.max(shown, 4)).join('|')}|…(${vals.length} in all)`;
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const alts = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined;
  if (Array.isArray(alts)) return alts.map((s) => typeSig(s, depth + 1)).join(' | ');
  const t = Array.isArray(schema.type) ? (schema.type as string[]).join('|') : (schema.type as string | undefined);
  switch (t) {
    case 'integer':
    case 'number': {
      const base = t === 'integer' ? 'int' : 'number';
      const lo = typeof schema.minimum === 'number' ? schema.minimum : undefined;
      const hi = typeof schema.maximum === 'number' ? schema.maximum : undefined;
      if (lo !== undefined && hi !== undefined) return `${base} ${lo}..${hi}`;
      if (lo !== undefined) return `${base} ≥${lo}`;
      if (hi !== undefined) return `${base} ≤${hi}`;
      return base;
    }
    case 'array': {
      const inner = typeSig(schema.items as JsonSchema | undefined, depth + 1);
      const wrapped = /[ |]/.test(inner) && !inner.startsWith('{') ? `(${inner})` : inner;
      const max = typeof schema.maxItems === 'number' ? `≤${schema.maxItems}` : '';
      return `${wrapped}[${max}]`;
    }
    case 'object': {
      const props = schema.properties as Record<string, JsonSchema> | undefined;
      if (!isObj(props) || Object.keys(props).length === 0) return 'object';
      if (depth >= 3) return '{…}';
      const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      return `{${Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${typeSig(v, depth + 1)}`).join(', ')}}`;
    }
    case undefined:
      return 'any';
    default:
      return t;
  }
}

const schemaOf = (tool: HintedTool): JsonSchema => (isObj(tool.inputSchema) ? tool.inputSchema : {});

/** `play(point: string)`, `move(forward?: int -10..10 =0, turn?: int)` */
export function signature(tool: HintedTool): string {
  const s = schemaOf(tool);
  const props = (isObj(s.properties) ? s.properties : {}) as Record<string, JsonSchema>;
  const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const params = Object.entries(props).map(([k, v]) => {
    const def = isObj(v) && v.default !== undefined ? ` =${JSON.stringify(v.default)}` : '';
    return `${k}${req.has(k) ? '' : '?'}: ${typeSig(v, 1)}${def}`;
  });
  return `${tool.name}(${params.join(', ')})`;
}

/** An options schema as `{size?: 9|13|19 =9, …}` (a toolset's options). */
export function objectSignature(schema: unknown): string {
  const inner = signature({ name: '', inputSchema: schema }).slice(1, -1);
  return inner ? `{${inner}}` : '{}';
}

/** First sentence of a description, bounded. */
export function firstSentence(text: string | undefined, max = 140): string {
  const t = (text ?? '').trim().replace(/\s+/g, ' ');
  // A sentence ends at . ! ? followed by a capital, a bracket, or the end, so "e.g. \"D4\"" does not end it.
  const m = t.match(/^(.+?[.!?])(?=\s+[A-Z([]|$)/);
  const s = m ? m[1]! : t;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** Identity of a definition as the model reads it (name, description, schema). */
export function toolDigest(tool: HintedTool): string {
  return createHash('sha256')
    .update(canonicalJson({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? null }))
    .digest('base64url')
    .slice(0, 22);
}

/**
 * Tool lines as the model reads them. A definition the model has been shown
 * gets its signature only; a new or changed one also gets its first
 * sentence. `shown` is updated.
 */
export function renderToolLines(tools: HintedTool[], shown: Set<string>, opts: { describeAll?: boolean; indent?: string } = {}): string[] {
  const indent = opts.indent ?? '  ';
  return tools.map((t) => {
    const d = toolDigest(t);
    const describe = opts.describeAll || !shown.has(d);
    shown.add(d);
    const sentence = describe ? firstSentence(t.description) : '';
    return `${indent}${signature(t)}${sentence ? ` — ${sentence}` : ''}`;
  });
}

/** The whole definition, for `look` naming a tool. */
export function renderToolDefinition(tool: HintedTool): string {
  const cls = tool._meta?.['mcpl/class'];
  return [
    signature(tool),
    tool.description ?? '',
    ...(Array.isArray(cls) ? [`class: ${cls.join(', ')}`] : []),
    'inputSchema:',
    JSON.stringify(tool.inputSchema ?? {}, null, 2),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// ── Argument checks ──────────────────────────────────────────────────────────
//
// A deliberate subset of JSON Schema: type, enum, const, required, properties,
// additionalProperties, items, min/maxItems, minimum, maximum,
// exclusiveMinimum/Maximum, min/maxLength, pattern, anyOf, oneOf, allOf.
// Anything else isn't checked, so the check can only fail to refuse what the
// server would refuse on those keywords, never refuse what it would accept.

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case 'object':
      return isObj(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return true;
  }
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** The first problem with `value` against `schema`, as a short phrase naming where; null when it fits. */
export function checkArgs(schema: unknown, value: unknown, at = 'args'): string | null {
  if (!isObj(schema)) return null;
  const s = schema;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeOk(t, value))) return `${at}: must be ${types.join(' or ')}`;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, value))) return `${at}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join('|')}`;
  if (s.const !== undefined && !same(s.const, value)) return `${at}: must be ${JSON.stringify(s.const)}`;
  if (typeof value === 'string') {
    const n = [...value].length;
    if (typeof s.minLength === 'number' && n < s.minLength) return `${at}: at least ${s.minLength} characters`;
    if (typeof s.maxLength === 'number' && n > s.maxLength) return `${at}: at most ${s.maxLength} characters`;
    if (typeof s.pattern === 'string') {
      let re: RegExp | null = null;
      try { re = new RegExp(s.pattern, 'u'); } catch { /* a pattern this runtime can't compile isn't checked */ }
      if (re && !re.test(value)) return `${at}: does not match ${s.pattern}`;
    }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return `${at}: at least ${s.minimum}`;
    if (typeof s.maximum === 'number' && value > s.maximum) return `${at}: at most ${s.maximum}`;
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) return `${at}: more than ${s.exclusiveMinimum}`;
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) return `${at}: less than ${s.exclusiveMaximum}`;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return `${at}: at least ${s.minItems} items`;
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return `${at}: at most ${s.maxItems} items`;
    if (isObj(s.items)) {
      for (let i = 0; i < value.length; i++) {
        const e = checkArgs(s.items, value[i], `${at}[${i}]`);
        if (e) return e;
      }
    }
  }
  if (isObj(value)) {
    const props = isObj(s.properties) ? s.properties : {};
    for (const r of Array.isArray(s.required) ? (s.required as unknown[]) : []) {
      if (typeof r === 'string' && !Object.hasOwn(value, r)) return `${at}.${r}: required`;
    }
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) {
        const e = checkArgs(props[k], v, `${at}.${k}`);
        if (e) return e;
      } else if (s.additionalProperties === false) {
        return `${at}.${k}: not an argument of this tool`;
      } else if (isObj(s.additionalProperties)) {
        const e = checkArgs(s.additionalProperties, v, `${at}.${k}`);
        if (e) return e;
      }
    }
  }
  for (const k of ['anyOf', 'oneOf'] as const) {
    const alts = s[k];
    if (Array.isArray(alts) && alts.length && !alts.some((a) => checkArgs(a, value, at) === null)) {
      return checkArgs(alts[0], value, at) ?? `${at}: fits none of the allowed forms`;
    }
  }
  if (Array.isArray(s.allOf)) {
    for (const a of s.allOf) {
      const e = checkArgs(a, value, at);
      if (e) return e;
    }
  }
  return null;
}
