- **The framework publishes only where a connector declares where its posts
  land (MCPL RFC-011, anima-research/mcpl#17).** A channel is published to only
  when its descriptor declares `capabilities.publish.target`: `exact` (posts
  into a named thread or at the root) or `root` (a channel without threads).
  On an undeclared channel, a connector might choose the place itself, for
  example the thread of the newest incoming message (slack-mcpl#6).
  - **Every publication names its place.** It carries `threadId`: the
    route's thread, or `null` for the channel root. A delivery counts only
    when the connector's echo names that place. A missing or different echo
    is `unknown`.
  - **Migration:** upgrade connectors before, or with, the framework. Until a
    connector declares its channels:
    - the framework's own publication there is unavailable. Plain speech is
      held as drafts, with a notice naming the connector's own tools to
      consult.
    - `channel_publish`, draft resends and `>>` envelopes to such a channel
      are refused, with nothing sent.

    The connector's own send tools are unaffected. Declaring releases:
    discord-mcpl#67, slack-mcpl#20, telegram-mcpL#2, portal#46,
    eidoverse-worlds#223 and anima-dnd. pocket-body stays undeclared by its
    owner's decision, so its deliberate tools (`ring`, `say`, `listen`) remain
    the way to reach it.
  - **Host-minted channels count as undeclared.** That covers a DM channel
    the framework registers lazily from a push event, because the connector
    never described it. Connectors that register their DM channels with a
    declaration, as discord-mcpl does, are unaffected.
  - **Hosts calling `ChannelRegistry.publish` directly:** a target may name
    `threadId`. `PublishDestination` gains `threadId`, and an undeclared
    channel is refused before anything is opened or sent.
