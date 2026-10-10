- **Hosts and module authors using `ChannelRegistry` directly:** the registry
  no longer tracks the most recent inbound channel.
  - **Removed:** `getDefaultPublishChannel()`, and the
    `activeChannelResolver` option. The new `speechRouteResolver(agentName)`
    option replaces that option, and the framework supplies it.
  - **Changed:** `resolveLocus(agent)` returns only a conversation fork's
    home channel, or null. `getChannelServerId(id)` names a server only when
    exactly one registered the id, and returns null for an id several
    servers share, where it used to return the first registrant. `buildChannelContext(agent)` advertises the
    agent's own route and reply edge, and nothing for a held, surface-only or
    absent route.
  - **Migration:** read a route from the framework's turn rather than the
    registry, and pass `channelId` explicitly when publishing outside a turn.
    `routeSpeech`/`deliverSpeech` also accept `{ serverId, channelId }` to
    publish to an exact server.
  - **Unchanged:** fork homes, explicit sends naming a channel, and
    `resolveProseTarget`/`resolveDestination`. No sibling package version
    changes.
- **Operators whose residents speak on scheduled wakes:** a turn woken only
  by events that name no conversation now has no speech route, unless the
  resident is a conversation fork, whose home is its route. That covers
  heartbeat-mcpl's message-mode heartbeats and its reminders, whose `origin`
  names no conversation, as well as timers and self-wakes. Their plain speech
  used to go to the most recent inbound channel. It is now held as
  `no-destination` drafts, which the turn's `[delivered]` receipt names.
  - **Migration:** a routine that should post names its place on every
    wake. Before speaking, the resident can `channel_open` the channel,
    which sets the speech route for that turn only, or it can send
    explicitly with `channel_publish` and a `channelId`, or with the
    connector's own send tool. The heartbeat's or reminder's own message can
    say where. Held words can be resent with `drafts`.
  - **Unaffected:** heartbeat-mcpl's silent ticks, whose prose was already
    private.
