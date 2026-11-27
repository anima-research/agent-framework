- Under the plain passthrough strategy, a turn no longer sends a request
  when its compile holds none of the conversation that the agent's window
  holds. Other strategies, a subclass of `PassthroughStrategy` included,
  are sent as before, since such a strategy can leave rows of the window
  out by design. Injections and the framework's own notices don't count as
  conversation, except the `[inference-failed]` notice, so a turn whose
  compile holds only its own routing notice is refused too. A compile made
  while a tool-result batch holds back its reserve is sent as before, so
  that the provider's answer settles the batch. Before, the request went
  out anyway. In native mode the provider refused the empty message list
  with a 400 `invalid_request`. The poison-history breaker took that 400
  for a bad history, and from the third failure in a row it set the newest
  turns aside. In XML tool mode, the model answered with none of the
  conversation in view. The failure is now classified `empty_compile`, and
  nothing retries it. The framework doesn't ask a host's error policy or
  provider hold about it, and the breaker never sheds turns for it. For a
  run of such failures, the agent gets one `[inference-failed]` notice,
  until a turn completes: "Your previous turn wasn't sent: none of your
  conversation was included in the request." When a round of the turn
  already ran, the turn ends with the usual "did not complete" notice
  instead. The `context-refusal` ops alert gives the operator the
  strategy, the budget's figures and what to change. A turn whose window
  holds no conversation, such as one on an empty store, is sent as before.
