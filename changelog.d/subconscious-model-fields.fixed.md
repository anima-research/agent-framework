- A subconscious whose `subconscious.model` names a model other than the
  resident's no longer inherits the resident's `physicalWindowTokens` or
  `thinkingBinding`, which describe the resident's model. It inherited the
  resident's whole config, so a resident window above its own model's let its
  streams walk past that model's window (#92). It still inherits every other
  inference setting, the thinking config, `maxTokens`, the budgets and
  `promptCaching` among them, so its model must accept those. On the
  resident's model, named or by default, it inherits both fields too.
