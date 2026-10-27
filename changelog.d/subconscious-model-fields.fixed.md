- A subconscious whose `subconscious.model` names a model id other than the
  resident's (compared exactly) no longer inherits the resident's
  `physicalWindowTokens` or `thinkingBinding`, which describe the resident's
  model: a resident window above its own model's let its streams walk past
  that model's window (#92). Such a subconscious now runs with no
  physical-window projection, so its `maxStreamTokens` restart is its only
  window guard, and its requests carry no drop control unless its inherited
  `providerParams` ask for one. It still inherits every other inference
  setting, the thinking config, `maxTokens`, the budgets and `promptCaching`
  among them, so its model's window must hold those budgets. On the
  resident's model, named or by default, it inherits both fields too.
