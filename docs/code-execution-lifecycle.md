# Code execution: execution, observation, and attention

A running operation and a waiting agent have different lifetimes. Python's
`await` suspends the coroutine; it should not oblige the agent to spend its
whole turn waiting. Keep Python semantics intact and put a bounded observation
around execution in the harness.

This branch implements that separation while preserving existing Python
contexts and background watchers. It is an initial lifecycle change, not a
durable job service or a replacement for the terminal execution protocol.

## Agent interface implemented here

One tool, `code_execution`, retains `code`, `background`, `action`, and
`script_id`, and adds `wait_ms` and `on_timeout`:

```json
{"code":"import asyncio\nawait asyncio.sleep(30)\nprint('done')","wait_ms":1000}
```

Quick results return stdout, stderr, and return_code as before, with an
execution ID and status. If still running after the observation budget, the
tool returns that ID with status `running`. The script continues, and its
completion notifies the owner. `action=wait` retrieves the retained result or
observes the same operation for another bounded interval. `wait_ms=0` returns
immediately; the maximum is 60 seconds. The default is 10 seconds, configurable
through agent-framework's `codeExecution.foregroundWaitMs`.

```json
{"action":"wait","script_id":"py-1","wait_ms":1000,"on_timeout":"end_turn"}
```

If the result arrives within the budget, the agent receives it and continues.
Otherwise, completion notification is armed **before** the tool result requests
`endTurn`. This uses the scheduler's existing result boundary: the stream ends
without cancelling the script. Completion is queued even if it arrives during
turn teardown. It bypasses ambient event gating because the agent armed it.
This ends a turn, not a timed gate sleep: other authorized events can still wake
the agent before the script finishes.

Repeated waits refer to one execution and never replay its side effects. A
wait already present at completion receives the result directly, suppressing
the additional completion wake. Multiple expired waits arm one completion
notice. The notice contains a bounded tail; the full captured result can be
retrieved with `wait` and uses the normal spill policy. Ordinary foreground
stdout is currently available at completion, not streamed during execution.

The existing foreground interpreter remains persistent and serial. A second
run while it is busy fails with the running ID and recovery instructions.
`background=true` uses an independent interpreter, retains `wake_agent`, and
journals output to the workspace. Its default remains immediate return and
silent clean exit; specifying a wait budget uses the same observation policy.
Background crashes still notify. `list` reports both modes; the legacy
`background_scripts` field is preserved. `cancel` stops Python explicitly.

Ephemeral agents cannot request `on_timeout=end_turn`: their owner is destroyed
when the turn ends and cannot receive the promised wake. Owner disposal cancels
its executions and releases their interpreters. Background watchers retain the
existing primary-agent restriction.

## Operator interface implemented here

The connectome-host companion adds the admin command `/release-wait [script_id]`
alongside `/undo`. With no ID it releases all current code-execution observations
for the selected agent. With an ID it releases only that execution's observers.
It does not abort Python or reset the agent. The underlying framework method is
`releaseCodeExecutionWait(agentName, scriptId?)`.

This is an admin operation, not an agent tool. The host requires trusted command
provenance: the local operator CLI/TUI or a full-authority web client. Generic
headless/fleet IPC and read-only web observers cannot invoke it. A caller cannot
grant itself admin status with an argument in the slash command. The framework's
generic socket API does not expose a release command.

A release after completion or when no observation is active returns `released: 0`;
it does not end an unrelated turn. Releasing a code observation does not settle
unrelated tools in the same batch. This is not a general-purpose inference reset.

## Correctness changes

- Reserve the Python runner before interpreter startup, so simultaneous cold
  calls cannot overwrite one another and startup can be cancelled.
- Bind asynchronous tool replies and wake acknowledgements to the originating
  interpreter and execution. A late reply must not satisfy a replacement
  interpreter's reused `t1` or `w1` ID.
- Preserve fractional seconds when sending inner-tool timeouts to Python.
- Serialize each script's wake requests, enforcing the interval and cap under
  `asyncio.gather`; stop rate-limit waits when execution ends.
- Acknowledge `wake_agent` only after context delivery and inference enqueue
  succeed. Delivery failures are errors visible to Python.
- Scope inner-tool end-turn requests to their execution, preventing background
  or late results from ending an unrelated foreground call.

## Limits and the next design steps

Execution IDs and the five most recently settled results per owner are held in
memory. Host restart loses them and stops Python. Completion delivery is not a
durable receipt/outbox: storage failure is logged, and an operator can retrieve
the result while the host remains alive. Explicit script wakes report delivery
failure to Python. Cancellation is not rollback, and does not cancel an already
dispatched inner tool. There is no claim of exactly-once external effects.

The next increment should give operations a bounded, cursor-addressed journal
and persistent terminal outcomes. Associate explicit notifications with delivery
receipts: queued, delivered at a tool boundary, or used to start a fresh turn.
That would avoid an unnecessary subsequent turn when an active inference has
already consumed the completion event. The existing wake scheduler can currently
queue such a follow-up. Crash recovery should report an interrupted operation,
not automatically rerun side-effectful code.

Keep routine output in the journal; only explicit signals, failures, and
requested completions should request attention. Waiting on several operations
should eventually offer “any” and “all” without polling code. Add named Python
contexts only when workflows need several persistent contexts; arbitrary Python
globals and stdout cannot safely be shared by concurrent top-level scripts.

For MCPL, this should be an operation lifecycle with ownership and cancellation
capabilities, separate from inference lifecycle metadata. A terminal operation
should retain its own run ID and completion even if Python or the model turn
ends. The harness observes that operation; a server should not need to guess
whether a timeout meant “stop waiting,” “stop executing,” or “go idle.”
