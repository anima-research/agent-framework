- A held draft its resident leaves alone for a whole turn is set aside when
  that turn ends, as the resident's own `drafts(action: "dismiss")` would, so
  speech a send, a missing destination or a `skip_reply` held back asks for no
  call when the resident doesn't want it sent. The turn that holds a draft
  never sets it aside, so a draft is open at least through the turn after; a
  `drafts` call that names it (a read, or a resend, whatever comes of it)
  keeps it through that turn; and only a turn the model ends itself (its last
  response, or a tool that ends it) sets anything aside, not one that is
  refused, cut off, fails, is stopped, or runs silently. A bounce is left
  open, as is a draft that may already have been posted. A draft set aside
  can't be resent; its words stay in the resident's history. Resident-facing
  text: the
  held-draft notice and the turn-end receipt now end "left alone for a whole
  turn, it is / they are set aside when that turn ends" in place of the
  `dismiss` call (a receipt names a turn's bounces apart, with the old
  wording), and the `drafts` tool description states the rule. The
  `prose:drafts-dismissed` trace carries `auto: true` for these.
