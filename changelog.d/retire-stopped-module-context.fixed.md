- **A module's context no longer acts for it once its `stop()` has
  settled,** through `removeModule()` or the framework's `stop()`. Before,
  a removed module could go on writing its state and log state, which a
  later module of the same name then read as its own, adding and editing
  messages in an agent's window, calling other modules' tools with module
  origin, pushing events that every remaining module processed,
  registering or removing speech handlers under its name, sending ops
  alerts, and receiving traces. Now each of its pushes is dropped with a
  log line, as a push after the framework's `stop()` is, a tool result's
  line naming the call, the tool and whether it succeeded; `setState`,
  `registerLogState`, `appendToLog`, `editLogItem`, `editMessage`,
  `removeMessage`, `notifyOps`, `registerSpeechHandler` and
  `unregisterSpeechHandler` do nothing; `addMessage` returns `''` and adds
  nothing; `callTool` resolves with an error result and runs nothing;
  `getModule` returns `null`; `onTrace` subscribes nothing, and the
  subscriptions the module made through its context end; and
  `findMessageByExternalId` answers without updating its mapping. None of
  these throws, so a late callback can't fail the host. Apart from pushes,
  the first such call of each method logs one line naming the module and
  the method. Reads are unchanged, a module may still write from inside its
  own `stop()`, and a module whose `stop()` fails stays registered with a
  working context, for the retry.
