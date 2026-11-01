# Speculative channel chunks

A voice server speaks what it gets. With MCPL §14.3 streaming, the host sends
`channels/outgoing/chunk` only for text a publish already delivered, so speech
starts after the whole answer is generated and published. A resident that
speaks through explicit `channel_publish` calls (proseRouting `disabled`) gets
no chunks at all.

Speculative channel chunks are an opt-in on both sides that streams the text of
a `channel_publish` call to a channel **while the model is still writing the
call**, before anything says the call will run. The publish stays
authoritative: its outcome ends the stream, and a stream whose call is not
published is cancelled, so the server can stop speaking.

Upstream discussion: anima-research/agent-framework#892.

## Enabling it

Both sides have to opt in. Other channels and other agents see no change.

- **Agent:** `AgentConfig.speculativeChannelChunks: true` (default false).
  connectome-host's recipe takes it as `agent.speculativeChannelChunks`.
- **Channel:** its descriptor's capabilities (channels/register,
  channels/changed) declare `streaming: { speculative: true }`. Its server's
  grant must also have `channels.streaming` (§5.4), and the channel must not
  be inbound-only.

It needs native tool mode and a provider that streams tool arguments: Anthropic
(`input_json_delta`), read through membrane's `emitToolInputDeltas`
(antra-tess/membrane#242). With a membrane that lacks the option, or in XML
tool mode, nothing streams and publishes behave as before.

On Anthropic it also needs the beta `fine-grained-tool-streaming-2025-05-14`
in the request's betas. Without it the API buffers a tool call's input and
sends it all at the end, so the text arrives no earlier than the publish
(measured: first content 2,793 ms without the beta, 939 ms with it, for an
eight-sentence answer on claude-opus-5-5). With the beta the API doesn't
validate tool-input JSON, so enable it only for agents that use this.

## Contract

While the model generates a `channel_publish` call whose channel (see below)
opted in, the host parses the partial argument JSON and sends, for each new
piece of the `content` argument (or `text`, its alias; the first of the two
the call writes, and the finished call must post that same text, see below):

```
channels/outgoing/chunk
{ channelId, streamId, seq, content: <new text since the previous chunk>, speculative: true, conversationId }
```

- `streamId` is the same on every message of one call's stream (`spec_<tool call id>`).
- `seq` counts 0, 1, 2… in the order sent.
- `content` is decoded text: JSON escapes (`\n`, `\"`, `\uXXXX`) are resolved,
  and a surrogate pair is never split across chunks.
- `conversationId` is the agent's name, as on §14.3 messages.

The stream ends exactly once:

- **Publish delivered** to the channel the chunks went to:
  `channels/outgoing/complete { channelId, streamId, content: <full text>, speculative: true, conversationId }`.
  The publish itself carries the stream's id: `channels/publish` params get
  `streamId`, so the server can match the publish to the speech it already
  started and not speak it twice.
- **Anything else**: `channels/outgoing/complete { channelId, streamId, content: "", speculative: true, cancelled: true, conversationId }`.
  That is: the call was cut off (max tokens, a dropped call), the stream ended
  or was aborted before the call finished, a refusal retry discarded the
  attempt, the call was refused before its publish (a conversation fork's
  guard, a hook), the publish failed or was not confirmed, the publish was
  delivered to another channel than the stream's, the call's argument JSON
  stopped parsing, the finished call posts other text than the chunks carried
  (a `text` before a `content`, a repeated key: the publish reads
  `content ?? text`), or the host stopped. A publish whose stream `stop()`
  cancelled before the publish started is refused, so the text isn't heard
  again.

A call that sent no chunk (its channel didn't opt in, or it had no text) sends
no `complete` either, and its publish carries no `streamId`.

### Which channel

- `channelId` given: the channel that name picks (its id or server-qualified
  name; with `serverId`, that exact pair). A name two channels answer to picks
  none, and nothing streams. While the call is being written and no
  `serverId` has been read, one may still follow, so the name streams only
  where it picks one registered channel by itself (a turn's own channel
  doesn't settle it yet); otherwise the text is held until `serverId` is read
  or the call is finished.
- `channelId` not given: the channel the publish defaults to (host 0.19: the
  turn's channel, the one whose message woke it). That is known only once the
  call is finished, since a later argument could still name a channel, so the
  call's whole text goes out as one chunk then, just before the publish.
- `content` written before `channelId` (argument order): the text is held and
  goes out as one chunk as soon as `channelId` has been read.

The publish's own resolution is authoritative: if it lands elsewhere than the
stream's channel, the stream is cancelled.

## Notes for servers

- Chunks are speculative: speak them, but be ready for `cancelled`, and treat
  `complete`'s content as the text that was published. This host completes a
  stream only when that text is what the chunks carried; otherwise it cancels
  the stream, and the publish that follows carries no `streamId`.
- The publish that follows a completed stream carries the same `streamId`.
- A host without this option sends §14.3 chunks only, and those carry no
  `speculative` flag.

## Where it lives

- `src/speculative-publish.ts`: `PublishArgsReader` (incremental argument
  JSON) and `SpeculativePublishStreams` (one inference's streams and their
  ends).
- `src/framework.ts`: the turn stream feeds tool-input tokens to it, the
  `tool-calls` event finishes calls, `dispatchChannelToolCall` passes the
  stream id to the publish and ends the stream on its outcome, `pushEvent`
  cancels on any other result, the stream's end and `stop()` cancel the rest.
- `src/mcpl/channel-registry.ts`: `speculativeTarget`, `sendSpeculativeChunk`,
  `sendSpeculativeComplete`; `streamId` on the publish.
