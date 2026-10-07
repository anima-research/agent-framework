- The inference-failure pipeline bounds the failure text it records. A failure's text is its source's `Error.message`, and a provider can echo the whole rejected request there: in one household an OpenAI-compatible 400 echoed ~1.7 MB, and the framework stored it in the resident's own context as an `[inference-failed]` marker (roughly 200K tokens the resident then carried), wrote it to stderr and `logs/failures.log`, and traced it.
  - The `[inference-failed]` marker carries a 600-character excerpt: head and tail around a marker stating how many of how many characters were omitted. It also names the classification when there is one ("the model call failed (invalid_request, HTTP 400) …"). Its metadata adds `errorType`, `retryable`, `httpStatus` and `providerErrorCode`, plus `reasonChars` whenever the marker's excerpt was cut. A small unclassified failure produces exactly the marker it did before.
  - These sinks carry at most 2,000 characters:
    - the reason excerpt in the exhaustion stderr line (the line also carries the agent, the streak and `type=… status=… code=…` labels when known);
    - every top-level string field of `logs/failures.log` records;
    - ops alert messages;
    - the inference log's `error`;
    - every trace event's `error` and `stack` strings.

    `inference:exhausted` traces and failures.log records add `httpStatus` and `providerErrorCode`, and a failures.log record adds `reasonChars` when its own excerpt was cut.
  - The OverBudget drain kick, the marker write and the provider-cooldown resume used to print the error object when they failed. They now print a bounded projection instead of the object: name, classification, status, provider code and message, each part bounded and the whole within 2,000 characters (one line unless the message itself has newlines). Printing a `MembraneError` prints its `rawRequest`, so a long system prompt was written out in full. Context maintenance records and logs a bounded message, in its existing format.
  - The OverBudget drain breaker's message-text fallback now applies only to unclassified failures, and it is decided on the whole reason, never the excerpt. A classified provider error that quotes "exceed hard budget" or "no summary covers" (the agent's own context, echoed back) no longer kicks the compression drain.
- Excerpts never split a surrogate pair. This bound is independent of the membrane version: membrane bounds its own errors too, but only in releases that carry that bound, and only for provider errors.
- Not covered by this change: Discord-awareness log sites, the speech-route failure reason and `[discord-send-failed]` marker (kept whole as delivery evidence), and other module or hook logs that print error objects.
