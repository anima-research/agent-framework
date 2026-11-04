import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';

type Method = 'stat' | 'read' | 'readFile';
type Fn = (...args: any[]) => Promise<any>;

/**
 * Run `fn` with FileHandle's methods replaced, for every handle, by what each
 * hook makes of the original (which it calls with `original.apply(this, args)`).
 */
export async function withFileHandle<T>(hooks: Partial<Record<Method, (original: Fn) => Fn>>, fn: () => Promise<T>): Promise<T> {
  const probe = await open(process.execPath, 'r');
  const proto = Object.getPrototypeOf(probe) as Record<Method, Fn>;
  await probe.close();
  const originals = new Map<Method, Fn>();
  for (const [method, make] of Object.entries(hooks) as Array<[Method, (original: Fn) => Fn]>) {
    originals.set(method, proto[method]);
    proto[method] = make(proto[method]);
  }
  try {
    return await fn();
  } finally {
    for (const [method, original] of originals) proto[method] = original;
  }
}

/** Run `fn`, counting the bytes that every FileHandle read and readFile loads meanwhile. */
export async function countingLoads<T>(fn: () => Promise<T>): Promise<{ result: T; loaded: number }> {
  let loaded = 0;
  const result = await withFileHandle({
    read: (read) => async function (this: unknown, ...args: unknown[]) {
      const done = await read.apply(this, args);
      loaded += done.bytesRead;
      return done;
    },
    readFile: (readFile) => async function (this: unknown, ...args: unknown[]) {
      const bytes = await readFile.apply(this, args);
      loaded += bytes.length;
      return bytes;
    },
  }, fn);
  return { result, loaded };
}

/**
 * Run `fn` with `change` made once, right after a FileHandle stat of the file
 * at `path` returns: in a read, just after its open has stat'd the file, so
 * the read then finds something other than that stat said.
 */
export async function changedAfterFstat<T>(path: string, change: () => void, fn: () => Promise<T>): Promise<T> {
  const ino = String(statSync(path, { bigint: true }).ino);
  let changed = false;
  return withFileHandle({
    stat: (stat) => async function (this: unknown, ...args: unknown[]) {
      const result = await stat.apply(this, args);
      if (!changed && String(result.ino) === ino) {
        changed = true;
        change();
      }
      return result;
    },
  }, fn);
}
