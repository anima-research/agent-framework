- Compiles that are never sent are now dry runs (context-manager's
  `SelectOptions.dryRun`): `previewActivation`, which undo, rollback and
  hiding messages also run for their "last visible" line; the API's
  `message.list` and agent context commands; and a conversation fork's seed
  (the template's compile and the new namespace's emptiness check). A
  committing compile persists fold resolutions and queues the compression its
  fold plan calls for. Once context-manager's thinking binding
  (anima-research/context-manager#160, not yet released) ships, it will also
  commit stamps and join the branch's compiles awaiting acceptance, where one
  never sent can cost a live stream's later replies their thinking. A dry run
  does none of that, and it leaves the agent's consumed watermark and a
  prepared budget change alone, as `previewActivation` already promised; a
  preview at the live window used to settle a converging budget change.
  `ActivationRequestOptions` gains `dryRun`.
- With context-manager 0.14.1, a dry run leaves what a select leaves behind as
  the last committing compile left it: no chunk record, no calibration, and
  none of the bookkeeping the next compile or an observer reads. The one thing
  it can still leave is the release of a compression hold whose deadline has
  passed, as any compile does.
- Under the autobiographical strategy, a dry run still refuses a budget the
  context can't fit, as a committing compile does: context-manager skips only
  its post-pick check, and an adaptive fold plan that doesn't fit then
  overruns at the middle's emission, with a refusal that names the tokens and
  the limit. So at such a budget a preview, `message.list` and the API's agent
  context command still fail, and a fork whose template's fold plan doesn't
  fit the default budget its seed is compiled at still fails to spawn.
  Windowed passthrough, though, skips its refusal of a newest message larger
  than the budget on a dry run: where they failed on such a message, a
  preview, `message.list` and the agent context command now return it alone,
  larger than the budget, and a fork is seeded with it. Passthrough, the
  default strategy, keeps the newest messages that fit, as before.
- A conversation fork's seed no longer copies the template's `thinking` and
  `redacted_thinking` blocks, and leaves out a message with no content left.
  A fork inherits the template's conversation, not its reasoning. A signed
  block was minted under the template's prefix, which the fork's system
  prompt, tools and scoped injections don't promise to match, so on an
  account that enforces thinking binding the fork's first request could be
  refused (inferred from probes of other requests, not observed on a fork).
  Unsigned reasoning, from text-only providers or XML mode, goes by the same
  rule. On models that don't bind thinking to its prefix (by probes, Fable 5
  and Sonnet 5), a copy would have been kept, so there the fork loses the
  template's reasoning. That a provider accepts the stripped seed rests on
  probes of two shapes, each sent without its thinking: an assistant text
  turn followed by a new user turn, on Sonnet 5.5, Fable 5.1, Fable 5 and
  Sonnet 5; and a tool round, a `tool_use` with no thinking before it and
  its result, continued by the model, on those four, Opus 5.5 and Haiku 5.5.
  Other thinking models weren't probed.
- On the OpenAI Responses path, the seed's items that were paired with a
  reasoning item it left out (the message's text, a function call) lose
  their provider-native raw item and render from their fields, so the fork
  replays no item id whose reasoning is gone. Opaque items, such as a
  compaction or a hosted tool's call, keep theirs.
- A fork's seed keeps no tool call whose result isn't in it, and no result
  whose call isn't (context-manager's `stripUnpairedToolBlocks`): the rest of
  their messages stays, and a message left with nothing becomes
  `[tool call omitted]`. A fork spawned while the template was between a
  tool round's call and its results (the coalescer can spawn one outside the
  event loop) gave the fork's first request an unanswered call under the
  passthrough strategies.
- A fork's spawn logs one line when its seed left something out:
  `[conversation] <fork>: seeded from <template> without N thinking
  block(s), N unanswered tool call(s) and N orphaned tool result(s)`.
