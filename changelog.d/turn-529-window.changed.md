- The default error policy gives a 529, or an overloaded error mid-stream,
  thirteen tries on membrane's overloaded schedule where 0.27.0 gave
  membrane's seven: jittered waits from 10 s doubling to five minutes come to
  20 to 40 minutes, about 30 on average (2,410 s nominal), as long as 0.26.0
  bore a 529 with membrane's seven sends inside each of its four tries
  (2,440 s nominal). 0.27.0's seven tries came to 5 to 10 minutes (610 s
  nominal). A host that passes `new DefaultErrorPolicy(settings)` keeps its
  own count. Ephemeral runs, such as a host's subagents, get the thirteen
  tries too, so a host that retries whole runs multiplies them:
  connectome-host starts a subagent's run again up to twice more after an
  overloaded error, so in a 529 storm one gets up to 39 sends over about 60
  to 120 minutes, where 0.27.0 gave it 21 over about 15 to 31. A stop through
  `Agent.cancelStream()`, as connectome-host's is, waits out the wait it
  finds, as in 0.27.0, and seven of the twelve waits run 150 to 300 s;
  `abortInference()` ends one at once.
