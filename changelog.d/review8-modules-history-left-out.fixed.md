- An author-filtered `history--extract` counts a row it leaves out for the calling agent once across a chain of
  resumes. A page that fills stops at a lookahead match past its last row and resumes just after that row, and a full
  page reports the rows left out up to its last row, not those on the way to the lookahead, and the resumed page counts the
  rest, so `leftOut` adds up across the chain, as the matched counts do.
- `history--search` stopped at its `limit` counts in `leftOut` only the rows left out up to its last scanned
  candidate, where its `resume` continues, not every row left out in its whole candidate pool, so the resumed call
  doesn't count those past the stop again.
