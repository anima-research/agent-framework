- Compiles that are never sent are now dry runs (context-manager's
  `SelectOptions.dryRun`): `previewActivation`, which undo, rollback and
  hiding messages also run for their "last visible" line; the API's
  `message.list` and agent context commands; and a conversation fork's seed
  (the template's compile and the new namespace's emptiness check). A
  committing compile commits fold resolutions and can queue compression
  work, and with context-manager's thinking binding (#155) it commits stamps
  and joins the branch's compiles awaiting acceptance, where one never sent
  can cost a live stream's later replies their thinking. A dry run also
  leaves the agent's consumed watermark and a prepared budget change alone,
  as `previewActivation` already promised; a preview at the live window used
  to settle a converging budget change. `ActivationRequestOptions` gains
  `dryRun`.
- A conversation fork's seed no longer copies the template's `thinking` and
  `redacted_thinking` blocks, and leaves out a message with nothing else.
  Each block was signed under the template's prefix, which the fork's system
  prompt, tools and scoped injections don't promise to match: on an account
  that enforces thinking binding, the fork's first request could be refused.
  Once the fork's own thinking-binding pass engages, those copies would never
  render anyway.
