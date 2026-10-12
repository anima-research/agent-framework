- **Hosts and module authors using `ChannelRegistry` directly:** the registry
  no longer decides where speech goes. It still remembers where the last
  message a channel delivered came in, which the framework uses only for a
  turn whose wake names no conversation. `getDefaultPublishChannel()`
  returns its channel id, and `getLastInbound()` its server, channel and
  thread. A reaction or a withdrawal doesn't count as a message.
  - **Removed:** the `activeChannelResolver` option. The new
    `speechRouteResolver(agentName)` option replaces it, and the framework
    supplies it.
  - **Changed:** `resolveLocus(conversationId)`, which the framework calls
    with an agent's name, returns only a conversation fork's home channel,
    or null. `getChannelServerId(id)` names a server only when
    exactly one registered the id, and returns null for an id several
    servers share, where it used to return the first registrant. `buildChannelContext(agent)` advertises the
    agent's own route and reply edge, and nothing for a held, surface-only or
    absent route.
  - **Migration:** read a route from the framework's turn rather than the
    registry, and pass `channelId` explicitly when publishing outside a turn.
    `routeSpeech`/`deliverSpeech` also accept `{ serverId, channelId }` to
    publish to an exact server.
  - **Also changed:** `resolveProseTarget` returns the `serverId` its
    target resolved to beside the channel id. `startTyping` and
    `stopTyping` take `{ serverId, channelId }` (a bare id still works,
    resolving only an id one server registers). The registry no longer
    decides a coalesced message's trigger before `handleCoalescedIncoming`:
    the event carries the filter's inputs as `triggerInputs`, and a host's
    own handler decides from them once it admits the occurrence.
  - **Unchanged:** fork homes, explicit sends naming a channel, and
    `resolveDestination`. No sibling package version changes.
