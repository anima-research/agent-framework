- Debounced gate batches now omit events whose writes the recipient has already
  read and answered, using the scheduler's existing answered-request evidence.
  Fully satisfied batches add no gate line and start no turn; partial batches
  retain their unseen events. Failed or aborted requests do not consume a wake.
  Channel writes that require a reply wait only for their recipient's final
  publication; after 65 seconds the fence releases its events as wakeable.
  Delivery still waits for inference and quiesce to clear. Publication holds
  do not evict unseen events. Message-mode heartbeat/reminder debounces use
  the same answered-write check.
  Judge, self-wake, sleep, and inference-status timing is unchanged.
- `gate:debounce-delivered` now counts only events actually delivered to at
  least one recipient, once across immediate delivery and later fence release.
  It emits from debounce fire, inference/quiesce buffer flush, and publication
  fence release; merged flushes emit once per policy with newly delivered events.
  Fully held or answered batches emit no delivery trace.
