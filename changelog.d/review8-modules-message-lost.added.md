- Trace `message:lost` (`source: 'surgery-release'`, `agentName`, and the write's `external` address when it gave
  one): a write kept in memory until a surgery's release whose store threw there, none of it stored, or, with
  `mayBeStored: true`, context-manager couldn't tell what of it landed (the rows it names as stored are traced as
  `message:added`). One per write, as the release meets it; the agent's lost writes are told of once besides, by
  the `store-held-lost` ops alert. The Discord module ends its record of a create lost so, so a later delete,
  history sync or live create of the message isn't left waiting on a row that never comes (the next sync stores
  the message, and its delete reaches that row); where `mayBeStored` and the row did land, it applies the edits
  or delete it kept for the create to that row.
