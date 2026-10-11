- **Delivered-body digests on every stored MCPL inbound item.** Both MCPL
  lanes stamp two fields, outside the frozen source envelope (console and API
  input, and the host's own notices, carry neither):
  - `metadata.sourceBodyDigest` is the version identity of the body as
    delivered, taken at ingestion, after MCPL conversion and before any host
    decoration or storage sharding. It is the SHA-256 (hex) of `[blocks]`
    as canonical JSON (keys sorted at every level, `undefined` object entries
    dropped and an `undefined` array element written as `null`, as JSON
    writes them), with the blocks as the store keeps them: inline media as
    the store hands it back (base64 re-encoded from its bytes, an image's
    media type taken from its bytes' signature, only `type` and `source`
    kept), strings well-formed (a lone surrogate as U+FFFD) and an entry
    whose key isn't well-formed dropped, as the store's append drops it. So
    the body hashes alike as delivered, as handed to storage and as read
    back, and an undecorated, unsharded stored copy hashes to it.
  - `metadata.storedBodyDigest` uses the same function over exactly the
    blocks handed to storage, decorations included, taken where each path
    stores.

  Both are always the host's own: values an adapter supplies are replaced.
  A stored copy, read back with its blobs resolved, that no longer hashes to
  its `storedBodyDigest` was changed after it arrived (`editMessage` keeps
  metadata). That check is of an unsharded copy: a body the store shards
  (context-manager's adaptive ingress chunking) carries the whole body's two
  digests on every shard (`bodyGroupId` and `shardIndex` mark them), and no
  shard hashes to them. A `blob_ref` block is digested as given, while the
  store resolves it on read, so a copy holding one doesn't match; the MCPL
  lanes never store one. `sourceBodyDigest(blocks)` is exported from the
  package root as the one implementation consumers share; it carries the
  framing and the store's normalization, so check a copy with it rather than
  hashing your own serialization.
