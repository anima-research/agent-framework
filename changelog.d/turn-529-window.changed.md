- The default error policy gives a 529, or an overloaded error mid-stream,
  thirteen tries on membrane's overloaded schedule where 0.27.0 gave
  membrane's seven: jittered waits from 10 s doubling to five minutes come to
  20 to 40 minutes, about 30 on average (2,410 s nominal), as long as 0.26.0
  bore a 529 with membrane's seven sends inside each of its four tries
  (2,440 s nominal). 0.27.0's seven tries came to 5 to 10 minutes (610 s
  nominal). A host that passes `new DefaultErrorPolicy(settings)` keeps its
  own count.
