import type { ToolDefinition } from './types/index.js';

/** A run of 16 or more digits, which membrane's XML parser passes as text for
 *  a number or integer parameter: some such runs would lose precision as a
 *  JavaScript number, so membrane keeps every one as text, and so does this
 *  check. */
const LARGE_INTEGER_TEXT = /^\d{16,}$/;

/** The JSON kind of a value, as a schema's `type` names it. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** A kind with its article, for a sentence. */
function withArticle(kind: string): string {
  if (kind === 'null') return 'null';
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

/** The types JSON Schema names. A `type` naming anything else, such as
 *  `any`, is one the check can't read. */
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/** The kinds a declaration's type admits, each once, or none when it declares
 *  none it can read. A type list naming anything JSON Schema doesn't have is
 *  one it can't read as a whole, as membrane reads it, rather than the names
 *  in it that it knows. OpenAPI's `nullable: true`, the form Gemini's dialect
 *  uses, admits `null` beside its type, as a type list naming `null` does. */
function admittedKinds(param: { type?: unknown; nullable?: unknown } | undefined): string[] {
  const type = param?.type;
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  if (!types.every((t) => typeof t === 'string' && JSON_TYPES.has(t))) return [];
  const kinds = new Set((types as string[]).map((t) => (t === 'integer' ? 'number' : t)));
  if (kinds.size > 0 && param?.nullable === true) kinds.add('null');
  return [...kinds];
}

/** Whether `null` is a value for a key so declared: where the declaration
 *  admits it (a type list naming it, or `nullable: true`), or declares no
 *  type at all. A type the check can't read says nothing about `null`, so
 *  there `null` is no value unless the declaration names it. */
function takesNull(param: { type?: unknown; nullable?: unknown } | undefined): boolean {
  const type = param?.type;
  if (type === undefined || param?.nullable === true) return true;
  return Array.isArray(type) ? type.includes('null') : type === 'null';
}

/** A value as the call gave it, briefly: the first 80 characters of its JSON
 *  text, then an ellipsis when there are more, cut between characters rather
 *  than inside one. The whole value is serialized before the cut. */
function shown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '(a value that could not be shown)';
  }
  let head = '';
  let count = 0;
  for (const char of text) {
    if (count === 80) return `${head}…`;
    head += char;
    count++;
  }
  return head;
}

function notAnObject(input: unknown, field = 'input'): string {
  return `its ${field} must be an object, and this call gave ${withArticle(kindOf(input))}`;
}

export function markedInputRefusal(call: { name: string; unparseableInput?: string }): string | undefined {
  const text = call.unparseableInput;
  if (text === undefined) return undefined;
  // membrane marks `''` when a stream ended before the call's block did, and
  // an object's JSON when the stream broke the API's block order, so the
  // arguments may be another call's (ToolUseContent.unparseableInput).
  if (text === '') return `Nothing was done: ${call.name} its arguments were cut off before any arrived; call it again with them whole.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `Nothing was done: ${call.name} its arguments must be one JSON object, and this call gave text that isn't JSON: ${shown(text)}.`;
  }
  if (parsed === null) return undefined;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return `Nothing was done: ${call.name} ${notAnObject(parsed)}.`;
  return `Nothing was done: ${call.name} its arguments came in a response whose parts arrived out of order, so they may not be this call's; call it again.`;
}

