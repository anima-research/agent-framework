/**
 * Module hooks that stand context-manager 0.24.0 in for the installed one
 * (presentation-mandatory.test.ts, #88): every module that imports
 * '@animalabs/context-manager' is given every export of the installed
 * release but those 0.25.0 added (ADDED_IN_0_25), and a ContextManager
 * whose prototype has no presentRows, as 0.24.0's has none: it keeps no
 * window index. Registered by context-manager-0.24-register.ts, which a
 * child process takes with `--import`.
 */

/** The value exports context-manager 0.25.0 added, which 0.24.0 hasn't got. */
export const ADDED_IN_0_25 = ['WriteLandedError', 'WriteOutcomeUnknownError', 'WindowWriteOutcomeUnknownError', 'windowIndexStateId'];

const STAND_IN = 'af-test:context-manager@0.24.0';
let installed: string | undefined;

interface Resolved { url: string; shortCircuit?: boolean }
interface Loaded { format: string; source?: string; shortCircuit?: boolean }

export async function resolve(
  specifier: string,
  context: { parentURL?: string },
  next: (specifier: string, context: { parentURL?: string }) => Promise<Resolved>,
): Promise<Resolved> {
  if (specifier !== '@animalabs/context-manager' || context.parentURL === STAND_IN) return next(specifier, context);
  installed ??= (await next(specifier, context)).url;
  return { url: STAND_IN, shortCircuit: true };
}

export async function load(url: string, context: object, next: (url: string, context: object) => Promise<Loaded>): Promise<Loaded> {
  if (url !== STAND_IN) return next(url, context);
  const real = await import(installed!) as Record<string, unknown>;
  const kept = Object.keys(real).filter((name) => name !== 'default' && name !== 'ContextManager' && !ADDED_IN_0_25.includes(name));
  const source = [
    `import * as real from ${JSON.stringify(installed)};`,
    ...kept.map((name) => `export const ${name} = real.${name};`),
    'export class ContextManager extends real.ContextManager {}',
    "Object.defineProperty(ContextManager.prototype, 'presentRows', { value: undefined });",
  ].join('\n');
  return { format: 'module', source, shortCircuit: true };
}
