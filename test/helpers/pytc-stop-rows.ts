/**
 * Python driver for the code_execution runtime's stop table (runtime-py.ts,
 * _ScriptStop): it loads the runtime as a module and drives its own dispatch
 * and SIGINT handler, landing the signal (or the cancel op) at exact points.
 * Prints one JSON object: row name -> {rc, tail, secs, ops}.
 *
 * Usage: python3 driver.py <runtime.py>
 * Must not contain backticks or dollar+brace (TS template literal).
 */
export const PYTC_STOP_ROWS_DRIVER: string = String.raw`
import asyncio, importlib.util, io, json, signal, sys, threading, time
spec = importlib.util.spec_from_file_location("pytc_runtime", sys.argv[1])
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)
signal.signal(signal.SIGINT, rt._on_sigint)
MAIN = threading.main_thread().ident


class Proto(io.StringIO):
    hook = None  # (marker, fn): fn runs inside the write of the line containing marker

    def write(self, s):
        hook = Proto.hook
        if hook and hook[0] in s:
            Proto.hook = None
            hook[1]()
        return super().write(s)


def sigint_here():
    # The signal lands at this point: the handler runs with the caller's frame.
    rt._on_sigint(signal.SIGINT, sys._getframe(1))


def sigint_after(seconds):
    # A real signal to the main thread, wherever it is by then.
    threading.Timer(seconds, signal.pthread_kill, (MAIN, signal.SIGINT)).start()


async def wake_future():
    while not rt._pending_wake_futures:
        await asyncio.sleep(0.005)
    return next(iter(rt._pending_wake_futures.values()))


async def run(code, steps=None, before=None, hook=None, before_exec=None):
    rt.PROTO_OUT = Proto()
    Proto.hook = hook
    rt._dispatch({"op": "init", "tools": [{"py_name": "t", "tool_name": "t"}], "background": True})
    if before_exec:
        before_exec()
    started = time.time()
    rt._dispatch({"op": "exec", "id": "e", "code": code})
    if before:
        before()
    if steps:
        await steps()
    for _ in range(600):
        lines = [json.loads(l) for l in rt.PROTO_OUT.getvalue().splitlines()]
        done = [m for m in lines if m["op"] == "exec_result"]
        if done and rt._current_exec_task is None:
            break
        await asyncio.sleep(0.01)
    return {"rc": done[0]["return_code"] if done else None, "tail": done[0]["tail"] if done else "",
            "secs": round(time.time() - started, 2), "ops": [m["op"] for m in lines]}


async def signal_after(seconds):
    sigint_after(seconds)


async def reply_behind():
    fut = await wake_future()
    if not fut.done():  # main()'s check ...
        sigint_here()
        fut.set_result(None)  # ... and its set_result


async def reply_ahead(then=None):
    fut = await wake_future()
    fut.set_result(None)
    sigint_here()
    if then:
        then()


async def cancel_op_first():
    await asyncio.sleep(0.1)
    rt._dispatch({"op": "cancel"})
    await asyncio.sleep(0.05)
    sigint_here()
    sigint_after(0.05)


async def after_delivery():
    sigint_after(0.1)
    await asyncio.sleep(0.25)
    rt._dispatch({"op": "cancel"})
    sigint_here()
    sigint_after(0.02)


CLEANUP_AFTER_INTERRUPT = "import time, asyncio\ntry:\n    time.sleep(5)\nexcept KeyboardInterrupt:\n    await asyncio.sleep(0.3)\n    print('cleaned')"
ROWS = {
    "1 own code": lambda: run("import time\nprint('a')\ntime.sleep(5)\nprint('b')",
                              steps=lambda: signal_after(0.2)),
    "2 waiting on an await": lambda: run("import asyncio\nawait asyncio.sleep(5)\nprint('b')",
                                         steps=lambda: signal_after(0.2)),
    "3 mid-dispatch, reply behind": lambda: run("await wake_agent({})\nprint('woke')", steps=reply_behind),
    "4 protocol write": lambda: run("await t({})\nprint('b')", hook=('"tool_call"', sigint_here)),
    "5 reply ahead, then await": lambda: run(
        "import asyncio\nawait wake_agent({})\nprint('woke')\nawait asyncio.sleep(5)\nprint('b')", steps=reply_ahead),
    "6 reply ahead, then block": lambda: run(
        "await wake_agent({})\nprint('woke')\n" + CLEANUP_AFTER_INTERRUPT,
        steps=lambda: reply_ahead(lambda: sigint_after(0.3))),
    "7 reply ahead, then finish": lambda: run("await wake_agent({})\nprint('woke')", steps=reply_ahead),
    "7 next script": lambda: run("import asyncio\nawait asyncio.sleep(0.2)\nprint('ok')"),
    "8 before start, signal": lambda: run("print('ran')", before=sigint_here),
    "8 before start, cancel op": lambda: run("print('ran')", before=lambda: rt._dispatch({"op": "cancel"})),
    "9 cancel op first": lambda: run(
        "import asyncio\ntry:\n    await asyncio.sleep(5)\nexcept asyncio.CancelledError:\n    await asyncio.sleep(0.3)\n    print('cleaned')",
        steps=cancel_op_first),
    "10 after delivery": lambda: run(CLEANUP_AFTER_INTERRUPT, steps=after_delivery),
    "11 reporting": lambda: run("print('done')", hook=('"exec_result"', sigint_here)),
    "12 between scripts": lambda: run("print('ok')", before_exec=sigint_here),
}
if sys.version_info >= (3, 12):  # last: the factory stays installed on the loop
    ROWS["13 eager task factory installed"] = lambda: run(
        "import asyncio\nasyncio.get_running_loop().set_task_factory(asyncio.eager_task_factory)\nprint('installed')")
    ROWS["13 next script blocks"] = lambda: run(
        "import time\nprint('a')\ntime.sleep(5)\nprint('b')", steps=lambda: signal_after(0.2))


async def main():
    out = {}
    for name, row in ROWS.items():
        out[name] = await row()
    print(json.dumps(out))


asyncio.run(main())
`;
