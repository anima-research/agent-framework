- An author-filtered `history--extract` no longer counts a row it leaves out for the calling agent twice across a
  chain of resumes. A page that fills stops at a lookahead match past its last row and resumes just after that row,
  but the rows left out on the way to the lookahead were counted in `leftOut` on that page and again on the page
  that resumed there. A full page now reports the rows left out up to its last row, and the resumed page counts the
  rest, so `leftOut` adds up across the chain, as the matched counts do.
- `history--search` stopped at its `limit` now counts in `leftOut` only the rows left out up to its last scanned
  candidate, where its `resume` continues: it counted every row left out in its whole candidate pool, and the
  resumed call counted those past the stop again.
