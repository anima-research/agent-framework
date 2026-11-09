- A reader fork's held traffic now keeps each message's blocks in the message's order. This applies to every host
  with reader forks (`subconscious.reader: 'forks'`) and the default framing (`defaultReaderFraming`, used when
  `subconscious.framing` isn't set), on every `persist` mode, the default `'look'` included. A message's text up to
  a non-text block (an image, a document) is its `author: text` line. The block comes next, and the text after it is
  a line of its own, with no author. A message that opens with a non-text block has `author: ` before it. Before, all
  of a message's text was its one `author:` line and all its non-text blocks came after that line. So text A, an
  image and text B read as `antra: A` and `B` on two lines, then the image; now they read `antra: A`, the image,
  then `B`. A message stored with its image first, as `presentAuthor` stores one (`[image, "antra: hello?"]`), now
  reads `antra: `, the image, then `antra: hello?`; before, it read `antra: hello?`, then the image. These read as
  before: a message whose text all comes before its non-text blocks, one with text only, one with non-text blocks
  only (`antra: ` before them), an empty one (`antra: `), the count line, the header and the
  `[Nothing new has been held since your last look.]` line. A host's own `framing` gets the same `backlog` as before,
  and a release's backlog lines (`renderHeldLine`) already followed block order. The resident's rows a resumed
  persisted reader is handed (`residentRows`, added in this release) are written in the same order.
