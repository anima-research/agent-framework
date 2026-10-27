/*
 * code_execution's engine: agent-framework's interface to QuickJS-ng, compiled with the release
 * engine/build.sh pins into one WebAssembly module, src/code-execution/quickjs.wasm.
 *
 * It is held to what code_execution's bridge needs: limits, evaluating the prelude and a script,
 * one host function whose calls the host settles by id, running jobs, the interrupt, and output.
 * The guest reaches nothing outside JavaScript except three of the imports below, a host call,
 * the interrupt and output, which only JSON text and output text cross, and the clocks: Date.now
 * and performance.now read WASI's clock_time_get. The fourth import, host_supervise, only the
 * interrupt handler calls, and nothing crosses it. libc's other WASI calls, four random bytes as
 * the module loads and stdio for the engine's own diagnostics, aren't reachable from guest code.
 * The host's side is src/code-execution/engine.ts.
 *
 * One runtime and one context per module instance, made by engine_init. A child process holds
 * one instance for one script, so nothing here is reentrant or thread-safe.
 */
#include <malloc.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))
#define EXPORT(name) __attribute__((export_name(name)))

/* The guest called __host(name, args): the host takes call `id`, to settle later with
   engine_settle. Returns 0 when the host took it, nonzero when the host failed (the binding
   keeps why). */
IMPORT("host_call")
extern int host_call(uint32_t id, const char *name, uint32_t name_len,
                     const char *args, uint32_t args_len);

/* QuickJS's interrupt handler, called while the guest runs. Nonzero stops the guest for good. */
IMPORT("host_interrupt")
extern int host_interrupt(void);

/* Called at every interrupt check, before host_interrupt is asked and after it has said stop, a
   failed import's stop included: the host's watch over its own process, such as its parent
   going, which no stop or failure ends. It answers nothing itself: a stop it calls for, as an
   orphan with no way to end its process does, comes through host_interrupt. */
IMPORT("host_supervise")
extern void host_supervise(void);

/* The guest called __output(stream, text), stream 1 for out and 2 for err. Returns 0, or
   nonzero when the host failed. */
IMPORT("host_output")
extern int host_output(uint32_t stream, const char *text, uint32_t len);

/* How a call into the guest left it; engine.ts mirrors these. */
enum {
    ENGINE_PENDING = 0,      /* the queue is empty and the script hasn't settled */
    ENGINE_FULFILLED = 1,    /* the script settled with a value: engine_result has it */
    ENGINE_REJECTED = 2,     /* the script, or the prelude, threw: engine_result has why */
    ENGINE_INTERRUPTED = 3,  /* host_interrupt returned nonzero while it ran */
    ENGINE_HOST_FAILED = 4,  /* an import reported failure: the run is over, and the host refuses
                                the guest's later calls and output and stops it at its next
                                interrupt check */
    ENGINE_FAILED = 5,       /* once the script was running, an exception escaped its promises (a
                                callback it gave queueMicrotask or a FinalizationRegistry threw,
                                or a job failed), or the engine failed to settle a call. The run
                                is over, every later call answers this, and engine_result has the
                                exception */
    ENGINE_MISUSE = -1,      /* called out of order, or with a malformed buffer */
    ENGINE_NO_MEMORY = -2,   /* the engine couldn't allocate its own state */
    ENGINE_UNKNOWN_CALL = -3 /* engine_settle named no pending call */
};
/* Or'd into engine_settle's state when the result didn't fit and the call took the host's
   rejection instead. */
#define ENGINE_UNFIT 16
/* Or'd into engine_settle's state when the call's resolve or reject function never ran with the
   result, nor with the host's rejection: the run had been stopped or had failed before this
   settle, or the call of that function was stopped or failed before it ran. Never with
   ENGINE_UNFIT. */
#define ENGINE_DROPPED 32

static JSRuntime *rt;
static JSContext *ctx;
/* Call id -> [resolve, reject]. Held only here, so guest code can't reach it. */
static JSValue pending;
/* The script's completion promise from JS_EVAL_FLAG_ASYNC, which settles to { value }. */
static JSValue completion;
/* What ended the run when it wasn't the completion promise: the prelude's or the script's
   synchronous throw, or an exception that escaped a job or settling a call; and the state it
   gives, ENGINE_REJECTED or ENGINE_FAILED. */
