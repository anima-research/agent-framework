- A channel decided open (or tuned out) that its server retargets now opens
  at the new target when the only lifecycle work still outstanding for it
  was queued before the server's registrations were last removed. That work
  cancels when it would run, so it opens nothing. Before, the retarget left
  the new target to it, and the channel stayed unopened there although
  decided open. It needs the channel to be registered again in a way that
  queues no lifecycle work, before that work settles: from a push, or while
  the host doesn't direct the server's lifecycle (`channels.lifecycle`).
