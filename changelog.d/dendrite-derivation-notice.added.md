- A derived agent's source is told of it (#270, for Linn): by default every
  derivation puts one host-framed `[Agent lifecycle: … was derived from you as a …]`
  line in the context of the agent it was made from — the fork's name and
  kind, whose weights run it, what it inherits, where its result goes and
  what ends it; a resumption says so. Stamped `kind: 'agent-lifecycle'`
  with the record's fields under `dendrite`. No wake; a host's
  `dendrite.derivationNotice` can replace the line or send none. The fork
  never inherits the notice about itself; an ended source is told nothing.
  After `dendrite.collapseDerivationNoticesAfter` derivations of one kind
  from one agent (default 10; 0 never collapses), the source hears a count
  line every so many instead, with the latest described and
  `dendrite.collapsed: { count, sinceLastNote }`; every derivation still
  emits its `dendrite:agent-created` trace.
