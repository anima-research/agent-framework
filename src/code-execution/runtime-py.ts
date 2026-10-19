/**
 * Python runtime for client-side programmatic tool calling (PTC).
 *
 * This is the interpreter-side half of the `code_execution` tool: a small
 * asyncio REPL that mimics the environment Anthropic's server-side PTC was
 * trained on (see docs/en/agents-and-tools/tool-use/programmatic-tool-calling):
 *
 *   - scripts run with top-level `await` (PyCF_ALLOW_TOP_LEVEL_AWAIT)
 *   - host tools are injected as async functions taking a single dict and
 *     returning the tool_result text as a str (ToolResult), which also
 *     carries .is_error and .structured
 *   - a pending tool call that gets no response raises TimeoutError, opening
 *     with the message the managed runtime produces and saying the call may
 *     still take effect; the runtime tells the host (tool_unwaited)
 *   - interpreter globals persist across execs (container-reuse semantics)
 *
 * BACKGROUND MODE (model-authored daemons): when init carries
 * `background: true`, the exec additionally gets:
 *   - `wake_agent(payload)` — async; reports the caller's line number (which
 *     indexes into the agent-authored script — self-correlation) and delivers
 *     the payload to the host, which injects it into the agent's context and
 *     triggers inference. Awaits a host ack so rate limiting backpressures
 *     inside the script instead of dropping wakes.
 *   - its stderr joined to its stdout (fd 2 onto fd 1's pipe), so the host's
 *     journal of its output (a log file the agent can read, and a tail for the
 *     crash envelope) holds their lines in the order they were written. The
 *     runtime's own lines and faulthandler's traceback go to that pipe too, so
 *     a crash's text comes after the lines the script wrote before it; a
 *     partial line still in a script's writer is lost with the process.
 *
 * OUTPUT. The protocol has file descriptors of its own: the host opens the
 * runtime's fds 3 (host -> py) and 4 (py -> host), which the runtime makes
 * non-inheritable as it starts, so no command a script runs is given them. fd 0
 * is /dev/null, and fds 1 and 2 are pipes the host reads itself: a script's
 * prints, line by line, and the output of every command it runs go there in
 * the order written, and what reaches them reaches the host whatever then
 * happens to the interpreter. A partial line waits in the script's writer for
 * its newline, a flush or the exec's end, as Python's stdout does on a
 * terminal, and a command writing at the same moment as a long write can land
 * between its parts. The host gives each exec what arrived on each stream
 * before that exec's end mark (the exec op's `mark`), which the runtime writes
 * into both streams once the script has returned; each stream is first in,
 * first out, so what the script and the commands it waited for wrote is ahead
 * of it. Nothing a script or a command does with fds 0, 1 or 2 reaches the
 * protocol, short of pointing them at the runtime's channel, fds 3 and 4,
 * which can garble its messages while the script runs and, through a command
 * started holding the channel, for as long as that command runs. A garbled
 * exec_result leaves its script waiting out its time limit and the grace, and
 * the interpreter is restarted, so the next script's variables are gone. The
 * runtime puts fds 0, 1 and 2 back as the host set them, blocking, at each
 * exec's start, and puts back fd 1 or 2 pointed at the channel at the script's
 * end too, before anything is flushed (_off_channel). Its own fds (3 and 4, and its copies of 0, 1 and 2) it
 * checks at each exec's start and end, and fd 4 before each message: one a
 * script closed or replaced ends the interpreter, saying which
 * (_check_own_fds). So does a message or an end mark that can't be written, as
 * after a script shuts down the socket under fd 4 or an output pipe, which
 * leaves the fd as it was (send, _write_marks).
 *
 * Embedded as a TS string because tsc does not copy non-TS assets to dist/;
 * PyRunner materializes it to a temp file at spawn.
 *
 * Protocol (JSON lines, on fds 3 and 4):
 *   host -> py : {op:"init", tools:[{py_name,tool_name}], call_timeout_s,
 *                 background?}
 *                {op:"exec", id, code, mark}
 *                {op:"tool_result", id, result, is_error?, structured_json?}
 *                {op:"wake_ack", id, error?}
 *                {op:"cancel", id, reason?}
 *                {op:"exit"}   stops the runtime: a running script is
 *                              cancelled at its next await, one blocked in
 *                              synchronous code runs on until then (a host
 *                              that can't wait sends SIGINT, as at a time
 *                              limit), and it exits 0. It goes alone on a
 *                              line under 100 characters, as {"op":"exit"}
 *                              does: the reader thread looks for it only in
 *                              such lines. A host that closes fd 3 instead
 *                              while a script runs gets exit code 70 and the
 *                              line "cannot read the host's messages any
 *                              more: a script closed, shut down or replaced
 *                              fd 3, where they arrive", since the runtime
 *                              can't tell that from a script's own shutdown
 *                              of the socket under fd 3.
 *   py -> host : {op:"ready"}
 *                {op:"tool_call", id, exec_id, name, args}   exec_id
 *                              is the exec running when it was sent, or
 *                              null between scripts; PyRunner files a
 *                              call by when it reads it instead
 *                {op:"tool_unwaited", id, cause}   the code that
 *                              made that call stopped waiting for it, before
 *                              it saw an answer: at call_timeout_s, with
 *                              TimeoutError (cause "timeout"), or because
 *                              the script cancelled it ("cancelled"), not
 *                              when the host stopped the script or the
 *                              runtime cancelled the call at its end; the
 *                              call may still be running
 *                {op:"wake", id, exec_id, line, payload}
 *                {op:"exec_result", id, return_code}
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
import faulthandler
import functools
import inspect
import io
import json
import os
import re
import select
import signal
import stat
import sys
import threading
import traceback
import weakref

CALL_TIMEOUT_S = 270.0
BACKGROUND = False

# A process a script forks has the runtime's state too; at its script's end
# it leaves, since the exec and its result are the runtime's (_run_script).
_RUNTIME_PID = os.getpid()

# The protocol's own channel, fds 3 and 4 as the host opened them (_start).
PROTO_IN = None
PROTO_OUT = None

# Private copies of fds 0, 1 and 2 as the host set them up: /dev/null, and the
# two output pipes the host reads (_take_std_fds). Each exec puts fds 0, 1 and 2
# back from them, whatever an earlier script did with its own, and writes its
# end marks through them. os.dup's copies are non-inheritable, so no command a
# script runs holds them.
_STD_IN = None
_STD_OUT = None
_STD_ERR = None

# The runtime's own fds, as it found them: fd -> (what losing it stops, which
# fd it is, what it was). A script can close or replace any of them (os.close,
# os.dup2), so each exec's start and end checks them (_check_own_fds).
_OWN_FDS = {}

# Every writer the runtime gave a script, which a script can keep past its
# exec (a logging handler keeps sys.stderr): each exec's end flushes them all,
# so a partial line goes out in the exec that wrote it.
_script_writers = weakref.WeakSet()

_send_lock = threading.Lock()

# A str can hold a lone surrogate, which UTF-8 can't encode: on POSIX,
# os.fsdecode makes one of each byte in a filename that doesn't decode as
# UTF-8, and json.loads makes one of a "\ud800" escape. The protocol's channel
# is strict UTF-8 (_start), so writing one would fail the whole message, and a
# tool call or a wake carrying one would never reach the host. Each goes as
# U+FFFD. What a script prints shows it escaped, as backslashreplace writes
# it (_script_writer).
_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


def send(obj):
    line = _LONE_SURROGATE.sub("\ufffd", json.dumps(obj, ensure_ascii=False, default=str))
    with _send_lock:
        # A script can close or replace fd 4 before a tool call, as well as
        # before its end, so each message checks it first.
        _check_own_fd(4)
        try:
            PROTO_OUT.write(line + "\n")
            PROTO_OUT.flush()
        except OSError as exc:
            # fd 4 is still the host's, so the socket under it broke: a script
            # shut it down, or the host's end is gone. Nothing more reaches it.
            _fatal(_lost(4) + " (" + str(exc) + ")")


def _start():
    global PROTO_IN, PROTO_OUT
    # A wrapper between the host and this interpreter can close fds 3 and 4
    # (a container, or sudo with its default settings, does): say so where the
    # host reads, for a failed start that names what to fix, and stop with
    # EX_CONFIG (78), which tells the host that calling again won't help
    # (HOST_CHANNEL_MISSING_EXIT in py-runner.ts).
    missing = []
    for fd in (3, 4):
        try:
            os.fstat(fd)
        except OSError:
            missing.append(fd)
    if missing:
        which = ("its file descriptors 3 and 4 aren't open" if len(missing) == 2
                 else "its file descriptor " + str(missing[0]) + " isn't open")
        try:
            os.write(2, (
                "The host's channel didn't reach this Python interpreter: " + which + ", as when the "
                "host's pythonPath starts Python through a wrapper that doesn't pass both file descriptors "
                "3 and 4 on, such as a container, or sudo with its default settings. code_execution can't "
                "run scripts here until whoever runs this host changes that, so calling it again fails "
                "the same way.\n"
            ).encode())
        except OSError:
            pass
        sys.exit(78)
    # fds 3 and 4 came from the host inheritable; no command a script runs may
    # hold them, or read the host's messages.
    os.set_inheritable(3, False)
    os.set_inheritable(4, False)
    _own(3, "cannot read the host's messages any more", "fd 3, where they arrive")
    _own(4, "cannot send the host a message any more", "fd 4, where they go")
    PROTO_IN = open(3, "r", encoding="utf-8", newline="\n")
    PROTO_OUT = open(4, "w", encoding="utf-8", newline="\n")
    # Between scripts, a thread a script left running prints through these:
    # a lone surrogate is escaped there, as in a script's own writers, rather
    # than raising in the thread (PYTHONIOENCODING names no handler).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")
        except Exception:
            pass
    _take_std_fds()


def _take_std_fds():
    global _STD_IN, _STD_OUT, _STD_ERR
    _STD_IN, _STD_OUT, _STD_ERR = os.dup(0), os.dup(1), os.dup(2)
    _own(_STD_IN, "cannot give scripts their stdin any more", "the runtime's copy of fd 0")
    _own(_STD_OUT, "cannot reach the output pipes any more", "the runtime's copy of fd 1")
    _own(_STD_ERR, "cannot reach the output pipes any more", "the runtime's copy of fd 2")
    _enable_faulthandler(_STD_ERR)


def _enable_faulthandler(fd):
    # A crash's own text goes where the host reads it, a pipe that outlives the
    # process: faulthandler adds a traceback for a segfault or an abort, where
    # CPython alone writes nothing. Python 3.14 adds the C stack after it,
    # native frames a script can't act on, which would push the error's own
    # line out of the end of it that the host logs, so it's left out.
    faulthandler.enable(file=fd, all_threads=False,
                        **({"c_stack": False} if sys.version_info >= (3, 14) else {}))


def _identity(fd):
    # Which file the fd is: its type, device and inode. Not its whole mode:
    # macOS's fstat sets a socket's permission bits from its state, so they
    # change when its write side is shut down or its peer ends it, as when a
    # host ends fd 3 after the exit op, while the fd is still the runtime's own.
    st = os.fstat(fd)
    return (stat.S_IFMT(st.st_mode), st.st_dev, st.st_ino)


def _own(fd, stops, which):
    _OWN_FDS[fd] = (stops, which, _identity(fd))


def _lost(fd):
    # The runtime's line for one of its own fds that it can't use any more, in
    # the words the host's advice reads the fd from (fdTakenFromRuntime in
    # py-runner.ts): a script closed or replaced it, or shut down the socket
    # under it, which only a failed write shows.
    stops, which, _ = _OWN_FDS[fd]
    return stops + ": a script closed, shut down or replaced " + which


def _check_own_fd(fd):
    # A script closed or replaced one of the runtime's own fds: say which and
    # end, before the runtime writes to a file that isn't its own any more.
    own = _OWN_FDS.get(fd)
    if own is None:
        return
    try:
        same = _identity(fd) == own[2]
    except OSError:
        same = False
    if not same:
        _fatal(_lost(fd))


def _check_own_fds():
    for fd in list(_OWN_FDS):
        _check_own_fd(fd)


def _diag(text):
    # A note of the runtime's own for the host's log, through fd 2's copy or,
    # if a script closed or replaced that, fd 2 itself, and only while it's
    # one of the two outputs the host gave the runtime, as the runtime found
    # them at its start: a note never goes into a file a script put in its
    # place. A background script's journal is one stream, stdout's pipe, so
    # there the note goes through fd 1's copy first, after the lines the
    # script wrote before it. It waits for room on a pipe a command left non-blocking,
    # as the marks do (_write_some).
    data = ("[pytc-runtime] " + text + "\n").encode("utf-8", "backslashreplace")
    pipes = [_OWN_FDS[fd][2] for fd in (_STD_OUT, _STD_ERR) if fd in _OWN_FDS]
    for fd in ((_STD_OUT, 2, _STD_ERR) if BACKGROUND else (_STD_ERR, 2)):
        try:
            if fd is not None and _identity(fd) in pipes:
                _write_all(fd, data)
                return
        except OSError:
            pass


def _write_some(fd, data):
    # A command can leave the output pipes non-blocking: they're one open file
    # with the runtime's fds 1 and 2 and its copies. A full pipe then waits for
    # room, where a bare write would raise BlockingIOError.
    while True:
        try:
            return os.write(fd, data)
        except BlockingIOError:
            select.select([], [fd], [])


def _write_all(fd, data):
    while data:
        data = data[_write_some(fd, data):]


class _FdWriter(io.RawIOBase):
    # A script's fd 1 or 2 by number (_write_some), which closing never closes.
    def __init__(self, fd):
        super().__init__()
        self._fd = fd
        # Set while _drop_held empties the writer above it.
        self.dropping = False

    def writable(self):
        return True

    def fileno(self):
        return self._fd

    def write(self, data):
        if self.dropping:
            return len(data)
        return _write_some(self._fd, data)


def _script_writer(fd):
    # Line-buffered, as Python's own stdout is on a terminal: each line reaches
    # the host as it's printed, in order with what the commands a script runs
    # write, for one write per line. A partial line waits for its newline, a
    # flush or the end of the exec. It writes to the fd by number, so one an
    # earlier script kept, such as a logging handler's, writes into the exec
    # that's running.
    writer = io.TextIOWrapper(io.BufferedWriter(_FdWriter(fd)), encoding="utf-8",
                              errors="backslashreplace", newline="\n", line_buffering=True)
    _script_writers.add(writer)
    return writer


def _open_streams():
    # fds 0, 1 and 2 as the host set them, whatever the last script did.
    os.dup2(_STD_IN, 0)
    os.dup2(_STD_OUT, 1)
    # A background script's journal is one stream: its stderr joins its stdout's
    # pipe, so their lines keep the order they were written in.
    os.dup2(_STD_OUT if BACKGROUND else _STD_ERR, 2)
    # And blocking, as the host set them: O_NONBLOCK belongs to a pipe's open
    # file, which dup2 doesn't touch, so one a command set would reach every
    # later script and command.
    os.set_blocking(_STD_OUT, True)
    os.set_blocking(_STD_ERR, True)
    return _script_writer(1), _script_writer(2)


def _off_channel():
    # A script can point its fd 1 or 2 at the runtime's own channel, as with
    # os.dup2(4, 1). What its writers still hold would then go into the channel
    # ahead of the script's result, which the host couldn't read, and the exec
    # would wait out its time limit. So at the script's end, before anything is
    # flushed, one that is fd 3 or fd 4 goes back to its pipe, as each exec's
    # start puts it (_open_streams). What a script or its commands write onto
    # the channel, or read from it, can still garble the runtime's messages: the
    # script's own while it runs, and, from a command it started holding the
    # channel, a later script's for as long as that command runs. A script
    # whose exec_result is garbled waits out its time limit and the grace, and
    # the interpreter is restarted. Only a channel per script would end that.
    # A copy a script closed or replaced is left alone, so nothing goes into
    # a file of the script's: the check at the exec's end ends the runtime.
    channel = [_OWN_FDS[fd][2] for fd in (3, 4) if fd in _OWN_FDS]
    for fd, pipe in ((1, _STD_OUT), (2, _STD_OUT if BACKGROUND else _STD_ERR)):
        try:
            if _identity(fd) in channel and _identity(pipe) == _OWN_FDS[pipe][2]:
                os.dup2(pipe, fd)
        except OSError:
            pass


def _note(stream, text):
    # The runtime's own line in a script's stream, which may have broken under
    # it, or whose write the script may have replaced with its own, which may
    # raise anything, SystemExit included: the line then goes through the
    # runtime's own note (_diag), and the exec's end goes on.
    try:
        stream.write(text)
    except BaseException:
        _diag(text.strip("\n"))


def _flush_writers():
    # Send what the script left in its writers, the ones it kept from earlier
    # execs too, at the exec's end and before a fork. A script can put its own
    # code in one, as by replacing its flush, which may raise anything,
    # SystemExit included: what it raises is said, but for the ValueError
    # _flush takes as a closed writer, and the exec's end or the fork goes on,
    # as for a script's own object (_flush_script_streams).
    for writer in list(_script_writers):
        try:
            _flush(writer)
        except BaseException as exc:
            _diag("some of what the script wrote couldn't be sent (" + _said(exc) + ")")


def _flush_script_streams():
    # What a script left in a wrapper of its own that it put in sys.stdout or
    # sys.stderr goes out in its exec, as Python flushes them at exit. The
    # runtime's own writers are _flush_writers', and a wrapper the script
    # keeps anywhere else is its own. Compared by identity: the weak set's
    # membership test would hash the object, which a script's may refuse.
    writers = list(_script_writers)
    for stream in (sys.stdout, sys.stderr):
        # A script's own object runs its own code here, which may raise
        # anything, SystemExit included: it's said, and the exec's end goes on.
        # A closed one's ValueError is passed over, as _flush passes over the
        # runtime's own: closing it flushed what it held.
        try:
            if any(stream is w for w in writers) or not callable(getattr(stream, "flush", None)):
                continue
            _flush(stream)
        except BaseException as exc:
            _diag("some of what the script wrote couldn't be sent (" + _said(exc) + ")")


def _said(exc):
    # An exception's text, or its type's name when it has none, as SystemExit()
    # hasn't, or when a script's own exception class refuses to give it. None
    # of the script's code runs past the try: the text is taken as an exact str,
    # since a str subclass's own methods run on truth and concatenation, and the
    # name comes through type's own descriptor, as _brief's does, so a
    # metaclass's doesn't run, and as an exact str too, since a script can set
    # a class's __name__ to a str subclass.
    try:
        text = str.__str__(str(exc))
    except BaseException:
        text = ""
    return text or str.__str__(type.__dict__["__name__"].__get__(type(exc)))


def _flush(writer):
    try:
        writer.flush()
    except ValueError:
        # A script closed or detached it, or the stream under it: nothing more
        # goes through it. A script that closed or detached the writer itself
        # flushed it then, and saw any failure of that flush; one that closed
        # the stream under it dropped what the writer held, which can't be told
        # from nothing here. A ValueError from a flush the script put in its
        # place is taken the same way.
        return
    except BaseException as exc:
        # Its fd closed or broke under it, or the script's own flush in its place
        # raised, so that much can't be sent. Dropped,
        # it can't go out later, once the fd is back, in another exec's output,
        # where a writer the script kept would flush it: a writer over the
        # runtime's raw writer is (_drop_held), and what a file of the script's
        # own holds stays its own, as with any file a script keeps.
        _drop_held(writer)
        _diag("some of what the script wrote couldn't be sent (" + _said(exc) + ")")


def _drop_held(writer):
    # Empty a writer whose flush failed, and leave it usable: one of the
    # runtime's, or a script's own wrapper over the runtime's raw writer,
    # through the runtime's buffer, as TextIOWrapper(sys.stdout.detach())
    # makes, or through a buffer of its own. Emptying one writer leaves
    # another wrapper's own buffer as it is; one that shares this writer's
    # buffer, as TextIOWrapper(sys.stdout.buffer) does, loses with it what it
    # put there, under the same note.
    raw = getattr(getattr(writer, "buffer", None), "raw", None)
    if not isinstance(raw, _FdWriter):
        return
    # Through the type's own flush, since a script may have put a flush of
    # its own on the writer, which is what failed.
    raw.dropping = True
    try:
        type(writer).flush(writer)
    finally:
        raw.dropping = False


def _before_fork():
    _flush_script_streams()
    _flush_writers()


if hasattr(os, "register_at_fork"):
    # A fork copies what the script's writers hold, and what its own wrappers
    # in sys.stdout and sys.stderr hold. Sent first, it reaches the host once,
    # and a forked child's writers hold only what the child writes. A wrapper
    # the script keeps anywhere else is its own, at a fork as at its end, as
    # any buffered file a Python program forks with is.
    os.register_at_fork(before=_before_fork)


def _write_marks(mark):
    # End this exec's share of each stream with its mark: everything the
    # script wrote, and all of every command it waited for, is ahead of it.
    # A mark that can't be written, on a fd the check before it passed, as
    # after a script shut down the socket under fd 1 or 2, ends the
    # interpreter, which settles the exec rather than leave it waiting out
    # its time limit for the mark.
    # The stream the runtime's notes go to gets its mark last, so the line
    # _fatal writes when the other's can't be written is still in this exec's
    # share: stderr's, or a background script's journal, stdout's (_diag).
    data = mark.encode("utf-8")
    for fd in ((_STD_ERR, _STD_OUT) if BACKGROUND else (_STD_OUT, _STD_ERR)):
        try:
            _write_all(fd, data)
        except OSError as exc:
            _fatal(_lost(fd) + " (" + str(exc) + ")")


def _fatal(why):
    # The runtime can't go on, as when a script closed one of the runtime's own
    # fds under it: say why through its copy of fd 2, which the host reads
    # unless a script replaced that too, or shut down the socket under it
    # (_diag), and end, so the host settles
    # the exec on the exit with the output that arrived, rather than waiting
    # out its time limit for a result that can't come.
    _diag(why + "; exiting")
    os._exit(70)


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
#  14. the flush before a fork the script makes -> queued, as in 4; the fork
#      goes on, and the cancellation lands at the script's next await, or the
#      next signal stops a script that blocks, as in 6
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


class ToolResult(str):
    """A tool's result: the string the tool gave, with two attributes.

    is_error: True if the result is an error, False if not, None if the
    host didn't say.
    structured: the parsed structuredContent of a structured result's JSON
    object, or None.
    """

    # Defaults, since pickle and copy rebuild a str subclass from its text
    # alone and then restore the attributes.
    def __new__(cls, text="", is_error=None, structured_json=False):
        self = str.__new__(cls, text)
        self.is_error = is_error
        self._structured_json = structured_json
        return self

    # Read from the string itself, the one copy sent, on first use only.
    @functools.cached_property
    def structured(self):
        if not self._structured_json:
            return None
        return json.loads(self).get("structuredContent")


def _resolve(fut, value):
    # Defense in depth: the script may have been cancelled since the lookup.
    if fut is not None and not fut.done():
        try:
            fut.set_result(value)
        except asyncio.InvalidStateError:
            pass


def _brief(value):
    # A value as a refusal shows it: by its type, such as <str>, which fails
    # loudly if copied rather than sending something else. The agent has its
    # values in the call it just wrote. No value's own code runs here: its
    # __repr__ isn't called, and its type is named through type's own
    # descriptor, so a metaclass's __name__ doesn't run either.
    return "<" + type.__dict__["__name__"].__get__(type(value)) + ">"


def _make_tool_fn(tool_name, py_name):
    async def tool_fn(*positional, **kwargs):
        global _next_tool_call_id
        if len(positional) > 1:
            raise TypeError(
                py_name + " wasn't called: a tool function takes one dict of "
                "arguments, such as await " + py_name + "({...}), and this call "
                "gave it " + str(len(positional)) + " positional arguments"
            )
        # args= on its own is the dict, as it has always been. Beside other
        # keywords it's one of them, since a tool such as utils has a field
        # of that name, so the suggested dict keeps it.
        if positional:
            args = positional[0]
        elif list(kwargs) == ["args"]:
            args = kwargs.pop("args")
        else:
            args = None
        if kwargs:
            if args is not None and not isinstance(args, dict):
                raise TypeError(
                    py_name + " wasn't called: a tool function takes one dict of "
                    "arguments, not keyword arguments, and this call also gave it "
                    + _brief(args) + ", so put every argument in one dict: await "
                    + py_name + "({...})"
                )
            # The likely intent is plain: the same arguments in one dict.
            meant = dict(args) if isinstance(args, dict) else {}
            meant.update(kwargs)
            # A key is what the agent has to write, so a str key is shown
            # whole up to 60 characters, as names are elsewhere; a longer one,
            # or any other key, is shown as a value is. A tool's result counts
            # as a str: ToolResult keeps str's repr, so no script code runs.
            shown = ", ".join((repr(k) if (type(k) is str or type(k) is ToolResult) and len(k) <= 60 else _brief(k)) + ": " + _brief(v)
                              for k, v in meant.items())
            raise TypeError(
                py_name + " wasn't called: a tool function takes one dict of "
                "arguments, not keyword arguments, so write await "
                + py_name + "({" + shown + "})"
            )
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise TypeError(
                py_name + " wasn't called: a tool function takes one dict of "
                "arguments, such as await " + py_name + "({...}), and this call "
                "gave it " + _brief(args)
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
            # The host keeps the call as one its code stopped waiting for,
            # which the result names, with the answer if one comes in time.
            send({"op": "tool_unwaited", "id": call_id, "cause": "timeout"})
            raise TimeoutError(
                "Calling tool ['" + tool_name + "'] timed out (no response after "
                + str(int(CALL_TIMEOUT_S)) + "s). The call was sent and may still "
                "take effect, so check for its effect before calling it again."
            )
        except asyncio.CancelledError:
            # The script's own code stopped waiting, as with a shorter
            # wait_for or a TaskGroup whose other task failed, and may call
            # again: the host names the call as after a timeout. A call whose
            # future the runtime cancelled at the script's end, which it took
            # out of the pending calls then, and a stop the host asked for are
            # the host's to know: their calls read as still running when the
            # script ended.
            if call_id in _pending_tool_futures and not (_stop is not None and _stop.state == _DELIVERED):
                send({"op": "tool_unwaited", "id": call_id, "cause": "cancelled"})
            raise
        finally:
            _pending_tool_futures.pop(call_id, None)
    tool_fn.__name__ = py_name
    tool_fn.__qualname__ = py_name
    tool_fn.__doc__ = (
        "Host tool '" + tool_name + "'. Takes a single dict of arguments and "
        "returns the tool result as a string, with .is_error and .structured "
        "beside it."
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
    global CALL_TIMEOUT_S, BACKGROUND
    timeout = msg.get("call_timeout_s")
    if isinstance(timeout, (int, float)) and timeout > 0:
        CALL_TIMEOUT_S = float(timeout)
    BACKGROUND = bool(msg.get("background"))
    # A background script's stderr joins its stdout's pipe (_open_streams), so
    # a crash's traceback goes there too, after the lines the script wrote first.
    _enable_faulthandler(_STD_OUT if BACKGROUND else _STD_ERR)

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


def _leave_forked(code, err):
    # A process the script forked ends on sys.exit() as Python ends: with its
    # code, 0 for none, or 1 after writing a code that isn't a number, and with
    # what it wrote sent. The atexit handlers are the parent's, so it skips
    # them, as multiprocessing's children do.
    if code is None:
        status = 0
    elif isinstance(code, int):
        status = code & 0xFF
    else:
        status = 1
        try:
            text = str(code) + "\n"
        except BaseException:
            text = ""
        _note(err, text)
    _flush_script_streams()
    _flush_writers()
    os._exit(status)


async def _run_script(exec_id, code, mark, st):
    global _current_exec_id, _current_exec_task, _stop
    _check_own_fds()
    out, err = _open_streams()
    old_out, old_err, old_in = sys.stdout, sys.stderr, sys.stdin
    sys.stdout, sys.stderr = out, err
    sys.stdin = io.StringIO("")  # input() ends at once, as fd 0's /dev/null does for a command
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
            _off_channel()
    except asyncio.CancelledError:
        _note(err, "\nKeyboardInterrupt: script cancelled by host\n")
        return_code = 1
    except BaseException as exc:
        if isinstance(exc, SystemExit) and os.getpid() != _RUNTIME_PID:
            _leave_forked(exc.code, err)
        if exc is st.interrupt:
            # Where the script was when it was stopped, without the runtime's frames.
            frames = [
                f for f in traceback.extract_tb(exc.__traceback__)
                if f.filename != _RUN_SCRIPT_CODE.co_filename
            ]
            _note(err, "Traceback (most recent call last):\n" + "".join(traceback.format_list(frames))
                  + "KeyboardInterrupt: script interrupted by host\n")
        else:
            _note(err, traceback.format_exc())
        return_code = 1
    finally:
        _flush_script_streams()
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

    if os.getpid() != _RUNTIME_PID:
        # A process the script forked ran off the script's end: the exec, its
        # result and its marks are the runtime's, so it leaves without sending
        # them, with the status Python gives a script that ended so. Its
        # writers hold only what it wrote (_flush_writers ran before the
        # fork), and it sends that first.
        _flush_writers()
        os._exit(return_code)
    # What the script left in its writers, then the runtime's own fds, then
    # the result, then the marks: should the fds be gone, the runtime's word
    # on why still lands in this exec's share of stderr.
    _flush_writers()
    _check_own_fds()
    send({"op": "exec_result", "id": exec_id, "return_code": return_code})
    _write_marks(mark)


def _dispatch(msg):
    """Handle one protocol message from the host; False means stop reading."""
    global _current_exec_id, _current_exec_task, _stop
    op = msg.get("op")
    if op == "init":
        handle_init(msg)
    elif op == "exec":
        if _current_exec_task is not None and not _current_exec_task.done():
            # The host runs one script at a time, so this is its mistake: a
            # second script's output would run into the first's.
            _diag("refused exec " + str(msg.get("id")) + ": another script is already running")
            send({"op": "exec_result", "id": msg.get("id"), "return_code": 1})
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
            _run_script(msg.get("id"), msg.get("code") or "", msg.get("mark") or "", st),
            loop=asyncio.get_running_loop(),
        )
        st.task = _current_exec_task
    elif op == "tool_result":
        _resolve(
            _pending_tool_futures.get(msg.get("id")),
            ToolResult(str(msg.get("result", "")), msg.get("is_error"), msg.get("structured_json") is True),
        )
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
        exiting = False
        try:
            for raw_line in PROTO_IN:
                # The host's exit op, after which the end of fd 3 is the host's
                # too: the main loop stops, and the runtime exits, once it takes
                # the op from the queue.
                if len(raw_line) < 100 and '"exit"' in raw_line:
                    try:
                        exiting = exiting or json.loads(raw_line).get("op") == "exit"
                    except Exception:
                        pass
                loop.call_soon_threadsafe(queue.put_nowait, raw_line)
        except (OSError, ValueError) as exc:
            # A script closed fd 3 under it, or a file it opened took the
            # number: nothing more can reach the runtime. Its check says so,
            # by name; a failure with fd 3 still the host's says what failed.
            _check_own_fd(3)
            _fatal("cannot read the host's messages any more (" + str(exc) + ")")
        # The end of fd 3: the host closed it, unless a script shut down the
        # socket under it, or put a file in its place that has run out. While a
        # script runs, it's the script's doing, or the host process's own exit,
        # which leaves nobody to read the line: PyRunner closes fd 3 only as it
        # kills the runtime, and its SIGKILL lands before the end can, and a
        # host that runs the runtime itself and stops it without killing it
        # sends exit first, as the protocol notes ask. An end while no script runs, or after exit,
        # is a clean exit, the host's own way out.
        task = _current_exec_task
        if not exiting and task is not None and not task.done():
            _fatal(_lost(3))
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
            _diag("bad protocol line")
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
#     set_result, an exception mid-send would tear a protocol line, and one in
#     the flush before a fork, which runs a script's own sys.stdout's code
#     too, would be lost there, since os.fork() reports a hook's exception
#     and goes on.
_RUN_SCRIPT_CODE = _run_script.__code__
_SEND_CODE = send.__code__
_BEFORE_FORK_CODE = _before_fork.__code__


def _on_sigint(signum, frame):
    st = _stop
    if st is None or st.state == _DELIVERED:
        return
    if st.running:
        while frame is not None:
            code = frame.f_code
            if code is _SEND_CODE or code is _BEFORE_FORK_CODE:
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
    _start()
    # A handler of our own also keeps asyncio.run from installing one that
    # would cancel main() and end the interpreter.
    if hasattr(signal, "SIGINT"):
        try:
            signal.signal(signal.SIGINT, _on_sigint)
        except (ValueError, OSError):
            pass
    asyncio.run(main())
`;
