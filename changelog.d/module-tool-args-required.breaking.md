- **Module authors:** a module tool's call is refused before its handler
  runs when it lacks a key the tool's `inputSchema` lists in `required` (a
  key given as `null` counts as lacking it, unless its declaration admits
  `null`, by a type list naming it or `nullable: true`, or it has no `type`
  at all), or when its input is there but isn't an object. **Who
  needs to act:** a module whose handler runs without a key its schema
  requires, since calls that leave the key out ran before and are now
  refused. **Migration:** if the key is optional, drop it from `required`
  and give its default in the property's description; if your handler
  needs it, keep it required: calls without it are now refused before your
  handler runs, telling the agent what to send. **Unchanged:** a module
  tool's values (types, enums, nested shapes) are still the handler's to
  check, while a run through the `utils` tool has its values' types and
  enums checked, as it always had; an absent input (`undefined` or `null`)
  still reaches a tool that requires nothing; a name the module answers
  but doesn't declare goes on unchecked; MCPL servers' tools keep their
  servers' own checks. Where a required key is missing and the schema
  declares its keys only in `properties` and `required`, the refusal also
  names keys the call gave that it doesn't declare, since a key sent under
  another name is one way a required key goes missing; such keys are never
  refused for themselves. connectome-host needs no change:
  its tools of this kind keep those keys required, since each such call
  did something its agent didn't ask for, such as starting a subagent
  named "undefined", or one with no system prompt, which was accepted and
  then failed once its run began.
