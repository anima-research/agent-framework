- **Hosts and module authors using `ChannelRegistry` directly:** the registry
  no longer tracks the most recent inbound channel.
  - **Removed:** `getDefaultPublishChannel()`, and the
    `activeChannelResolver` option. The new `speechRouteResolver(agentName)`
    option replaces that option, and the framework supplies it.
  - **Changed:** `resolveLocus(agent)` returns only a conversation fork's
    home channel, or null. `buildChannelContext(agent)` advertises the
    agent's own route and reply edge, and nothing for a held, surface-only or
    absent route.
  - **Migration:** read a route from the framework's turn rather than the
    registry, and pass `channelId` explicitly when publishing outside a turn.
    `routeSpeech`/`deliverSpeech` also accept `{ serverId, channelId }` to
    publish to an exact server.
  - **Unchanged:** fork homes, explicit sends naming a channel, and
    `resolveProseTarget`/`resolveDestination`. No sibling package version
    changes.
