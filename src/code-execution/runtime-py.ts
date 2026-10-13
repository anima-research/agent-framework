/**
 * Python runtime for client-side programmatic tool calling (PTC).
 *
 * This is the interpreter-side half of the `code_execution` tool: a small
 * asyncio REPL that mimics the environment Anthropic's server-side PTC was
 * trained on (see docs/en/agents-and-tools/tool-use/programmatic-tool-calling):
 *
 *   - scripts run with top-level `await` (PyCF_ALLOW_TOP_LEVEL_AWAIT)
 *   - host tools are injected as async functions taking a single dict and
 *     returning a string (the tool_result text)
 *   - a pending tool call that gets no response raises TimeoutError with the
 *     same message shape the managed runtime produces
 *   - interpreter globals persist across execs (container-reuse semantics)
 *
 * BACKGROUND MODE (model-authored daemons): when init carries
 * `background: true`, the exec additionally gets:
 *   - `wake_agent(payload)` — async; reports the caller's line number (which
 *     indexes into the agent-authored script — self-correlation) and delivers
 *     the payload to the host, which injects it into the agent's context and
 *     triggers inference. Awaits a host ack so rate limiting backpressures
 *     inside the script instead of dropping wakes.
 *   - stdout/stderr tee'd line-buffered to `log_path` (agent-readable via
 *     their file tools) with an in-memory tail kept for the crash envelope.
 *
 * Embedded as a TS string because tsc does not copy non-TS assets to dist/;
 * PyRunner materializes it to a temp file at spawn.
 *
 * Protocol (JSON lines):
 *   host -> py : {op:"init", tools:[{py_name,tool_name}], call_timeout_s,
 *                 background?, log_path?, tail_chars?}
 *                {op:"exec", id, code}
 *                {op:"tool_result", id, result}
 *                {op:"wake_ack", id, error?}
 *                {op:"cancel", id, reason?}
 *   py -> host : {op:"ready"}
 *                {op:"tool_call", id, exec_id, name, args}
 *                {op:"wake", id, exec_id, line, payload}
 *                {op:"exec_result", id, stdout, stderr, return_code, tail?}
 *
 * At a deadline the host sends cancel and then SIGINT, repeated until the
 * script reports (not on Windows): the cancel stops a script waiting on an
 * await, the signal also one stuck in blocking code (see _on_sigint).
 *
 * IMPORTANT: the python source below must not contain backticks or the
 * sequence dollar+brace (TS template literal syntax). String.raw preserves
 * backslashes, so \n inside python string literals is fine.
 */

