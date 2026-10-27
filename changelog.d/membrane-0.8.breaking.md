- **Hosts:** agent-framework now requires `@animalabs/membrane` ^0.8.0 (was
  ^0.7.1) and `@animalabs/context-manager` ^0.23.0 (was ^0.22.0), which
  admit no membrane 0.7.x. A host whose own membrane range is still ^0.7
  gets two membrane copies. TypeScript then refuses the host's `Membrane`
  in `FrameworkConfig.membrane` (TS2741). JavaScript isn't refused, but
  context-manager then hands its own membrane 0.8 formatter to the host's
  0.7 `Membrane` on every call it makes, a mix this release's tests don't
  cover.
  **Migration:** move the host to membrane ^0.8.0 with this release. A host
  that depends on context-manager itself moves it to the framework's range,
  ^0.23.0, too. membrane 0.8.0's own changelog says what it adds and
  changes. context-manager 0.23.0 also changes when summaries merge and
  what its debt report counts; its own changelog says how.
  **Unchanged:** the framework's own code. For the framework's request
  shapes compared before this release, membrane 0.8.0's native formatter on
  its Anthropic and Bedrock adapters builds the same bytes as 0.7.2's.
  membrane's retry settings and schedules are unchanged too.
