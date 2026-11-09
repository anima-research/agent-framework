/**
 * context-manager's write-outcome errors, read so that this package still
 * loads on a context-manager that has neither.
 *
 * WriteLandedError and WriteOutcomeUnknownError are 0.25.0's: 0.24.0 has
 * neither. This package is ESM, and a named import of a name its module
 * doesn't export is a SyntaxError when the module graph is linked, so a
 * named import of either would fail the package's load on 0.24.0 before
 * create() could say which context-manager it needs (it refuses one
 * without a window index, naming ^0.25.0). A namespace import reads an
 * absent name as undefined, and a stand-in takes its place: a class
 * nothing throws, so an `instanceof` against it is false, as it is for
 * every error that release throws.
 *
 * Import these two from here, not from '@animalabs/context-manager'
 * (test/presentation-mandatory.test.ts scans for that).
 */
import * as contextManager from '@animalabs/context-manager';

type Exports = typeof contextManager;
const exported: Partial<Pick<Exports, 'WriteLandedError' | 'WriteOutcomeUnknownError'>> = contextManager;

/** A stand-in for a class the installed context-manager lacks. */
function absent<C>(name: string): C {
  return class extends Error {
    constructor() {
      super(`${name} isn't in the installed @animalabs/context-manager`);
      this.name = name;
    }
  } as unknown as C;
}

export const WriteLandedError: Exports['WriteLandedError'] = exported.WriteLandedError ?? absent('WriteLandedError');
export type WriteLandedError = contextManager.WriteLandedError;
export const WriteOutcomeUnknownError: Exports['WriteOutcomeUnknownError'] =
  exported.WriteOutcomeUnknownError ?? absent('WriteOutcomeUnknownError');
export type WriteOutcomeUnknownError = contextManager.WriteOutcomeUnknownError;
