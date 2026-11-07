- On a model that binds its thinking (`thinkingBinding.binds`), a tool boundary that told the agent someone had
  addressed it from another channel (`speech.locus: 'delivery'`) no longer costs the rest of its stream's thinking.
  The `[routing]` notice was stored and injected with the round, but the boundary noted it to context-manager as a
  row the store doesn't hold, after which nothing the stream sent kept its thinking at the next compile. It is now
  noted by its stored id, as the re-pin notice already was.