static JSValue failure;
static int failure_state;
static bool started;
static bool failed;
static bool interrupted;
static bool host_failed;
/* engine_result is serializing the script's value or error, which can run the script's own code
   (a toJSON, a getter) after its ending is fixed. */
static bool reading;
static uint32_t next_id = 1;

/*
 * QuickJS's allocations, held to the memory limit here rather than by JS_SetMemoryLimit.
 * Adapted from quickjs-wasi 3.6.2's c/interface.c (MIT, Copyright (c) 2026 Vercel, Inc.; the
 * notice is in src/code-execution/quickjs.wasm.LICENSES).
 *
 * QuickJS checks its own limit before it allocates, and refuses at exactly the limit. When a
 * script reaches it with many small allocations, the "out of memory" InternalError QuickJS then
 * builds is refused too, and the script's catch gets a bare null (the engine test's small-objects
 * case shows it). So QuickJS's own limit stays off, and these functions refuse ordinary
 * allocations at a soft limit OOM_HEADROOM under the limit. After a refusal, allocations may use
 * the headroom up to the limit, so that QuickJS can build the error and the script's handler can
 * run, and the next allocation that fits under the soft limit closes it again. So a script that
 * reaches the limit while the headroom is closed gets a real out-of-memory error, as long as
 * building that error doesn't reach this allocator twice with the first fitting under the soft
 * limit, which would close the headroom before the second. Most of what builds an error comes from
 * blocks QuickJS's arenas already hold, which don't reach this allocator, so that's rare. The
 * host's buffers (engine_alloc) are held to the same limits, so a refused copy opens the headroom
 * too, and the child's unfit error can still be copied in. Whatever runs while it's open can spend
 * it: a script that catches the error and goes on allocating without freeing, or a result settled
 * while the guest sits at the soft limit, whose parse goes in once a copy's refusal has opened it.
 * An out-of-memory error after that can be a bare null: keeping the headroom for the error alone
 * would take QuickJS's own in_out_of_memory flag, which its API doesn't expose. And a promise
 * reaction whose job QuickJS can't allocate is dropped (fulfill_or_reject_promise ignores
 * JS_EnqueueJob's failure), so the await it would have resumed never settles, and the engine
 * answers pending with no call in flight.
 */
#define OOM_HEADROOM (64 * 1024)

static size_t mem_limit; /* 0: no limit */
static size_t mem_used;  /* the usable size of every live allocation */
static bool mem_in_oom;  /* a refusal has opened the headroom */

static size_t soft_limit(void) {
    return mem_limit > 2 * OOM_HEADROOM ? mem_limit - OOM_HEADROOM : mem_limit / 2;
}

/* Whether mem_used + size would pass cap, without overflowing. */
static bool exceeds(size_t size, size_t cap) {
    return size > cap || mem_used > cap - size;
}

static bool refuse(size_t size) {
    if (mem_limit == 0)
        return false;
    if (!exceeds(size, soft_limit())) {
        mem_in_oom = false;
        return false;
    }
    if (mem_in_oom && !exceeds(size, mem_limit))
        return false;
    mem_in_oom = true;
    return true;
}

static void *limited_calloc(void *opaque, size_t count, size_t size) {
    (void)opaque;
    /* QuickJS has checked count * size for overflow. */
    if (refuse(count * size))
        return NULL;
    void *ptr = calloc(count, size);
    if (ptr)
        mem_used += malloc_usable_size(ptr);
    return ptr;
}

static void *limited_malloc(void *opaque, size_t size) {
    (void)opaque;
    if (refuse(size))
        return NULL;
    void *ptr = malloc(size);
    if (ptr)
        mem_used += malloc_usable_size(ptr);
    return ptr;
}

static void limited_free(void *opaque, void *ptr) {
    (void)opaque;
    if (!ptr)
        return;
    size_t usable = malloc_usable_size(ptr);
    mem_used -= usable <= mem_used ? usable : mem_used;
    free(ptr);
}

