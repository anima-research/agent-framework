- A turn no longer sends a request when its compile holds none of the
  conversation that the agent's window holds. Injections and the
  framework's own notices don't count as conversation, except the
  `[inference-failed]` notice, so a turn whose compile holds only its own
  routing notice is refused too. A compile made while a tool-result batch
  holds back its reserve is sent as before, so that the provider's answer
  settles the batch. Before, the request went out anyway. In native mode
  the provider refused the empty message list with a 400
  `invalid_request`. The poison-history breaker took that 400 for a bad
  history, and from the third failure in a row it set the newest turns
  aside. In XML tool mode, the model answered with none of the
  conversation in view. The failure is now classified `empty_compile`, and
  nothing retries it. The framework doesn't ask a host's error policy or
  provider hold about it, and the breaker never sheds turns for it. For a
  run of such failures, the agent gets one `[inference-failed]` notice,
  until a turn completes. The notice says that the turn wasn't sent and
  that none of the conversation reached the context. When the budget
  leaves room for conversation, the notice names the newest row that the
  compile left out. It names a message's author and channel where the
  metadata gives them, never from its text, or says that the row is a tool
  result, one the agent wrote, a context injection by its namespace, or a
  framework notice. The framework then wakes the agent once, so that it
  can tell the sender. If the refused turn was silent, a heartbeat or
  unprompted, its wake is of that kind too. An ephemeral run gets the
  notice without a wake. For the passthrough strategy, the notice also
  says that a message too large for the context keeps the older
  conversation out, and what the agent can do. When a round of the turn
  already ran, the turn ends with the usual "did not complete" notice
  instead. A compile that selects none of the conversation neither proves
  the live budget nor counts against it, so a budget that a boot applied
  at once stays as it is. The `context-refusal` ops alert gives the
  operator the strategy, the budget's figures, the row left out by its id
  and kind, and what to change. No ops alert, `inference:exhausted` trace,
  stderr line or `failures.log` record names the newest message's sender
  or channel. The notice itself names them, so a later request that holds
  the notice carries them, as it carries the conversation. A turn whose
  window holds no conversation, such as one on an empty store, is sent as
  before.
