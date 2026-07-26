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
 * Embedded as a TS string because tsc does not copy non-TS assets to dist/;
 * PyRunner materializes it to a temp file at spawn.
 *
 * Protocol (JSON lines):
 *   host -> py : {op:"init", tools:[{py_name,tool_name}], call_timeout_s}
 *                {op:"exec", id, code}
 *                {op:"tool_result", id, result}
 *                {op:"cancel", id, reason?}
 *   py -> host : {op:"ready"}
 *                {op:"tool_call", id, exec_id, name, args}
 *                {op:"exec_result", id, stdout, stderr, return_code}
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
import sys
import threading
import traceback

PROTO_OUT = sys.stdout          # protocol channel (real stdout)
REAL_STDERR = sys.stderr        # runtime diagnostics outside execs
CALL_TIMEOUT_S = 270.0
OUTPUT_CAP_CHARS = 2_000_000

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


# Persistent interpreter state (mirrors container reuse: variables survive
# between exec calls until the host reclaims the interpreter).
SCRIPT_GLOBALS = {"__name__": "__main__", "__builtins__": __builtins__}
_injected_py_names = set()

_pending_tool_futures = {}
_next_tool_call_id = 0
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


def handle_init(msg):
    global CALL_TIMEOUT_S
    timeout = msg.get("call_timeout_s")
    if isinstance(timeout, (int, float)) and timeout > 0:
        CALL_TIMEOUT_S = float(timeout)

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


async def _run_script(exec_id, code):
    global _current_exec_id, _current_exec_task
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
        # Fail any tool futures still pending: their exec is gone.
        for fut in list(_pending_tool_futures.values()):
            if not fut.done():
                fut.cancel()
        _pending_tool_futures.clear()

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