static void *limited_realloc(void *opaque, void *ptr, size_t size) {
    (void)opaque;
    size_t old_usable = ptr ? malloc_usable_size(ptr) : 0;
    /* Only growth is held to the limit: a shrinking realloc releases memory. */
    size_t growth = size > old_usable ? size - old_usable : 0;
    if (growth > 0 && refuse(growth))
        return NULL;
    void *new_ptr = realloc(ptr, size);
    if (new_ptr) {
        mem_used -= old_usable <= mem_used ? old_usable : mem_used;
        mem_used += malloc_usable_size(new_ptr);
    }
    return new_ptr;
}

static size_t limited_usable_size(const void *ptr) {
    return malloc_usable_size((void *)ptr);
}

static const JSMallocFunctions limited_malloc_funcs = {
    limited_calloc, limited_malloc, limited_free, limited_realloc, limited_usable_size,
};

/* Once the host has stopped the guest, every later check stops it too, without asking again, so
   a stop holds for good even if the host would say otherwise later. Its supervision runs at every
   check all the same: a stop the script keeps from landing, as below, leaves the guest running,
   and the host still has to see its own process's life, such as its parent going. The engine
   runs none of the script's code after a stop: every entry point checks the flag first, and
   error_json ends its read at one. QuickJS does: building an error's backtrace converts
   Error.stackTraceLimit, which can call a valueOf, and calls Error.prepareStackTrace, for the
   error a stop throws as for any other. A stop that lands in that code is lost when QuickJS puts
   back the error it was building, and the script goes on from there. This ends such code at its
   next check, and __host and __output refuse it, so none of it reaches the host. QuickJS checks
   at its first poll and once in 10,000 after, so a check ends the code running then, not at
   once. */
static int interrupt_handler(JSRuntime *r, void *opaque) {
    (void)r;
    (void)opaque;
    host_supervise();
    if (interrupted || host_interrupt()) {
        interrupted = true;
        return 1;
    }
    return 0;
}

/* __host(name, args): name and args are strings (the prelude stringifies the arguments).
   Returns a promise the host settles with engine_settle. Once the script has ended, while its
   ending is read, or once it's stopped, the call is refused. */
static JSValue js_host(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (reading || interrupted)
        return JS_ThrowInternalError(c, "the script's calls no longer reach the host");
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsString(argv[1]))
        return JS_ThrowTypeError(c, "__host takes a tool name and its arguments as JSON text");
    if (next_id == UINT32_MAX)
        return JS_ThrowRangeError(c, "__host: no call ids left");

    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(c, funcs);
    if (JS_IsException(promise))
        return promise;
    /* JS_NewArrayFrom takes both functions, and frees them if it fails. */
    JSValue entry = JS_NewArrayFrom(c, 2, funcs);
    if (JS_IsException(entry)) {
        JS_FreeValue(c, promise);
        return JS_EXCEPTION;
    }

    size_t name_len, args_len;
    const char *name = JS_ToCStringLen(c, &name_len, argv[0]);
    if (!name) {
        JS_FreeValue(c, entry);
        JS_FreeValue(c, promise);
        return JS_EXCEPTION;
    }
    const char *args = JS_ToCStringLen(c, &args_len, argv[1]);
    if (!args) {
        JS_FreeCString(c, name);
        JS_FreeValue(c, entry);
        JS_FreeValue(c, promise);
        return JS_EXCEPTION;
    }

    uint32_t id = next_id;
    if (JS_SetPropertyUint32(c, pending, id, entry) < 0) {
        JS_FreeCString(c, name);
        JS_FreeCString(c, args);
        JS_FreeValue(c, promise);
        return JS_EXCEPTION;
    }
    next_id++;
    int refused = host_call(id, name, (uint32_t)name_len, args, (uint32_t)args_len);
    JS_FreeCString(c, name);
    JS_FreeCString(c, args);
    if (refused) {
        JSAtom atom = JS_NewAtomUInt32(c, id);
        if (atom != JS_ATOM_NULL) {
            JS_DeleteProperty(c, pending, atom, 0);
            JS_FreeAtom(c, atom);
        }
        JS_FreeValue(c, promise);
        host_failed = true;
        return JS_ThrowInternalError(c, "the host failed while taking a call");
    }
    return promise;
}

