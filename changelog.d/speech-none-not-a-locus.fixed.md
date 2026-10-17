- A channel whose descriptor carries `metadata.speech: 'none'` (terminal-sessions marks
  its session channels so) is never the automatic destination of an agent's prose: a turn
  that such a channel woke routes bare prose to the agent's home or default channel
  instead, the agent is told that channel, and the terminal channel is not opened by
  delivery. Mid-turn, a message from such a channel doesn't move where the agent's
  prose lands, and neither does the agent's `channel_open` of one, which still opens
  it. Its traffic doesn't make it the default publish channel, so `channel_publish`
  without a `channelId`, whose description now says so, and the reply context servers
  receive (the channel context's `incoming`) stay with the conversation. Explicit sends
  to it still work.
