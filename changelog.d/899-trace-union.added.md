- `TraceEvent` now lists every trace the framework raises, with its fields as raised, 28 more than before (#899):
  - from the gate: `gate:config-reconciled`, `gate:policy-added`, `gate:policy-removed` and `gate:shadow-warnings`;
  - from MCPL channels: `mcpl:channels-register`, `mcpl:channels-changed`, `mcpl:channels-incoming`, `mcpl:channel-descriptor-rejected`, `mcpl:channel-lazy-registered`, `mcpl:channel-opened-by-send`, `mcpl:channel-open-failed`, `mcpl:channel-open-substituted`, `mcpl:channel-reconcile-failed` and `mcpl:channel-reconcile-skipped`;
  - from MCPL pushes, inference and state: `mcpl:push_event`, `mcpl:inference_start`, `mcpl:inference_complete`, `mcpl:inference_fail`, `mcpl:state_registered`, `mcpl:checkpoint_recorded` and `mcpl:state_rollback`;
  - from tune-out: `tune-out:entered`, `tune-out:cancelled`, `tune-out:announced`, `tune-out:announce-failed`, `tune-out:ack-failed`, `tune-out:timer-failed` and `tune-out:wake-budget-paused`.

  The compiler now checks every raise's name against the union, and each field the raise writes out against its member, so a table keyed on `TraceEvent['type']` can name every trace a host receives.
- `TraceEventInput`, exported: a trace as raised, before its `timestamp` is stamped.
- Fields that were raised but not declared: `gate:config-reloaded`'s `removedPolicies` and `stateClearedPolicies`, `gate:decision`'s `observed`, and `tool:failed`'s optional `durationMs`.
