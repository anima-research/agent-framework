- A channel message is stored as the model reads it: `author: body`. MCPL's
  `channels/incoming` carries the author as a field and the body alone as
  content; the framework stored the body under the anonymous participant
  `user` with the author in metadata, and nothing between the store and the
  wire wrote the name, so a spec-shaped server's message reached the model
  as `user: <text>` with the author nowhere (Weft's rig, 2026-10-13). A
  server that renders `Name: body` into the text itself (portal-mcpl) is
  left as it is: the rule is idempotent, so the name appears once whichever
  shape a server sends. The author stays in `metadata.author` as the
  structured record. Exported as `presentAuthor` / `authorLine`.
- A tune-out release line and the reader fork's backlog name an author
  once. Both read `metadata.author`, so a message whose text a server had
  already prefixed was shown as `Name: Name: body`.
