- An author-filtered `history--extract` no longer counts a row it leaves out for the calling agent twice across a
  chain of resumes. A page that fills stops at a lookahead match past its last row and resumes just after that row,
  but the rows left out on the way to the lookahead were counted in `leftOut` on that page and again on the page
  that resumed there. A full page now reports the rows left out up to its last row, and the resumed page counts the
  rest, so `leftOut` adds up across the chain, as the matched counts do.
