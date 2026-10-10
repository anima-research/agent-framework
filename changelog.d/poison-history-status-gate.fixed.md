- The poison-history breaker sheds history only for an `invalid_request`
  that came back as HTTP 400 or 422, the statuses membrane reads as rejected
  content. From membrane #56, its error boundary classifies every status, so
  an `invalid_request` can also be a 404 for a model that doesn't exist, and
  three of those would shed the agent's newest exchanges. An error that
  reports no status, from an older membrane, keeps the breaker's earlier
  rule, the type alone. The failure is still counted, logged and reported
  hard-down either way.
