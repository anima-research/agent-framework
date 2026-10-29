- `subconscious.physicalWindowTokens` and `subconscious.thinkingBinding`, with
  the same types as an agent's and the same meaning where set, set the
  subconscious reader's own window and thinking binding in place of the
  resident's, on its own model or the resident's: the persistent reader's,
  and each reader fork's. A reader whose `subconscious.model` names another
  model can now have the window projection and the binding its model needs.
  Left out, nothing changes: on the resident's model a reader inherits the
  resident's two fields; on another model the persistent reader has neither,
  and a reader fork has the resident's. `null` counts as left out, and so does
  `false` for the binding, as in an agent's config. An enabled subconscious's
  malformed binding is refused before anything opens, whichever its reader,
  as an agent's is.
