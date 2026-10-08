- **Delivered-body digests on every stored inbound item.** Both MCPL lanes
  stamp two fields, outside the frozen source envelope:
  - `metadata.sourceBodyDigest` is the version identity of the body as
    delivered, taken at ingestion, after MCPL conversion and before any host
    decoration or storage sharding. It is the SHA-256 (hex) of `[blocks]`
    as canonical JSON (keys sorted at every level, `undefined` dropped), the
    framing an undecorated, unsharded stored copy already hashes to.
  - `metadata.storedBodyDigest` uses the same function over exactly the
    blocks handed to storage, decorations included, taken where each path
    stores.

  Both are always the host's own: values an adapter supplies are replaced.
  A copy that no longer hashes to its `storedBodyDigest` was changed after it
  arrived (`editMessage` keeps metadata). `sourceBodyDigest(blocks)` is
  exported from the package root as the one implementation consumers share;
  it carries the framing, so check a copy with it rather than hashing your
  own serialization.