/* __output(stream, text): stream 1 is out and 2 is err. Refused as __host is. */
static JSValue js_output(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (reading || interrupted)
        return JS_ThrowInternalError(c, "the script's output no longer reaches the host");
    int32_t stream;
    if (argc < 2 || !JS_IsNumber(argv[0]) || !JS_IsString(argv[1]))
        return JS_ThrowTypeError(c, "__output takes a stream, 1 or 2, and a string");
    if (JS_ToInt32(c, &stream, argv[0]) < 0)
        return JS_EXCEPTION;
    if (stream != 1 && stream != 2)
        return JS_ThrowRangeError(c, "__output's stream is 1 or 2");
    size_t len;
    const char *text = JS_ToCStringLen(c, &len, argv[1]);
    if (!text)
        return JS_EXCEPTION;
    int refused = host_output((uint32_t)stream, text, (uint32_t)len);
    JS_FreeCString(c, text);
    if (refused) {
        host_failed = true;
        return JS_ThrowInternalError(c, "the host failed while taking output");
    }
    return JS_UNDEFINED;
}

/* Keeps `exc` as what ended the run, unless something already did, with the state it gives:
   ENGINE_REJECTED for the prelude's or the script's own throw as it starts, ENGINE_FAILED for an
   exception that escapes once it runs. Takes `exc`. */
static void fail_with(JSValue exc, int st) {
    if (failed) {
        JS_FreeValue(ctx, exc);
        return;
    }
    failure = exc;
    failure_state = st;
    failed = true;
}

/* Runs pending jobs one at a time until none is left or the run has ended. */
static void run_jobs(void) {
    for (;;) {
        if (interrupted || host_failed || failed)
            return;
        JSContext *job_ctx;
        int r = JS_ExecutePendingJob(rt, &job_ctx);
        if (r == 0)
            return;
        if (r < 0) {
            /* A promise job catches what its handler throws, but the job of a queueMicrotask or
               FinalizationRegistry callback passes its throw on, and so does a failure of the
               job machinery itself, or an uncatchable error. */
            JSValue exc = JS_GetException(job_ctx);
            if (interrupted || host_failed)
                JS_FreeValue(ctx, exc);
            else
                fail_with(exc, ENGINE_FAILED);
            return;
        }
    }
}

static int state(void) {
    /* An exception that escaped once the script ran comes first: nothing records one once the
       guest is stopped or an import has failed, so it came before either, and stays the answer
       after one. A throw as the run starts is the script's own ending, which a stop that comes
       while it's read turns into a stop, as it does a rejection. */
    if (failed && failure_state == ENGINE_FAILED)
        return ENGINE_FAILED;
    if (interrupted)
        return ENGINE_INTERRUPTED;
    if (host_failed)
        return ENGINE_HOST_FAILED;
    if (failed)
        return failure_state;
    switch (JS_PromiseState(ctx, completion)) {
    case JS_PROMISE_FULFILLED:
        return ENGINE_FULFILLED;
    case JS_PROMISE_REJECTED:
        return ENGINE_REJECTED;
    case JS_PROMISE_PENDING:
        return ENGINE_PENDING;
    default:
        return ENGINE_MISUSE;
    }
}

/* Makes the runtime and context. memory_limit is the limit on QuickJS's allocations, which the
   binding sets a margin under the linear memory's maximum (0 means none). stack_size is the
   stack QuickJS allows below this call, which the binding keeps under the link-time stack. */
