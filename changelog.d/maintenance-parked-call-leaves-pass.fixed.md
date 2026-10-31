- **One agent's maintenance call parked at its provider gate no longer holds
  the next maintenance pass for every other agent.** A pass ticks the agents
  with context work queued whose provider gate is open when it starts, and
  ended only once every one of their ticks had settled. A tick whose provider
  call parked partway through the pass, behind a turn its own agent began
  meanwhile or behind a provider cooldown, held the pass until that turn ended
  or the cooldown passed, and no pass started for any other agent until then.
  Now such a tick leaves its pass and goes on by itself: the pass ends with
  the other agents' work, later passes skip that agent until the tick settles,
  and the agent's entry in that pass's run is completed when the tick settles:
  its ticks, readiness and end, and any failure, which is alerted as one met
  during the pass is. `stop()`, surgeries and `resume()` still wait for the
  tick, and `stop()` and surgeries still withdraw a call parked at the gate.
  `maintenanceTick()` returns when its pass ends.