export const PYTHON_RUNTIME_SOURCE: string = String.raw`
import ast
import asyncio
import inspect
import io
import json
import os
import signal
import sys
import threading
import traceback

PROTO_OUT = sys.stdout          # protocol channel (real stdout)
REAL_STDERR = sys.stderr        # runtime diagnostics outside execs
CALL_TIMEOUT_S = 270.0
OUTPUT_CAP_CHARS = 2_000_000
LOG_FILE_CAP_BYTES = 50_000_000

BACKGROUND = False
LOG_PATH = None
TAIL_CHARS = 4000

_send_lock = threading.Lock()


def send(obj):
    line = json.dumps(obj, ensure_ascii=False, default=str)
    with _send_lock:
        PROTO_OUT.write(line + "\n")
        PROTO_OUT.flush()


class CappedIO(io.StringIO):
    """StringIO that stops recording past a cap (keeps a truncation flag)."""

    def __init__(self, cap):
        super().__init__()
        self._cap = cap
        self.truncated = False

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        if self.tell() >= self._cap:
            self.truncated = True
            return len(s)
        remaining = self._cap - self.tell()
        if len(s) > remaining:
            self.truncated = True
            return super().write(s[:remaining])
        return super().write(s)


class LogTee:
    """Background-mode writer: line-buffered file append + rolling tail.

    The file is the agent-readable journal (their read/grep/shell tools work
    on it); the tail rides the exec_result so the host can build a crash
    envelope without re-reading the file.
    """

    def __init__(self, path, tail_chars):
        self._fh = None
        self._written = 0
        self._tail = ""
        self._tail_chars = tail_chars
        self.truncated = False
        if path:
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                self._fh = open(path, "a", encoding="utf-8", errors="replace")
            except Exception as exc:
                REAL_STDERR.write("[pytc-runtime] cannot open log file: " + str(exc) + "\n")
                REAL_STDERR.flush()

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        self._tail = (self._tail + s)[-self._tail_chars:]
        if self._fh is not None and not self.truncated:
            if self._written + len(s) > LOG_FILE_CAP_BYTES:
                self.truncated = True
                try:
                    self._fh.write("\n[log capped at " + str(LOG_FILE_CAP_BYTES) + " bytes]\n")
                    self._fh.flush()
                except Exception:
                    pass
            else:
                try:
                    self._fh.write(s)
                    if "\n" in s:
                        self._fh.flush()
                    self._written += len(s)
                except Exception:
                    pass
        return len(s)

    def flush(self):
        if self._fh is not None:
            try:
                self._fh.flush()
            except Exception:
                pass

    def close(self):
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass
            self._fh = None

    def tail(self):
        return self._tail


# Persistent interpreter state (mirrors container reuse: variables survive
# between exec calls until the host reclaims the interpreter).
SCRIPT_GLOBALS = {"__name__": "__main__", "__builtins__": __builtins__}
_injected_py_names = set()

_pending_tool_futures = {}
_pending_wake_futures = {}
_next_tool_call_id = 0
_next_wake_id = 0
_current_exec_id = None
_current_exec_task = None

# How the host stops a script (its time limit, or an abort): ONE per-script
# state, so the script is stopped exactly once, by whichever path gets there
# first. Every other path then does nothing to that script.
#   PENDING   -> nothing asked yet.
#   REQUESTED -> asked while the script was outside its own code (waiting on
#                an await, writing a protocol line, or not started yet). A
#                cancellation is queued on the loop, or delivered as the
#                script starts.
#   DELIVERED -> KeyboardInterrupt raised in its code, or its task cancelled.
#                Final: whatever the script does next (except/finally, awaits
#                in its cleanup) runs to completion or to the host's kill.
# Transitions happen only in the main thread: in the SIGINT handler (between
# bytecodes, so it never cancels anything itself -- see _on_sigint) and in
# loop callbacks. Neither can interleave a transition of the other halfway
# in a way that matters: the handler only moves PENDING to REQUESTED or, with
# the script's own frame on the stack, to DELIVERED; a loop callback never
# runs while the script's frame is on the stack.
#
# Where the signal (or the cancel op) can land, and what happens:
#   1. script's own code, running or blocking -> KeyboardInterrupt there
#   2. script waiting on an await (loop idle) -> cancellation queued; it wakes
#      the loop and lands at that await
#   3. main() mid-dispatch, between the done() check of a future the script
#      awaits and its set_result (reply behind the cancellation) -> queued;
#      set_result completes; the script gets CancelledError instead of it
#   4. the script writing a protocol line (send) -> queued; the line stays
#      whole; the cancellation lands at the script's next await
#   5. reply ahead of the queued cancellation, script then awaits -> the
#      cancellation lands at that await
#   6. reply ahead, script then blocks -> the next signal (the host repeats
#      it) raises KeyboardInterrupt there; the queued cancellation then does
#      nothing, so cleanup that awaits is not cut short
#   7. reply ahead, script finishes before the queued cancellation runs ->
#      it does nothing, and never reaches the next script
#   8. script not started yet (signal, or the cancel op) -> delivered as
#      CancelledError when it starts, so it still reports
#   9. cancel op before the signal -> delivered; the signal and its repeats
#      do nothing, so cleanup after a caught CancelledError runs on
#  10. cancel op or repeated signal after delivery -> nothing
#  11. script finished, reporting its result -> nothing
#  12. between scripts -> nothing
#  13. a previous script installed an eager task factory -> no effect: the
#      runtime builds its script task directly, and the state is in place
#      before the script's first step
_PENDING = "pending"
_REQUESTED = "requested"
_DELIVERED = "delivered"


class _ScriptStop:
    __slots__ = ("task", "running", "state", "interrupt")

    def __init__(self):
        self.task = None
        self.running = False  # the script's own code may be on the stack
        self.state = _PENDING
        self.interrupt = None  # the KeyboardInterrupt raised in its code


_stop = None  # the running script's _ScriptStop; None between scripts


def _deliver_cancel(st):
    # Loop context only: the cancel op in main()'s dispatch, or queued by the
    # SIGINT handler. Never from inside the handler, where a cancellation
    # could land between main()'s done() check of a future the script awaits
    # and its set_result.
    if st is None or st is not _stop or st.state == _DELIVERED:
        return
    if not st.running:
        st.state = _REQUESTED  # not started yet: delivered as it starts
        return
    st.state = _DELIVERED
    st.task.cancel()


def _resolve(fut, value):
    # Defense in depth: the script may have been cancelled since the lookup.
    if fut is not None and not fut.done():
        try:
            fut.set_result(value)
        except asyncio.InvalidStateError:
            pass


def _make_tool_fn(tool_name, py_name):
    async def tool_fn(args=None):
        global _next_tool_call_id
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise TypeError(
                "tool functions take a single dict of arguments, e.g. await "
                + py_name + "({...})"
            )
        _next_tool_call_id += 1
        call_id = "t" + str(_next_tool_call_id)
        fut = asyncio.get_running_loop().create_future()
        _pending_tool_futures[call_id] = fut
        send({
            "op": "tool_call",
            "id": call_id,
            "exec_id": _current_exec_id,
            "name": tool_name,
            "args": args,
        })
        try:
            return await asyncio.wait_for(fut, timeout=CALL_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise TimeoutError(
                "Calling tool ['" + tool_name + "'] timed out (no response after "
                + str(int(CALL_TIMEOUT_S)) + "s)."
            )
        finally:
            _pending_tool_futures.pop(call_id, None)
    tool_fn.__name__ = py_name
    tool_fn.__qualname__ = py_name
    tool_fn.__doc__ = (
        "Host tool '" + tool_name + "'. Takes a single dict of arguments and "
        "returns the tool result as a string."
    )
    return tool_fn


async def wake_agent(payload=None):
    """Wake the agent: deliver payload into their context and trigger a turn.

    Reports the caller's line number (indexes into the script the agent
    wrote). Awaits the host ack — rate limiting backpressures here rather
    than dropping wakes. Raises RuntimeError when the host refuses (wake cap
    exceeded, script cancelled).
    """
    global _next_wake_id
    frame = inspect.currentframe()
    line = frame.f_back.f_lineno if frame is not None and frame.f_back is not None else -1
    _next_wake_id += 1
    wake_id = "w" + str(_next_wake_id)
    fut = asyncio.get_running_loop().create_future()
    _pending_wake_futures[wake_id] = fut
    send({
        "op": "wake",
        "id": wake_id,
        "exec_id": _current_exec_id,
        "line": line,
        "payload": payload,
    })
    try:
        error = await fut
        if error:
            raise RuntimeError("wake_agent refused by host: " + str(error))
        return None
    finally:
        _pending_wake_futures.pop(wake_id, None)


def handle_init(msg):
    global CALL_TIMEOUT_S, BACKGROUND, LOG_PATH, TAIL_CHARS
    timeout = msg.get("call_timeout_s")
    if isinstance(timeout, (int, float)) and timeout > 0:
        CALL_TIMEOUT_S = float(timeout)
    BACKGROUND = bool(msg.get("background"))
    LOG_PATH = msg.get("log_path") or None
    tail = msg.get("tail_chars")
    if isinstance(tail, int) and tail > 0:
        TAIL_CHARS = tail

    # Remove functions injected by a previous init that are no longer present
    # (tool list changed) without touching user-defined globals.
    new_tools = msg.get("tools") or []
    new_py_names = set()
    tools_dict = {}
    for entry in new_tools:
        py_name = entry.get("py_name")
        tool_name = entry.get("tool_name")
        if not py_name or not tool_name:
            continue
        fn = _make_tool_fn(tool_name, py_name)
        SCRIPT_GLOBALS[py_name] = fn
        tools_dict[tool_name] = fn
        new_py_names.add(py_name)
    for stale in _injected_py_names - new_py_names:
        SCRIPT_GLOBALS.pop(stale, None)
    _injected_py_names.clear()
    _injected_py_names.update(new_py_names)
    # Exact-name escape hatch: tools["mcpl--server--tool"]({...})
    SCRIPT_GLOBALS["tools"] = tools_dict
    # The doorbell exists only in background mode — a foreground script's
    # agent is already awake (mid-turn).
    if BACKGROUND:
        SCRIPT_GLOBALS["wake_agent"] = wake_agent
    else:
        SCRIPT_GLOBALS.pop("wake_agent", None)


async def _run_script(exec_id, code, st):
    global _current_exec_id, _current_exec_task, _stop
    if BACKGROUND:
        out = LogTee(LOG_PATH, TAIL_CHARS)
        err = out  # interleave, terminal-style; tail is shared
    else:
        out = CappedIO(OUTPUT_CAP_CHARS)
        err = CappedIO(OUTPUT_CAP_CHARS)
    old_out, old_err, old_in = sys.stdout, sys.stderr, sys.stdin
    sys.stdout, sys.stderr = out, err
    sys.stdin = io.StringIO("")  # input() must not steal the protocol channel
    return_code = 0
    try:
        compiled = compile(code, "<script>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        st.running = True
        try:
            if st.state == _REQUESTED:
                # Stopped before it started (row 8).
                st.state = _DELIVERED
                raise asyncio.CancelledError()
            result = eval(compiled, SCRIPT_GLOBALS)
            if inspect.iscoroutine(result):
                await result
        finally:
            st.running = False
    except asyncio.CancelledError:
        err.write("\nKeyboardInterrupt: script cancelled by host\n")
        return_code = 1
    except BaseException as exc:
        if exc is st.interrupt:
            # Where the script was when it was stopped, without the runtime's frames.
            frames = [
                f for f in traceback.extract_tb(exc.__traceback__)
                if f.filename != _RUN_SCRIPT_CODE.co_filename
            ]
            err.write("Traceback (most recent call last):\n")
            err.write("".join(traceback.format_list(frames)))
            err.write("KeyboardInterrupt: script interrupted by host\n")
        else:
            traceback.print_exc(file=err)
        return_code = 1
    finally:
        sys.stdout, sys.stderr, sys.stdin = old_out, old_err, old_in
        st.interrupt = None
        if _stop is st:
            _stop = None
        _current_exec_id = None
        _current_exec_task = None
        for fut in list(_pending_tool_futures.values()):
            if not fut.done():
                fut.cancel()
        _pending_tool_futures.clear()
        for fut in list(_pending_wake_futures.values()):
            if not fut.done():
                fut.cancel()
        _pending_wake_futures.clear()

    if BACKGROUND:
        out.flush()
        out.close()
        send({
            "op": "exec_result",
            "id": exec_id,
            "stdout": "",
            "stderr": "",
            "tail": out.tail(),
            "return_code": return_code,
        })
        return

    stdout_text = out.getvalue()
    if out.truncated:
        stdout_text += "\n[stdout truncated at " + str(OUTPUT_CAP_CHARS) + " chars]"
    stderr_text = err.getvalue()
    if err.truncated:
        stderr_text += "\n[stderr truncated at " + str(OUTPUT_CAP_CHARS) + " chars]"
    send({
        "op": "exec_result",
        "id": exec_id,
        "stdout": stdout_text,
        "stderr": stderr_text,
        "return_code": return_code,
    })


def _dispatch(msg):
    """Handle one protocol message from the host; False means stop reading."""
    global _current_exec_id, _current_exec_task, _stop
    op = msg.get("op")
    if op == "init":
        handle_init(msg)
    elif op == "exec":
        if _current_exec_task is not None and not _current_exec_task.done():
            send({
                "op": "exec_result",
                "id": msg.get("id"),
                "stdout": "",
                "stderr": "RuntimeError: another script is already running in this interpreter",
                "return_code": 1,
            })
            return True
        # Everything _on_sigint reads is in place before the script can run
        # (row 13). The task is built directly, not through the loop's task
        # factory: a script may have installed one (interpreter state
        # persists), and an eager one would run the next script inside this
        # call, before the assignments below.
        st = _ScriptStop()
        _stop = st
        _current_exec_id = msg.get("id")
        _current_exec_task = asyncio.Task(
            _run_script(msg.get("id"), msg.get("code") or "", st),
            loop=asyncio.get_running_loop(),
        )
        st.task = _current_exec_task
    elif op == "tool_result":
        _resolve(_pending_tool_futures.get(msg.get("id")), str(msg.get("result", "")))
    elif op == "wake_ack":
        _resolve(_pending_wake_futures.get(msg.get("id")), msg.get("error") or None)
    elif op == "cancel":
        _deliver_cancel(_stop)
    elif op == "exit":
        return False
    return True


async def main():
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()

    def reader():
        for raw_line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, raw_line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    # The reader thread blocks SIGINT (it inherits the mask while it starts),
    # so the signal reaches the main thread, where a blocking call in the
    # script is waiting to be interrupted.
    masked = hasattr(signal, "pthread_sigmask") and hasattr(signal, "SIGINT")
    if masked:
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
    try:
        threading.Thread(target=reader, daemon=True).start()
    finally:
        if masked:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    send({"op": "ready"})

    while True:
        line = await queue.get()
        if line is None:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            REAL_STDERR.write("[pytc-runtime] bad protocol line\n")
            REAL_STDERR.flush()
            continue
        if not _dispatch(msg):
            break

    # Drain: give a cancelled exec a moment to emit its exec_result.
    if _current_exec_task is not None and not _current_exec_task.done():
        _current_exec_task.cancel()
        try:
            await asyncio.wait_for(_current_exec_task, timeout=2)
        except BaseException:
            pass


# At the deadline the host sends a cancel op, which lands only when the script
# awaits: a script blocked in time.sleep(), a busy loop or a blocking read
# never gives the event loop control back. So the host also sends SIGINT,
# repeated until the script reports, and this stops the script through its
# _ScriptStop (see the table there):
#   - With the script's own code on the stack (_run_script's frame, reached
#     before any send frame), it raises KeyboardInterrupt there; _run_script
#     catches it, so the output so far and the interpreter's globals survive.
#     Checking the current task instead is not enough: asyncio runs its own
#     code for the task between steps, and an exception raised there escapes
#     the event loop and ends the interpreter.
#   - Anywhere else it only queues the cancellation on the loop (which also
#     wakes select(), otherwise resuming its wait after a signal): cancelling
#     here could cancel a future between main()'s done() check and its
#     set_result, and an exception mid-send would tear a protocol line.
_RUN_SCRIPT_CODE = _run_script.__code__
_SEND_CODE = send.__code__


def _on_sigint(signum, frame):
    st = _stop
    if st is None or st.state == _DELIVERED:
        return
    if st.running:
        while frame is not None:
            code = frame.f_code
            if code is _SEND_CODE:
                break
            if code is _RUN_SCRIPT_CODE:
                st.state = _DELIVERED
                st.interrupt = KeyboardInterrupt("script interrupted by host")
                raise st.interrupt
            frame = frame.f_back
    if st.state == _PENDING:
        st.state = _REQUESTED
        if st.running:
            st.task.get_loop().call_soon_threadsafe(_deliver_cancel, st)


if __name__ == "__main__":
    # A handler of our own also keeps asyncio.run from installing one that
    # would cancel main() and end the interpreter.
    if hasattr(signal, "SIGINT"):
        try:
            signal.signal(signal.SIGINT, _on_sigint)
        except (ValueError, OSError):
            pass
    asyncio.run(main())
`;
