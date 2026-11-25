- A turn no longer sends a request when its compile holds none of the
  conversation. Before, the request went out anyway. In native mode the
  provider refused the empty message list with a 400 `invalid_request`.
  The poison-history breaker took that 400 for a bad history, and from the
  third failure in a row it set the newest turns aside. In XML tool mode,
  the model answered with none of the conversation in view. The failure is
  now classified `empty_compile`, and nothing retries it. The framework
  doesn't ask a host's error policy or provider hold about it, and the
  breaker never sheds turns for it. For a run of such failures, the agent
  gets one `[inference-failed]` notice, until a turn completes. The notice
  says that the turn wasn't sent and that none of the conversation reached
  the context. When the budget leaves room for conversation, the notice
  names the newest message's author and channel where its metadata gives
  them, never from its text. The framework then wakes the agent once, so
  that it can tell the sender. If the refused turn was silent, a heartbeat
  or unprompted, its wake is of that kind too. An ephemeral run gets the
  notice without a wake. For the passthrough strategy, the notice also
  says that a message too large for the context keeps the older
  conversation out, and what the agent can do. When a round of the turn
  already ran, the turn ends with the usual "did not complete" notice
  instead. The live budget counts a compile that selects none of the
  conversation as one that doesn't fit, as it counts a refused one. So a
  budget that a boot applied at once falls back to a paced restore from
  the recipe's budget, and compiles again. The `context-refusal` ops alert
  gives the operator the strategy, the budget's figures and what to
  change. No operator's log, alert or trace names the newest message's
  sender or channel. A turn on an empty store is sent as before.
