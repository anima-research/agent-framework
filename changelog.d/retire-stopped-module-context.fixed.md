- **A module no longer acts once its `stop()` has completed,** through
  `removeModule()` or the framework's `stop()`, except that after
  `removeModule()` the result its `handleToolCall` returns for a call it was
  already running is still delivered while the framework runs (below).
  Before, a removed module's context could go on writing its state and log
  state, which a later module of the same name
  then read as its own, adding and editing messages in an agent's window,
  calling other modules' tools with module origin, pushing events that
  every remaining module processed, registering or removing speech
  handlers under its name, sending ops alerts, and receiving traces. And
  an event already being dispatched could still call the removed module's
  `onProcess`, with a later namesake's context, apply its response,
  writing its state update into a namesake's state, and call its speech
  handler on a namesake; and a turn whose context was being gathered when
  its removal completed still took its `gatherContext` answer. Now, once a
  module's `stop()` has completed (a module added again under its name,
  even the same object, is a new registration, which none of this
  touches):
  - each push through its context is dropped with a log line, as a push
    after the framework's `stop()` is: per push, since a tool result's line
    names the call, the tool where the event names one, and whether it
    succeeded, which an operator reconciles call by call;
  - `setState`, `registerLogState`, `appendToLog`, `editLogItem`,
    `editMessage`, `removeMessage`, `notifyOps`, `registerSpeechHandler` and
    `unregisterSpeechHandler` do nothing; `addMessage` returns `''` and adds
    nothing; `callTool` resolves with an error result and runs nothing;
    `getModule` returns `null`; and `onTrace` subscribes nothing, while the
    subscriptions made through the context end, and do nothing even if the
    registry's unsubscribe throws. None of these throws, so a
    late callback can't fail the host, and the first call of each method
    logs one line naming the module and the method;
  - `findMessageByExternalId` answers without updating its mapping; reads
    answer, and fail, as before;
  - its `onProcess`, `onAgentSpeech` and `onToolBatchComplete` aren't called
    again, and a response of its that hadn't been applied is dropped whole,
    with a line naming what it asked for if it asked for anything. A push it
    made while registered still runs, since a push is its message to the
    others, made while it was there, whereas applying a response would act on
    its behalf after it's gone;
  - its `gatherContext` answer is left out of a turn whose answers the
    registry hadn't merged when its `stop()` completed, with a line if it
    held injections; a stop that completes after the merge leaves that
    turn's context as it was;
  - a module added later under its name has its `onToolBatchComplete`
    called, even while the stopped module's own hook is still running past
    its bound.
- **After `removeModule()`, the result a module's `handleToolCall` returns
  for a call it was running when its `stop()` completed is still delivered
  while the framework runs,** like a push it made while registered: the
  agent asked while the module was there, and the result is the true
  answer to what ran. An error in its place would
  tell the agent a tool that ran didn't, and dropping it would leave the
  call unanswered. A response differs because the framework applies a
  response for the module, after it's gone. A result the module pushes
  through its context after its stop completes is a push like any other:
  it's dropped, with the line that names the call, the tool and whether it
  succeeded. The framework's `stop()` closes its event queue before it
  stops any module, so through it that result is dropped, with the line any
  tool result arriving after the framework's `stop()` gets, as before.
- **A module may still write from inside its own `stop()`,** and a module
  whose `stop()` fails stays registered with a working context, for the
  retry.
- **A push dropped after the framework's `stop()` keeps today's line.** A
  `ModuleRegistry` a host builds itself, such as one its tests build, drops
  a stopped module's pushes too, with a line of its own for each, and
  doesn't queue them.