EXPORT("engine_init")
int engine_init(uint32_t memory_limit, uint32_t stack_size) {
    if (rt)
        return ENGINE_MISUSE;
    mem_limit = memory_limit;
    rt = JS_NewRuntime2(&limited_malloc_funcs, NULL);
    if (!rt)
        return ENGINE_NO_MEMORY;
    JS_SetMaxStackSize(rt, stack_size);
    JS_SetInterruptHandler(rt, interrupt_handler, NULL);
    ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        rt = NULL;
        return ENGINE_NO_MEMORY;
    }
    completion = JS_UNDEFINED;
    failure = JS_UNDEFINED;
    pending = JS_NewObjectProto(ctx, JS_NULL);
    if (JS_IsException(pending))
        return ENGINE_NO_MEMORY;
    JSValue global = JS_GetGlobalObject(ctx);
    int bad = JS_SetPropertyStr(ctx, global, "__host", JS_NewCFunction(ctx, js_host, "__host", 2)) < 0 ||
              JS_SetPropertyStr(ctx, global, "__output", JS_NewCFunction(ctx, js_output, "__output", 2)) < 0;
    JS_FreeValue(ctx, global);
    return bad ? ENGINE_NO_MEMORY : 0;
}

/* Evaluates the prelude as a global script, then the script as global code with top-level await,
   then runs jobs. Each buffer must end in a NUL at [len], as JS_Eval requires; filename is a
   NUL-terminated string. Called once. */
EXPORT("engine_start")
int engine_start(const char *prelude, uint32_t prelude_len, const char *script, uint32_t script_len,
                 const char *filename) {
    if (!ctx || started || !prelude || !script || !filename || prelude[prelude_len] != '\0' ||
        script[script_len] != '\0')
        return ENGINE_MISUSE;
    started = true;
    JSValue r = JS_Eval(ctx, prelude, prelude_len, "<prelude>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(r)) {
        JSValue exc = JS_GetException(ctx);
        if (interrupted || host_failed)
            JS_FreeValue(ctx, exc);
        else
            fail_with(exc, ENGINE_REJECTED);
        return state();
    }
    JS_FreeValue(ctx, r);
    r = JS_Eval(ctx, script, script_len, filename, JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC);
    if (JS_IsException(r)) {
        /* A syntax error, or a failure before the async function started. */
        JSValue exc = JS_GetException(ctx);
        if (interrupted || host_failed)
            JS_FreeValue(ctx, exc);
        else
            fail_with(exc, ENGINE_REJECTED);
        return state();
    }
    completion = r;
    run_jobs();
    return state();
}

/* Frees one of the host's buffers, and forgets it. */
static void release(char **buf) {
    limited_free(NULL, *buf);
    *buf = NULL;
}

/* engine_settle's work, which frees each buffer as soon as it's done with it. */
static int settle(uint32_t id, int ok, char **json, uint32_t json_len, char **unfit,
                  uint32_t unfit_len) {
    if (!started || (*json && (*json)[json_len] != '\0') || (*unfit && (*unfit)[unfit_len] != '\0'))
        return ENGINE_MISUSE;
    JSValue entry = JS_GetPropertyUint32(ctx, pending, id);
    if (JS_IsException(entry)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return ENGINE_NO_MEMORY;
    }
    if (JS_IsUndefined(entry))
        return ENGINE_UNKNOWN_CALL;
    JSAtom atom = JS_NewAtomUInt32(ctx, id);
    if (atom == JS_ATOM_NULL) {
        JS_FreeValue(ctx, entry);
        JS_FreeValue(ctx, JS_GetException(ctx));
        return ENGINE_NO_MEMORY;
    }
    JS_DeleteProperty(ctx, pending, atom, 0);
    JS_FreeAtom(ctx, atom);
    if (interrupted || host_failed || failed) {
        JS_FreeValue(ctx, entry);
        return state() | ENGINE_DROPPED;
    }

    JSValue value = JS_UNDEFINED;
    bool resolve = ok != 0;
    bool too_large = !*json;
    if (*json) {
        value = JS_ParseJSON(ctx, *json, json_len, "<result>");
        release(json);
        if (JS_IsException(value)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            too_large = true;
        }
    }
    if (too_large) {
        resolve = false;
        if (*unfit) {
            value = JS_ParseJSON(ctx, *unfit, unfit_len, "<unfit>");
        } else {
            JS_ThrowOutOfMemory(ctx);
            value = JS_EXCEPTION;
        }
        if (JS_IsException(value))
            value = JS_GetException(ctx);
    }
    release(unfit);
    JSValue fn = JS_GetPropertyUint32(ctx, entry, resolve ? 0 : 1);
    JS_FreeValue(ctx, entry);
    if (JS_IsException(fn)) {
        JS_FreeValue(ctx, value);
        fail_with(JS_GetException(ctx), ENGINE_FAILED);
        return state() | ENGINE_DROPPED;
    }
    JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&value);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, value);
    if (JS_IsException(r)) {
        /* A promise's resolve and reject functions don't throw once they run (what reading a
           result's `then` throws rejects the promise), so the call never ran: the interrupt check
           on its way in stopped the guest, or there was no stack left to make it. */
        JSValue exc = JS_GetException(ctx);
        if (interrupted || host_failed)
            JS_FreeValue(ctx, exc);
        else
            fail_with(exc, ENGINE_FAILED);
        return state() | ENGINE_DROPPED;
    }
    JS_FreeValue(ctx, r);
    run_jobs();
    int st = state();
    return too_large ? st | ENGINE_UNFIT : st;
}

