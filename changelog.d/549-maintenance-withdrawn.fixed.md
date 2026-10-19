- A maintenance call agent-framework withdraws, under a surgery's hold or
  once `stop()` has begun, no longer counts against a chunk's compression
  (#549). `MaintenanceWithdrawnError` now extends context-manager's
  `CompressionWithdrawn`, so context-manager rethrows it unchanged from every
  rung of its compression fallback ladder and its merge path, recording no
  outcome, attempt or quarantine event. Before, a call withdrawn after a
  chunk's canonical call was refused was recorded as that rung's provider
  error, and once every rung had failed, the chunk's request family was
  quarantined, with its alert.
