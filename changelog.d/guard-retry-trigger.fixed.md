- A tool-result guard's retry that a provider hold releases in one batch
  with a wake it held before it now starts alone, as the retry, continuing
  the turn the guard held, and the wake goes back to the queue behind it.
  It used to start as that wake, a fresh turn, which opened a new EventGate
  window where the retry resumes its turn's.
