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


async def _run_script(exec_id, code):
    global _current_exec_id, _current_exec_task
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
        result = eval(compiled, SCRIPT_GLOBALS)
        if inspect.iscoroutine(result):
            await result
    except asyncio.CancelledError:
        err.write("\nKeyboardInterrupt: script cancelled by host\n")
        return_code = 1
    except BaseException:
        traceback.print_exc(file=err)
        return_code = 1
    finally:
        sys.stdout, sys.stderr, sys.stdin = old_out, old_err, old_in
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


async def main():
    global _current_exec_id, _current_exec_task
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()

    def reader():
        for raw_line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, raw_line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()
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
                continue
            _current_exec_id = msg.get("id")
            _current_exec_task = asyncio.ensure_future(
                _run_script(msg.get("id"), msg.get("code") or "")
            )
        elif op == "tool_result":
            fut = _pending_tool_futures.get(msg.get("id"))
            if fut is not None and not fut.done():
                fut.set_result(str(msg.get("result", "")))
        elif op == "wake_ack":
            fut = _pending_wake_futures.get(msg.get("id"))
            if fut is not None and not fut.done():
                fut.set_result(msg.get("error") or None)
        elif op == "cancel":
            if _current_exec_task is not None and not _current_exec_task.done():
                _current_exec_task.cancel()
        elif op == "exit":
            break

    # Drain: give a cancelled exec a moment to emit its exec_result.
    if _current_exec_task is not None and not _current_exec_task.done():
        _current_exec_task.cancel()
        try:
            await asyncio.wait_for(_current_exec_task, timeout=2)
        except BaseException:
            pass


if __name__ == "__main__":
    asyncio.run(main())
`;