/** A list in prose: `a`, `a or b`, `a, b or c`. */
function oneOf(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** A list in prose: `a`, `a and b`, `a, b and c`. */
function allOf(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** At most this many keys a call gave that its schema doesn't declare are named. */
const UNDECLARED_SHOWN = 5;

/** An own property, so a key such as `constructor` isn't found on the prototype. */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** An object that isn't a list: a map of keys, as `properties` should be. */
function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every root keyword in JSON Schema's drafts 4 to 2020-12, besides
 *  `properties` and `required`, that can accept, require or name an object's
 *  keys, except the two read by declaresKeysPlainly (`additionalProperties`
 *  and `unevaluatedProperties`, which count when `true` or a schema object). The
 *  reading is cautious: a root with any of them names no key, whatever its
 *  subschemas hold, since naming a key the schema takes would mislead the
 *  agent more than a hint left out. So `not` is here too, since a negation
 *  can require a key (`not: {properties: {y: {type: 'string'}}}` refuses an
 *  object without a non-string `y`), and so is `if` with or without `then`
 *  and `else`. `then` and `else` act only beside `if`, and a keyword JSON
 *  Schema doesn't have declares nothing. */
const OTHER_KEY_DECLARERS = [
  'allOf', 'anyOf', 'oneOf', 'not', 'if', '$ref', '$dynamicRef', '$recursiveRef',
  'dependentSchemas', 'dependencies', 'dependentRequired', 'patternProperties',
  'propertyNames', 'enum', 'const',
];

/** Whether a schema's root declares its keys only in `properties` and
 *  `required`, so that a key in neither isn't one of its parameters. A root
 *  with any keyword in OTHER_KEY_DECLARERS can declare keys another way. A
 *  schema object for `additionalProperties` or `unevaluatedProperties`, `{}`
 *  included, or `true`, which means the same there, says the root takes keys
 *  `properties` doesn't list, as a map's input does, so a key in neither list
 *  may be meant. `false` there says it takes none, so it names. Left out,
 *  the keyword is JSON Schema's default, which says nothing of what the
 *  author meant, and most schemas leave it out without welcoming other keys,
 *  so a root without it names them too. */
function declaresKeysPlainly(schema: Record<string, unknown>): boolean {
  return !OTHER_KEY_DECLARERS.some((key) => Object.hasOwn(schema, key))
    && !takesOtherKeys(schema.additionalProperties)
    && !takesOtherKeys(schema.unevaluatedProperties);
}

function takesOtherKeys(value: unknown): boolean {
  return value === true || isMap(value);
}

/**
 * What's wrong with a call's input against its tool's declared inputSchema,
 * checked shallowly: the input is an object, and each root `required` key has
 * a value. With `values`, also each declared key's value: a type and an enum
 * value its declaration admits. It isn't a JSON-Schema engine: nested shapes,
 * unions and references are the handler's to check, as they always were.
 * Every problem is reported at once, each naming the key, what the schema
 * wants and what the call gave. An empty list means the call can go to its
 * handler.
 *
 * - An absent input (`undefined` or `null`) gives no arguments: it's refused
 *   only for the keys the schema requires.
 * - A required key given as `null` has no value, the same as one left out,
 *   unless its declaration admits `null` (a type list naming it, or
 *   `nullable: true`), or has no `type` at all: a key with no `type` takes
 *   `null` as a value, as it takes any other. One whose `type` the check
 *   can't read, such as Gemini's `STRING`, or a list naming one, takes
 *   `null` only where the declaration names it, and its values aren't
 *   checked against the type. An empty string is a value.
 * - A schema whose `required` isn't a list requires nothing here, and a key
 *   it lists twice is reported once.
 * - Where a required key is missing and the call gave keys the schema
 *   declares neither in its `properties` nor in its `required` list, those
 *   are named too, since a key sent under another name is one reason a
 *   required key goes missing. They're never refused for themselves. A schema
 *   whose root can declare keys another way names none
 *   (declaresKeysPlainly).
 *
 * A module tool's call is checked without `values`: a handler may take more
 * than its schema can say on every provider, such as one name where a list
 * is declared, and refusing that would refuse calls that work. The `utils`
 * tool checks a utility's values too, as it always has. `field` names what
 * the input is to the caller ("input" unless given).
 */
export function toolArgsProblems(
  input: unknown,
  schema: ToolDefinition['inputSchema'] | undefined,
  options: { values?: boolean; field?: string } = {},
): string[] {
  if (!schema) return [];
  const absent = input === undefined || input === null;
  if (!absent && (typeof input !== 'object' || Array.isArray(input))) {
    return [notAnObject(input, options.field)];
  }
  const obj = (absent ? {} : input) as Record<string, unknown>;
  const properties = (isMap(schema.properties) ? schema.properties : {}) as Record<string, { type?: unknown; nullable?: unknown; enum?: unknown } | undefined>;
  const declared = (key: string) => (Object.hasOwn(properties, key) ? properties[key] : undefined);
  const problems: string[] = [];
  const missing = new Set<string>();
  const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== 'string' || missing.has(key)) continue;
    const value = own(obj, key);
    const kinds = admittedKinds(declared(key));
    if (value !== undefined && (value !== null || takesNull(declared(key)))) continue;
    missing.add(key);
    const wanted = kinds.length > 0 ? `"${key}" (${oneOf(kinds.map(withArticle))})` : `"${key}"`;
    problems.push(`needs ${wanted}, and this call gave ${value === null ? 'null' : 'none'}`);
  }
  if (missing.size > 0 && declaresKeysPlainly(schema as Record<string, unknown>)) {
    const undeclared = Object.keys(obj).filter((key) => !Object.hasOwn(properties, key) && !required.includes(key));
    if (undeclared.length > 0) {
      const named = undeclared.slice(0, UNDECLARED_SHOWN).map(shown);
      if (undeclared.length > UNDECLARED_SHOWN) named.push(`${undeclared.length - UNDECLARED_SHOWN} more`);
      problems.push(undeclared.length === 1 ? `${named[0]} isn't one of its parameters` : `${allOf(named)} aren't among its parameters`);
    }
  }
  if (!options.values) return problems;
  for (const [key, value] of Object.entries(obj)) {
    const param = declared(key);
    if (!param || value === undefined || missing.has(key)) continue;
    const kinds = admittedKinds(param);
    const kind = kindOf(value);
    const largeInteger = kind === 'string' && kinds.includes('number') && LARGE_INTEGER_TEXT.test(value as string);
    if (kinds.length > 0 && !kinds.includes(kind) && !largeInteger) {
      problems.push(`"${key}" must be ${oneOf(kinds.map(withArticle))}, and this call gave ${withArticle(kind)}`);
      continue;
    }
    if (Array.isArray(param.enum) && !param.enum.includes(value)) {
      problems.push(`"${key}" must be one of ${oneOf(param.enum.map(shown))}, and this call gave ${shown(value)}`);
    }
  }
  return problems;
}
