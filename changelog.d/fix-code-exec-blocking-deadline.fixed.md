- `code_execution` time limits now stop blocking code (`time.sleep()`, a busy
  loop, a blocking read) at the limit (#235). The deadline's cancel reached a
  script only at an `await`, so blocking code ran on until it returned (and
  read as a success) or was killed 10s later, losing its output and the
  interpreter's variables. The host now also sends the interpreter SIGINT,
  which the runtime raises as `KeyboardInterrupt` only inside the running
  script: the result keeps the output so far, shows the line the script was
  stopped at, and says it reached its time limit, and variables survive. The
  kill remains for code that ignores the interrupt (a long call inside C code,
  code that swallows `KeyboardInterrupt`, blocking code in a task the script
  started), and its message now names the time limit and the lost variables.
  Windows keeps the previous behavior.
