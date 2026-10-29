- **Hosts with a `providerHold`:** a wake parked on provider admission behind
  an auxiliary call (compression's kind) now goes back to the scheduler if a
  provider hold is pending for its agent when the auxiliary work it waited
  for has settled, and the scheduler judges it as it judges a new wake: a
  hold that stands keeps it, and it starts with that hold's other kept wakes
  once the hold releases. Before, it went on into its turn's call: when the
  auxiliary call's failure had armed the host's hold, that call went into the
  quota the host had just said was spent.
