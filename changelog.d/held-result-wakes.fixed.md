- An orphan's result that is held because its recipient has ended now
  wakes the orphan's first adoption candidate. The candidate was already
  told in a notice, but nothing woke it, so the notice waited for its next
  turn, whatever started it. The wake's reason is
  `agent-result-held:<orphan>`, and it reads the notice's row. With
  `dendrite.announceOrphans: false` there is no notice and no wake. A
  notice that a crash left out of the candidate's window wakes it again at
  the next boot, as stored mail does.
