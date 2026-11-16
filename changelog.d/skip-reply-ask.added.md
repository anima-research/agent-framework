- **`AgentConfig.sameRoundSkipReplyTextPolicy`: `'private'`, the behaviour
  when it's omitted, or `'ask'`.** Under `'ask'`, ordinary text in a round
  that calls `skip_reply`, which would otherwise stay private and be lost, is
  held as a draft when it would have been posted, bounced or held had the round
  not called `skip_reply`. The draft's cause is the new `'skip-reply'`, and it
  notes where the text was going. The turn's first `skip_reply` whose round
  holds such a draft is refused once. Its result is the held-draft notice,
  naming the draft and the `drafts` calls that resend or dismiss it, and asks
  where it should go: to end the turn and keep the draft, call `skip_reply`
  again. The refused call arms no wake. After that, a `skip_reply` runs, and
  text beside it is held and named as any held draft is.
  - The `skip_reply`'s answer waits until its round's text is handled, which in
    `hybrid` and `explicit` mode comes after the earlier rounds' deliveries. A
    held `skip_reply` whose turn is replaced, reset or stopped before then
    doesn't run and isn't refused, so it arms no wake.
  - In `hybrid` and `explicit` mode, such a round's envelopes set the sticky
    target and the hold as they do in a round without `skip_reply`, and what
    they would have published or bounced is held instead.
  - Untouched: text in a `>>skip_reply` or `>>>skip_reply` envelope, text
    beside a private `think` under `sameRoundThinkTextPolicy: 'private'`, a
    silent turn, and `proseRouting: "disabled"`. A script's `skip_reply` is
    never refused, though its round's text is held. A round with no verbatim
    content (membrane's `roundContent`), as on the XML tool path, is as under
    `'private'`: nothing is refused and nothing is held.
  - A derived agent and the subconscious don't take the policy from the agent.
  - No tool's description or schema changes.
