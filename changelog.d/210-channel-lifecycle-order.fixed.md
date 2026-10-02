- Failed backscroll requests preserve the registry's known-open state rather than claiming a close. Automatic delivery joins pending lifecycle work without reopening a channel closed during the wait, and reports only actual delivery-forced opens using the current registration label.

- Channel lifecycle operations now run in order per channel and reconcile the latest desired state and registration after an in-flight operation completes. Concurrent registration, open, and close requests can no longer leave the server in an older state; a superseded tool request reports that its requested state no longer applies. Automatic delivery preserves active tune-out attention state while opening or awaiting transport.

- Lifecycle convergence makes at most five transport attempts per operation. Continued descriptor/intent supersession fails with a diagnostic, releases the queue, and gives joined speech or reply preparation a visible failure instead of hanging. Later stable operations can retry.
