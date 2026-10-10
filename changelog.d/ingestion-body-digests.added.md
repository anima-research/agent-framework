- **Delivered-body digests on every stored inbound item.** Both MCPL lanes
  stamp two fields, outside the frozen source envelope:
  - `metadata.sourceBodyDigest` is the version identity of the body as
    delivered, taken at ingestion, after MCPL conversion and before any host
    decoration or storage sharding. It is the SHA-256 (hex) of `[blocks]`
    as canonical JSON (keys sorted at every level, `undefined` dropped), with
    the blocks as the store keeps them: inline media as the store hands it
    back (base64 re-encoded from its bytes, an image's media type taken from
    its bytes' signature, only `type` and `source` kept) and strings
    well-formed (a lone surrogate as U+FFFD). So the body hashes alike as
    delivered, as handed to storage and as read back, and an undecorated,
    unsharded stored copy hashes to it.
  - `metadata.storedBodyDigest` uses the same function over exactly the
    blocks handed to storage, decorations included, taken where each path
    stores.

  Both are always the host's own: values an adapter supplies are replaced.
  A stored copy, read back with its blobs resolved, that no longer hashes to
  its `storedBodyDigest` was changed after it arrived (`editMessage` keeps
  metadata). `sourceBodyDigest(blocks)` is exported from the package root as
  the one implementation consumers share; it carries the framing and the
  store's normalization, so check a copy with it rather than hashing your own
  serialization.