/* Settles call `id`, then runs jobs. With ok, the call's promise resolves to the parsed JSON;
   otherwise it rejects with it. A result the guest can't take rejects it with the parse of unfit
   instead, the host's own error, and the state answered has ENGINE_UNFIT set: a null json, which
   the host couldn't copy in, or a parse that fails, for want of memory or stack (or because it
   isn't JSON, which a host's result never is). Any of these took effect without reaching the
   script, which an error at the call's await would hide. A result nested deeper than the
   binding's MAX_RESULT_DEPTH never gets here: under Node, a parse nested about 8,000 deep (5,000
   with V8's optimizing tier alone) overflows the host's stack before QuickJS's own check sees the
   recursion, and the binding refuses results well short of that. When the run had been stopped
   or had failed before this settle, or the call of the promise's resolve or reject function is
   stopped or fails before it runs, the state answered has ENGINE_DROPPED set: that function never
   ran with the result. Once it has, the result is handed over, and the script's own code runs
   with it: a `then` getter the script put on Object.prototype, which can reject the promise
   instead, and its continuations. A stop or failure in that code leaves the result handed over.

   json and unfit are the host's buffers from engine_alloc, each null or ending in a NUL at [len]
   as JS_ParseJSON requires, and this frees both, whatever it returns: the result's copy as soon
   as it's parsed, so it's gone before the unfit error is parsed, and the unfit error's once it's
   parsed or isn't needed, before the script's code runs. A parse that fails frees what it built
   too. If even the unfit error can't be copied in (a null unfit) or parsed, the call rejects with
   what that failure gives. */
EXPORT("engine_settle")
int engine_settle(uint32_t id, int ok, char *json, uint32_t json_len, char *unfit,
                  uint32_t unfit_len) {
    int st = settle(id, ok, &json, json_len, &unfit, unfit_len);
    release(&json);
    release(&unfit);
    return st;
}

/* What a read or a conversion that ran the script's code gave, once a stop has come: dropped,
   with its exception, if it threw. A stop that lands in a stack hook or an iterator's return, which
   QuickJS drops, lets that code go on and give a part after the stop, which isn't kept. */
static JSValue drop_late(JSValue p) {
    if (JS_IsException(p))
        JS_FreeValue(ctx, JS_GetException(ctx));
    else
        JS_FreeValue(ctx, p);
    return JS_UNDEFINED;
}

/* One part of an object, for error_json: read, and made a string at once, so a stop in a later
   part's read can't take it. Nothing is read once a stop has come, and a part whose read or
   string form ends after a stop is left out. A part that isn't there, or whose read throws, is
   undefined; one with no string form is null, which error_json leaves out with no stand-in, as it
   does a stack that isn't a string. */
