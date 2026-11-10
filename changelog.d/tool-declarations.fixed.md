- An agent `createEphemeralAgent` makes with a spec that names
  `selfParticipants`, and a config that names none, now takes the spec's, as
  `AgentSpec.selfParticipants`' doc says: those participants' turns render as
  its own, and their system changes are its own, live as in its record, which
  already stated them and from which a resumed agent reads them. A shared
  `taskForkSpec` names its parent there, so such a child now reads its
  parent's turns as its own history, as one `deriveAgent` makes already did.
