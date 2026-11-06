/**
 * Refusals shared by the configuration checks. A setting read by truthiness
 * turns on for a quoted "false", and a settings object such as `true`, which
 * isn't an object, has every setting in it read as left out. A JSON config,
 * or a `${VAR}` substituted as a string, can carry either where the type says
 * otherwise, so each refusal says what the value would have done. Each names
 * the setting and the value's kind, never the value, which could be a secret
 * pasted into the wrong field.
 */

/** The kind of a value, as a refusal names it in place of the value, which
 *  can be a credential. */
export function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value !== 'object') return `a ${typeof value}`;
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  if (prototype === null || prototype === Object.prototype) return 'an object';
  const name = prototype.constructor?.name;
  if (!name) return 'an object that isn\'t plain';
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/**
 * Refuse a boolean setting that holds anything but true or false. null counts
 * as not set, as leaving it out does, so a generated config that writes an
 * unset setting as null keeps working. `whatItDoes` ends the refusal: what
 * true does, and what false or leaving it out does.
 */
export function assertBooleanSetting(setting: string, value: unknown, whatItDoes: string): void {
  if (value === undefined || value === null || typeof value === 'boolean') return;
  const wanted = typeof value === 'string' ? 'true or false, unquoted,' : 'true or false,';
  throw new Error(`${setting} must be ${wanted} not ${kindOf(value)}: ${whatItDoes}`);
}

export function assertOneOfSetting(setting: string, value: unknown, allowed: readonly string[], whatItDoes: string): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && allowed.includes(value)) return;
  const shown = typeof value === 'string' ? 'another string' : kindOf(value);
  throw new Error(`${setting} must be ${allowed.map((v) => `'${v}'`).join(' or ')}, not ${shown}: ${whatItDoes}`);
}

/**
 * Whether a settings object holds settings to check: false when it's null,
 * false or left out, which count as not set. Each of those has every setting
 * in it read as left out, which is what null and false ask for. Anything else
 * that isn't an object, `true` and an array included, is refused, since every
 * setting in it would read as left out too, whatever it says.
 */
export function holdsSettings<T>(setting: string, value: T, example: string): value is NonNullable<T> {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${setting} must be an object, such as ${example}, not ${kindOf(value)}`);
  }
  return true;
}