static JSValue error_part(JSValue v, const char *key, bool any) {
    if (interrupted)
        return JS_UNDEFINED;
    JSValue p = JS_GetPropertyStr(ctx, v, key);
    if (interrupted)
        return drop_late(p);
    if (any && !JS_IsException(p) && !JS_IsUndefined(p) && !JS_IsString(p)) {
        JSValue s = JS_ToString(ctx, p);
        JS_FreeValue(ctx, p);
        if (interrupted)
            return drop_late(s);
        if (JS_IsException(s)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            return JS_NULL;
        }
        p = s;
    }
    if (JS_IsException(p)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_UNDEFINED;
    }
    if (!JS_IsString(p)) {
        JS_FreeValue(ctx, p);
        return JS_UNDEFINED;
    }
    return p;
}

/* The text of a value or an error, for engine_result. Takes v. Returns a JS string, undefined,
   or an exception. Reading an object's parts can run the script's own code (a getter, a toJSON, a
   toString), and a stop ends the read: what was read before it stays, and nothing more is read,
   neither a part nor a stand-in for a missing message, and what such code gives after a stop
   that QuickJS dropped is left out. The message is read first, as the part most worth keeping,
   and each part is a string before the next is read. */
static JSValue error_json(JSValue v) {
    /* No prototype, so a toJSON the script put on Object.prototype doesn't serialize it. */
    JSValue o = JS_NewObjectProto(ctx, JS_NULL);
    if (JS_IsException(o)) {
        JS_FreeValue(ctx, v);
        return o;
    }
    JSValue name = JS_UNDEFINED, message = JS_UNDEFINED, stack = JS_UNDEFINED;
    if (JS_IsObject(v)) {
        message = error_part(v, "message", true);
        name = error_part(v, "name", true);
        stack = error_part(v, "stack", false);
        /* An object with no message of its own, such as a plain object thrown, or one whose
           message can't be read, is told by its JSON, or by its string form when it has none,
           rather than left blank. */
        if (JS_IsUndefined(message) && !interrupted) {
            message = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
            if (interrupted) {
                message = drop_late(message);
            } else if (JS_IsException(message)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
                message = JS_UNDEFINED;
            }
            if (JS_IsUndefined(message) && !interrupted) {
                message = JS_ToString(ctx, v);
                if (interrupted)
                    message = drop_late(message);
            }
        }
    } else {
        /* A primitive's string form runs no script code, but a Symbol has none: its conversion
           throws a TypeError, whose backtrace can run the script's stack hook, and the error is left
           out with nothing the hook gave. */
        message = JS_ToString(ctx, v);
    }
    /* A stand-in that throws, or a primitive with no string form, such as a Symbol, is left out. */
    JSValue parts[3] = {name, message, stack};
    const char *keys[3] = {"name", "message", "stack"};
    for (int i = 0; i < 3; i++) {
        JSValue p = parts[i];
        if (JS_IsException(p))
            JS_FreeValue(ctx, JS_GetException(ctx));
        else if (!JS_IsString(p))
            JS_FreeValue(ctx, p);
        else if (JS_SetPropertyStr(ctx, o, keys[i], p) < 0)
            JS_FreeValue(ctx, JS_GetException(ctx));
    }
    JS_FreeValue(ctx, v);
    JSValue text = JS_JSONStringify(ctx, o, JS_UNDEFINED, JS_UNDEFINED);
    JS_FreeValue(ctx, o);
    return text;
}

/* Copies a JS string into a buffer for the host: [u32 kind][u32 length][UTF-8 bytes]. */
static uint8_t *pack(uint32_t kind, JSValue text) {
    size_t len = 0;
    const char *s = NULL;
    if (JS_IsString(text)) {
        s = JS_ToCStringLen(ctx, &len, text);
        if (!s) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            JS_FreeValue(ctx, text);
            return NULL;
        }
    }
    uint8_t *buf = limited_malloc(NULL, 8 + len);
    if (buf) {
        memcpy(buf, &kind, 4);
        uint32_t len32 = (uint32_t)len;
        memcpy(buf + 4, &len32, 4);
        if (len)
            memcpy(buf + 8, s, len);
    }
    if (s)
        JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, text);
    return buf;
}

