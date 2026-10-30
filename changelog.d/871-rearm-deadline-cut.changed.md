- **Hosts:** a re-armed turn's send (agent-framework#838) that fails with a
  deadline marked as run out, membrane's or a bound the host sets on the
  call (`inferenceBounds`), as when a provider's stream stalls, now counts
  as a transient failure, so a turn that ends on it is re-armed as for a
  transient failure, unless it follows another such cut with no transient
  failure, answered round or message said to the agent between them: two
  such cuts in a row end the re-arming, and the second gets no retry from
  the error policy, even in a re-armed turn that got partway. A transient
  failure or an answered round in any of the agent's turns clears an earlier
  cut, and so does a message said to the agent. Every such cut counts,
  including one the error policy retries or a host's provider hold takes.
  0.29.0 listed a deadline, whether the host set it or membrane marks one as
  run out, among what the re-arm leaves unchanged; that still holds for a
  turn that isn't itself a re-arm.
