- Failed backscroll requests preserve the registry's known-open state rather than claiming a close. Automatic delivery joins pending lifecycle work without reopening a channel closed during the wait, and reports only actual delivery-forced opens using the current registration label.

- Channel lifecycle operations now run in order per channel and reconcile the latest desired state and registration after an in-flight operation completes. Successful reconciliation confirms the current target and desired state at its receipt boundary; a superseded tool request reports that its requested state no longer applies. Automatic delivery preserves active tune-out attention state while opening or awaiting transport.

- Open receipts confirm only the current registration, connection, type, and address. Retargeting invalidates an older open flag; failed corrective opens leave the new target unconfirmed and fail joined delivery, while same-target backscroll failures retain known-open state.

- Lifecycle convergence makes at most five transport attempts per operation. Continued descriptor/intent supersession fails with a diagnostic, releases the queue, and gives joined speech or reply preparation a visible failure instead of hanging. Later stable operations can retry.