/* The ending as engine_result gives it: the value's JSON (kind 0 or 1), or an error's (kind 2). */
static uint8_t *read_ending(int st) {
    JSValue text;
    uint32_t kind = 2;
    if (st != ENGINE_FULFILLED) {
        text = error_json(failed ? JS_DupValue(ctx, failure) : JS_PromiseResult(ctx, completion));
    } else {
        JSValue settled = JS_PromiseResult(ctx, completion);
        JSValue value = JS_GetPropertyStr(ctx, settled, "value");
        JS_FreeValue(ctx, settled);
        if (JS_IsException(value)) {
            text = error_json(JS_GetException(ctx));
        } else {
            text = JS_JSONStringify(ctx, value, JS_UNDEFINED, JS_UNDEFINED);
            JS_FreeValue(ctx, value);
            if (JS_IsException(text))
                text = error_json(JS_GetException(ctx));
            else
                kind = JS_IsUndefined(text) ? 0 : 1;
        }
    }
    if (JS_IsException(text)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return NULL;
    }
    return pack(kind, text);
}

/* After ENGINE_FULFILLED, ENGINE_REJECTED or ENGINE_FAILED: a buffer the host frees with
   engine_free, [u32 kind][u32 length][UTF-8]. Kind 0: fulfilled with undefined (or a value
   JSON.stringify leaves out), no text. Kind 1: fulfilled, the value's JSON. Kind 2: an error, as
   JSON {name?, message?, stack?}: what the script threw, why its value couldn't be stringified,
   or the exception that ended the run.
   Returns 0 in any other state, when it can't allocate, or when a stop lands while the script's own
   ending is read, which leaves none to give. The ending is fixed before it's read. The script's own
   code that serializing runs (a toJSON, a getter), and the jobs it queues, which run before this
   returns until the run fails or is stopped, can't reach the host; a reaction it attaches to a
   promise still pending runs when that settles, as the script's other continuations do after its
   ending. A stop in those jobs comes after the ending was read, so this returns the ending; a
   failure there ends the run after its ending, which engine_state then answers. An exception that
   ended the run is what ended it however its read goes, so a stop while it's read leaves out the
   parts the stop cut off (see error_json), and the rest is returned. Data nested deeper than the
   host's stack allows can overflow it in JS_JSONStringify, which throws out of the module: the
   binding reports that as a crash. */
EXPORT("engine_result")
uint8_t *engine_result(void) {
    int st = state();
    if (st != ENGINE_FULFILLED && st != ENGINE_REJECTED && st != ENGINE_FAILED)
        return NULL;
    reading = true;
    uint8_t *buf = read_ending(st);
    if (interrupted && st != ENGINE_FAILED) {
        /* What was read is the stop's error, not the ending. */
        limited_free(NULL, buf);
        buf = NULL;
    } else {
        run_jobs();
    }
    reading = false;
    return buf;
}

/* The run's state as engine_start and engine_settle answer it, for the host to read again after
   engine_result: the jobs reading an ending queues run before that returns, and an exception
   escaping them ends the run after its ending. */
EXPORT("engine_state")
int engine_state(void) {
    return started ? state() : ENGINE_MISUSE;
}

/* Buffers the host fills for engine_start and engine_settle. The host frees engine_start's after
   that call, and engine_result's once it has read it; engine_settle frees its own. They're held
   to the same limit as QuickJS's allocations: a result's copy and the value parsed from it share
   the guest's memory, and with the copy outside the limit, the two together could exhaust linear
   memory before the limit refused anything, so the parse's failure would look like no refusal
   and an out-of-memory error couldn't be built. */
EXPORT("engine_alloc")
void *engine_alloc(uint32_t size) {
    return limited_malloc(NULL, size ? size : 1);
}

EXPORT("engine_free")
void engine_free(void *ptr) {
    limited_free(NULL, ptr);
}

/* Frees the context and runtime. Nothing may be called after it. */
EXPORT("engine_dispose")
void engine_dispose(void) {
    if (!rt)
        return;
    JS_FreeValue(ctx, completion);
    JS_FreeValue(ctx, failure);
    JS_FreeValue(ctx, pending);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    ctx = NULL;
    rt = NULL;
}
