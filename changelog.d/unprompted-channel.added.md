- `FrameworkConfig.unpromptedChannel`: the channel for a turn the agent's own
  timer starts, which no message prompted: the wake `skip_reply` schedules,
  or the end of a `sleep`. Plain speech in locus or hybrid prose routing goes
  there, and so does `channel_publish` naming no channel in any mode, which
  servers are told as the turn's default outgoing channel. An all-except
  hold's channel still comes first while one is open. Without the setting,
  such a turn takes the global fallback: the hold's channel, else none under
  the default `speech.locus: 'delivery'`, or the latest inbound message's
  channel under `'latest-inbound'`. No other turn takes it: not one a message
  prompted, from a channel, a module, a person at a console or another
  agent; not a heartbeat's or a reminder's; not a conversation fork's or an
  ephemeral run's; and not a start merged from a timer's wake and any other
  cause. One value, for every agent on the framework. On a framework with
  the setting and an event gate, `channel_publish`'s description names that
  channel among its defaults; on any other, the description is unchanged.
