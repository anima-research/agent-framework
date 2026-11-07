- `AgentConfig.compressionMembrane`: a resident's memory writes (compression,
  merges, transition summaries) on a membrane of their own, for another
  provider or credential than the framework's. Its calls are the agent's
  maintenance work (withdrawn under a surgery's hold or once stop() closes
  admission, and waited for by a surgery), but they don't wait at the agent's
  provider gate, and a failure on them records no provider wait and arms no
  hold for the agent's own model. Needs a context-manager with
  `compressionMembrane`: `createAgent` refuses an older one rather than send
  memory writes to the agent's own provider. Covers the resident's own context;
  conversation forks and ephemeral runs compress on the framework's membrane.
