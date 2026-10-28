- **Hosts with a `providerHold`:** a wake parked on provider admission behind
  an auxiliary call (compression's kind) now goes back to the scheduler if a
  provider hold stands for its agent when the auxiliary work it waited for
  has settled, and the scheduler holds it as it holds a new wake under that
  hold, so it starts with the hold's other kept wakes once the hold releases.
  Before, it went on into its turn's call: when the auxiliary call's failure
  had armed the host's hold, that call went into the quota the host had just
  said was spent.
