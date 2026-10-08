/**
 * Zero-match diagnostics for operator tool-name patterns.
 *
 * `toolClassOverrides` keys and `toolLifecycle.{observe,inputs}.tools` are
 * RFC-007 §6.2 patterns over the MODEL-FACING tool name. For an MCPL tool
 * that is `<toolPrefix>--<tool>`, and `toolPrefix` defaults to
 * `mcpl--<serverId>`. A pattern written against the bare server id
 * (`search--*` for server `search` with no toolPrefix) is valid config that
 * matches nothing, and nothing else reports it: the override classes no tool
 * and the narrowing admits no call. This module decides, for one pattern and
 * the current tool listing, whether that is the case and what was probably
 * meant.
 */

import { globMatch } from './tool-glob.js';

export interface PatternServer {
  id: string;
  /** Effective tool prefix: config `toolPrefix ?? mcpl--<id>`. */
  prefix: string;
  /** True when this server's tools are in the current listing. */
  listed: boolean;
}

export type ToolPatternVerdict =
  | { kind: 'matched' }
  /** Could still match tools of servers whose listing is not in (yet). */
  | { kind: 'pending'; servers: string[] }
  | { kind: 'unmatched'; suggestion?: string; hint: string };

/**
 * Could `pattern` match some name under `<prefix>--`? Decided on the literal
 * text before the first `*`; anything after it is not consulted, so this
 * errs toward "could" (which only defers a warning, never invents one).
 */
export function couldMatchUnderPrefix(pattern: string, prefix: string): boolean {
  const head = `${prefix}--`;
  const star = pattern.indexOf('*');
  if (star === -1) return pattern.startsWith(head);
  const literal = pattern.slice(0, star);
  return literal.startsWith(head) || head.startsWith(literal);
}

/**
 * Check one pattern against the model-facing tool names offered right now.
 *
 * `pending` while a server whose tools the pattern could name has not
 * listed them (not connected yet, reconnecting, or removed): its listing is
 * the only evidence, and an early verdict would be a false alarm.
 */
export function checkToolPattern(
  pattern: string,
  toolNames: Iterable<string>,
  servers: readonly PatternServer[],
): ToolPatternVerdict {
  const names = [...toolNames];
  for (const name of names) {
    if (globMatch(pattern, name)) return { kind: 'matched' };
  }
  const pending = servers.filter((s) => !s.listed && couldMatchUnderPrefix(pattern, s.prefix));
  if (pending.length > 0) return { kind: 'pending', servers: [...new Set(pending.map((s) => s.id))] };

  // Written against the wrong namespace for a known server: the bare id
  // (`<id>--…`) where the effective prefix differs, or the default form
  // (`mcpl--<id>--…`) for a server that set its own toolPrefix. Never when
  // the namespace as written is real — another server's toolPrefix or a
  // module's tools — since the pattern then names that, not a mistake.
  const inRealNamespace = (ns: string) =>
    servers.some((o) => o.prefix === ns) || names.some((n) => n.startsWith(`${ns}--`));
  for (const s of servers) {
    let rest: string | undefined;
    if (s.prefix !== s.id && pattern.startsWith(`${s.id}--`) && !inRealNamespace(s.id)) {
      rest = pattern.slice(s.id.length + 2);
    } else if (
      s.prefix !== `mcpl--${s.id}` && pattern.startsWith(`mcpl--${s.id}--`) && !inRealNamespace(`mcpl--${s.id}`)
    ) {
      rest = pattern.slice(s.id.length + 8);
    }
    if (rest === undefined) continue;
    const why = s.prefix === `mcpl--${s.id}` ? ' (no toolPrefix set; the default is "mcpl--<serverId>")' : '';
    return {
      kind: 'unmatched',
      suggestion: `${s.prefix}--${rest}`,
      hint: `server "${s.id}" names its tools "${s.prefix}--<tool>"${why}`,
    };
  }

  if (pattern.includes('--') && !servers.some((s) => couldMatchUnderPrefix(pattern, s.prefix))) {
    return { kind: 'unmatched', hint: 'no connected MCPL server has a toolPrefix it could match' };
  }
  return { kind: 'unmatched', hint: 'no tool the framework offers has a matching name' };
}

/** The operator-facing line for an `unmatched` verdict. */
export function describeUnmatchedPattern(
  where: string,
  pattern: string,
  verdict: Extract<ToolPatternVerdict, { kind: 'unmatched' }>,
): string {
  const meant = verdict.suggestion ? ` — did you mean ${JSON.stringify(verdict.suggestion)}?` : '';
  return (
    `[mcpl] ${where} pattern ${JSON.stringify(pattern)} matches no tool${meant} ` +
    `(${verdict.hint}). Patterns match the full model-facing tool name, ` +
    `"<toolPrefix>--<tool>" for MCPL tools.`
  );
}
