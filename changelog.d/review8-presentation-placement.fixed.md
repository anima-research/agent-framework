- A coalesced render delivered to a conversation fork while a turn of the fork's was alive is placed as not
  presented to it (`presented: false`), as a resident's is (#291): the render stays replaceable by the next push
  for its subject, and the fork is woken to read it. Before, the render counted as read by a turn that never saw
  it, so the next push was appended after it and no wake was queued. A write to an agent with no turn alive whose
  presentation at its write failed is placed so too, for a resident or a fork.
