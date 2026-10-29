- **Hosts:** a model call that stops making progress is now cut
  (agent-framework#378). On an adapter whose stream reports content
  (`AnthropicAdapter`, `BedrockAdapter`), a resident's streamed call, and an
  MCPL server's, gets membrane's progress bounds: before content, 60 s from
  its send, or, once a thinking block has started, the later of that and the
  block's allowance (its `max_tokens` at 87 tokens a second); after content,
  150 s from its last provider event, or the allowance when that event was a
  thinking block's start and the allowance is longer. On every adapter a
  streamed call also ends once the larger of a setup term (the larger of the
  before-content and between-events bounds, 150 s) plus that allowance and
  1,862 s passes with no provider event; an SSE keepalive comment isn't one.
  A compression's, the reply judge's and an MCPL server's non-streamed call
  ends the setup term plus its allowance after its send, or at the larger of
  the setup term and 1,862 s when it names no `max_tokens`, unless its caller
  passed a `progressTimeoutMs` of its own; on an adapter whose `complete()`
  streams under the hood, such as membrane's OpenAI Responses adapter in
  subscription mode, that bound runs from the last provider event instead.
  Before, a call ended only at the Anthropic adapter's own 600 s watchdogs,
  the SDK's request timeout or the runtime's fetch timeout, which still apply,
  and a call kept open with keepalives didn't end. A call that would have run
  past one of these bounds and then completed now fails as a `timeout`.
  **Migration:** `inferenceBounds` raises them, and `inferenceBounds: false`
  sets none of them. The phase bounds act only when the `Membrane` passed in
  comes from membrane 0.8.0 or later; with an older one only the flat bound
  acts, so a host that builds its own `Membrane` raises its membrane to
  `^0.8.0` with this release.
- **Hosts:** `DefaultErrorPolicy` gives a deadline expiry one fresh call,
  1 s later. An expiry is a bound's cut, the Anthropic adapter's watchdogs,
  the SDK's request timeout or a runtime's fetch timeout; the last three were
  thrown as retryable timeouts and got the base schedule's three tries. For a
  deadline expiry the framework passes an `errorPolicy` the count of that
  call's consecutive expiries as `attempt`, in place of the turn's failures,
  so each call a deadline cuts gets its fresh call; a host's own policy reads
  that count too. A quiet call on an adapter without progress bounds now ends
  after two of the runtime's fetch timeouts (on Bun, 360 s each) rather than
  three. **Migration:** settings passed to `new DefaultErrorPolicy(settings)`
  with no `deadline` schedule give an expiry their base schedule, counted the
  same way.
