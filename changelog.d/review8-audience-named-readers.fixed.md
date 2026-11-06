- A module's process response whose `requestInference` names agents is now stamped for the agents it names that
  read the slot its messages land in (the delivery agent's: the residents' slot on a residents' host), and as a
  write that names no agent, for the residents, when none of them does (#291). Before, a response naming only an
  isolated job or a conversation fork was stamped for that agent alone while stored in the residents' slot, which it
  doesn't read, so the row was in no window; on 0.32.0 every resident read it. A response naming a resident beside
  such an agent is for that resident. The gate's batched-wake line (`source: 'gate:debounce'`), which goes to the
  same slot, follows the same rule; its wake is unchanged. The `[wake onboarding]` notice instead gives such an
  agent its own copy where it reads, stamped for it (the 291-audience-stamp fixed entry). A response naming no
  registered agent is still for the agent it is delivered to.
