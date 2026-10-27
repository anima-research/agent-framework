- **Hosts:** agent-framework now requires `@animalabs/membrane` `^0.8.0` (was `^0.7.1`), the membrane
  context-manager 0.24.0 requires (context-manager's 0.23.0 entry). A host whose own membrane range is still
  `^0.7` gets two membrane copies: TypeScript refuses its `Membrane` where agent-framework or context-manager takes
  one, and in JavaScript context-manager hands its membrane 0.8 formatter to the host's 0.7 `Membrane`, a mix no
  suite of the set runs.
  **Migration:** move the host to membrane `^0.8.0` with this release (connectome-host does, alongside it).
  **Unchanged:** the framework calls through the `Membrane` its host passes in, and its error policy still knows a
  `MembraneError` from another copy of membrane by its name.
