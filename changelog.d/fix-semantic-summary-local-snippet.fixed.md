- `semantic_search` builds a summary hit's snippet and `chars` from the local
  summary, as it already does for message hits, instead of taking the
  service's copy: up to 400 UTF-16 units of the text as indexed, with "…" when
  it's longer than that. A service that stores only vectors and ids, and
  returns no text, now gives summary hits a snippet instead of an empty one.
  Where a branch made from an earlier point, as an undo makes one, minted a
  summary id another branch already used, the hit's snippet and `chars` come
  from this branch's summary; its score, timestamp and date filtering are
  still the index's.
