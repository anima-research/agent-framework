- **Code that calls `ChannelRegistry` or `ConversationRouter` directly:** a
  channel the registry acts on is a `ChannelRef`, `{ serverId, channelId }`
  (exported as a type), where it was a bare channel id, since two MCPL
  servers can register the same id.
  - `routeSpeech` and `deliverSpeech` take the locus as a `ChannelRef` (or
    `null`), and `resolveLocus` and `getDefaultPublishChannel` return one.
    `getDescriptor`, `isChannelOpen`, `inboundOnlyServer` and
    `proseTargetFor` take one. `getChannelServerId` is removed: a ref names
    its server.
  - `buildChannelContext(agentName, serverId)` builds the channel context one
    server is told, and `incomingFor(agentName)` gives the message the agent
    is replying to, with its channel.
  - `ChannelRegistryOptions.homeChannelResolver` and `activeChannelResolver`
    return a `ChannelRef`.
  - `sendOutgoingChunk` and `sendOutgoingComplete` take only the
    destination the publish went to. A bare channel id, which they resolved
    again at each call and dropped where two servers register it, is no
    longer taken.
  - `ConversationRouter`'s `bind`, `touch`, `unbind` and `getBinding` take a
    `ChannelRef`, `channelForAgent` returns one, and a `ConversationBinding`
    carries `serverId`.
  - **Migration:** pass `{ serverId, channelId }`. An inbound event, a
    publish outcome's `destination` and `channel_list` each carry the server.
    `resolveProseTarget`'s answer, `openIfClosedForSend`'s, `channel_open`'s
    result data, a gate wake's `WakeProvenance` (as `routeServerId`) and
    `onRouteFailure`'s info now carry it too, and `InferenceRequest` carries
    it as `channelServerId`, beside `channelId`. A stream's chunk and
    `complete` take the publish outcome's `destination`. For a name given as a
    string, `channelsNamed(name)` gives the channels it means, by its id or
    its `serverId:channelId` form, and `nameShown(ref)` the name an agent is
    shown for a channel.
  - **Unchanged:** `startTyping`, `stopTyping` and `publishForAgent` still
    accept a bare id, as connectome-host's activity and notices modules pass
    one, and also take a ref or a `serverId:channelId` name. Where two
    servers register the id, what a bare id does changes, as Fixed says:
    typing shows in each server's channel, and `publishForAgent` refuses it.
    `InferenceRequest.channelId` stays. No tool's description or schema
    changes.
