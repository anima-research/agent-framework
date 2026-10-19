- An agent's request no longer carries the `tokenEstimate` the framework
  stamps on the thinking blocks it stores. Membrane sent a
  `redacted_thinking` block to Anthropic and Bedrock with every field it
  had, and the Messages API refuses a block carrying a field it doesn't
  define ("Extra inputs are not permitted"). So once the framework stored a
  stamped `redacted_thinking`, every later request carrying that turn was
  refused. A framework turn's request and the direct API's (`runInference`)
  now drop the stamp from the compiled messages. The stored block keeps it,
  and context-manager still prices the block by it.
