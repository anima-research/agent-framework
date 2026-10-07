- **Delivered-body digests on every inbound item.** Both MCPL lanes stamp two
  fields at ingestion, outside the frozen source envelope:
  - `metadata.sourceBodyDigest` is the version identity of the body as
    delivered, taken after MCPL conversion and before any host decoration or
    storage sharding. It is SHA-256 of `canonicalJson([blocks])`, the framing
    an undecorated, unsharded stored copy already hashes to.
  - `metadata.storedBodyDigest` uses the same function over exactly the
    blocks handed to storage, decorations included.

  A copy that no longer hashes to its `storedBodyDigest` was changed after it
  arrived (`editMessage` keeps metadata). `canonicalJson` and
  `sourceBodyDigest` are exported from `mcpl/inbound-source.ts` as the one
  implementation consumers share.
