- **A module no longer acts once its `stop()` has completed,** through
  `removeModule()` or the framework's `stop()`. Before, a removed module's
  context could go on writing its state and log state, which a later module
  of the same name then read as its own, adding and editing messages in an
  agent's window, calling other modules' tools with module origin, pushing
  events that every remaining module processed, registering or removing
  speech handlers under its name, sending ops alerts, and receiving traces.
  And an event already being dispatched could still call the removed
  module's `onProcess`, with a later namesake's context, apply its
  response, writing its state update into a namesake's state, and call its
  speech handler on a namesake. Now, for a module whose `stop()` has
  completed:
  - each push through its context is dropped with a log line, as a push
    after the framework's `stop()` is: per push, since a tool result's line
    names the call, the tool where the event names one, and whether it
    succeeded, which an operator reconciles call by call;
  - `setState`, `registerLogState`, `appendToLog`, `editLogItem`,
    `editMessage`, `removeMessage`, `notifyOps`, `registerSpeechHandler` and
    `unregisterSpeechHandler` do nothing; `addMessage` returns `''` and adds
    nothing; `callTool` resolves with an error result and runs nothing;
    `getModule` returns `null`; and `onTrace` subscribes nothing, while the
    subscriptions made through the context end. None of these throws, so a
    late callback can't fail the host, and the first call of each method
    logs one line naming the module and the method;
  - `findMessageByExternalId` answers without updating its mapping; reads
    answer, and fail, as before;
  - its `onProcess` and `onAgentSpeech` aren't called again, and a response
    of its that hadn't been applied is dropped whole, with a line naming
    what it asked for. A push it made while registered still runs, since a
    push is its message to the others, made while it was there, while a
    response is applied on its behalf after it's gone.
- **A module may still write from inside its own `stop()`,** and a module
  whose `stop()` fails stays registered with a working context, for the
  retry.
- **`ModuleRegistry` takes a new optional `dropRetiredPush` option,** which
  the framework passes so that a push dropped after its `stop()` keeps
  today's line. A registry built without it, such as one a host's tests
  build, logs a line of its own for each dropped push, and doesn't queue it
  either.
