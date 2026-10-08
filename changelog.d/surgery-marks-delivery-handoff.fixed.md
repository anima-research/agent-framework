- Awareness marks queued just as a delivery pass finishes are now sent on
  their own trigger. A pass that had found nothing more to send stayed
  joinable for one more microtask, so a request made then (an operator's
  retract, say) joined a pass that would never look again, and its work
  waited for the next surgery, operator act, reconnect, `tools/list_changed`
  or restart. A pass now stops being joinable in the same step as its last
  claim.
