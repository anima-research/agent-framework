import { existsSync, readFileSync } from 'node:fs';

export function jsonLines<T = Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}
