- Debounced gate batches now omit events whose writes the recipient has already
  read and answered, using the scheduler's existing answered-request evidence.
  Fully satisfied batches add no gate line and start no turn; partial batches
  retain their unseen events. Failed or aborted requests do not consume a wake.
  Channel writes that require a reply wait only for their recipient's final
  publication, for at most 65 seconds; a timeout keeps the wake. Publication
  holds do not evict unseen events.
  Judge, self-wake, sleep, and inference-status timing is unchanged.
- `gate:debounce-delivered` now counts only events actually delivered to at
  least one recipient, not events held for publication or already answered.
