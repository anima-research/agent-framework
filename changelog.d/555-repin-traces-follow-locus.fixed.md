- After an addressed re-pin, or the agent's own `channel_open`, moves a
  `locus` or `hybrid` turn's locus between rounds, the `inference:tokens` and
  `inference:content_block` traces now name the new locus, and the typing
  indicator moves there, from the next round on (#555). Before, both stayed
  on the channel the stream started in for the rest of the stream, while the
  round's prose was delivered to the new locus, and after a budget restart
  or a guard retry the old channel's indicator kept running beside the new
  one until the turn ended. Both name the conversation the turn is
  attending: in `hybrid` mode they follow the locus whether or not a `>>>`
  envelope sends the text elsewhere. An `explicit` turn's typing and traces
  still show its trigger channel.
