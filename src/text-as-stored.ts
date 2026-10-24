/**
 * A request carries only text the context store would keep. Apart from the
 * agent's own configuration, such as its name and system prompt, what a
 * request compiles comes from the store, which writes a lone UTF-16
 * surrogate as U+FFFD, and a provider refuses a request carrying one (#695).
 * Two things reach a request without the store, and each is made well formed
 * where it leaves for it: context injections, as an Agent compiles them into
 * a request, and the copies a tool boundary injects into the live round, as
 * they go to the stream.
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { ContextInjection } from '@animalabs/context-manager';

/** A value with every string in it as the context store keeps it, through
 *  arrays and plain objects. Keys, and objects that aren't plain, pass as
 *  they are: content blocks are plain JSON data. Whatever is already well
 *  formed keeps its identity. */
function stringsAsStored<T>(value: T): T {
  if (typeof value === 'string') return (value.isWellFormed() ? value : value.toWellFormed()) as T;
  if (Array.isArray(value)) {
    const out = value.map(stringsAsStored);
    return (out.every((v, i) => v === value[i]) ? value : out) as T;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const s = stringsAsStored(v);
      if (s !== v) changed = true;
      out[k] = s;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

/** Content with every string in it well formed, as the context store keeps
 *  a text block's text or an image's link. */
export function contentAsStored(content: ContentBlock[]): ContentBlock[] {
  return stringsAsStored(content);
}

/** A sender's name as the context store keeps it, and as a tool boundary
 *  sends it: a lone UTF-16 surrogate becomes U+FFFD. A name that isn't a
 *  string, from an untyped module, passes as it did: thrown here, inside the
 *  boundary, it would keep the round's results from the stream, where it
 *  would otherwise fail at the next compile. */
export function nameAsStored(participant: string): string {
  return typeof participant === 'string' ? participant.toWellFormed() : participant;
}

/** Injections with their text as the context store would keep it: each one's
 *  content, and its namespace, which context-manager writes into a beforeUser
 *  or afterUser injection's participant name by its text form. A namespace
 *  that isn't a string, which MCPL §10.4 doesn't allow but the hook
 *  orchestrator keeps when it can be read as text, is taken by that form.
 *  They're scoped to a conversation before this, by the namespace as given,
 *  since channel ids are compared as given. One that's already well formed
 *  keeps its identity. */
export function injectionsAsStored(injections: ContextInjection[] | undefined): ContextInjection[] | undefined {
  return injections?.map((inj) => {
    const ns: unknown = inj.namespace;
    const named = typeof ns === 'string' || ns === undefined || ns === null ? ns : String(ns);
    const namespace = typeof named === 'string' && !named.isWellFormed() ? named.toWellFormed() : ns;
    const content = contentAsStored(inj.content);
    return namespace === ns && content.every((b, i) => b === inj.content[i])
      ? inj
      : { ...inj, namespace: namespace as string, content };
  });
}
