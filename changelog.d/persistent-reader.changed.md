- **Hosts with a `dendrite.derivationNotice`: resumptions count toward `collapseDerivationNoticesAfter`.** Every
  resumption was told to the source with a line of its own. Now each incarnation from a source is tallied with its
  kind's derivations, so past the threshold a resumption, like a derivation, is told in the count line every so many.
  The first `collapseDerivationNoticesAfter` incarnations of a kind are still told one by one. A count line that
  includes resumptions says how many (`… has been derived from you, and resumed 3 times, since …`), and its
  `dendrite.collapsed` carries `resumed`; one with none reads as before.
- A shared derivation resumed with `resumeAgent` on its source's `allowedTools`, while the source is registered, shows
  the source's tool presentation again, as its derivation did, so its tool block is the source's. Before, a resumed
  fork of a resident with a `toolPresentation` was shown its own tool block.
- `derivationNotice`'s default line for a persisted reader says what it reads: `reading your context up to the point
  it was derived, and handed what entered your context after it at each look` at a resumption. Every other record's
  line reads as before.
