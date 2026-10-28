- `subconscious.physicalWindowTokens` and `subconscious.thinkingBinding`, with
  the same types as an agent's and the same meaning where set, set the
  subconscious's own window and thinking binding in place of the resident's,
  on its own model or the resident's. A subconscious whose
  `subconscious.model` names another model can now have the window
  projection and the binding its model needs, which it otherwise runs
  without. Left out, nothing changes: on the resident's model it inherits the
  resident's two fields, and on another it has neither. `null` counts as left
  out, and so does `false` for the binding, as in an agent's config. An
  enabled subconscious's malformed binding is refused before anything opens,
  as an agent's is.
