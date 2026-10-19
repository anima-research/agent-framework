- **A `code_execution` script can test a result for an error, and read its
  structured content, without parsing.** Each tool function's string is
  unchanged, and carries two attributes beside it: `.is_error`, `True` for an
  error result (a failure the framework reports as `Error: …`, or a
  structured result whose `isError` is true) and `False` otherwise, and
  `.structured`, the parsed `structuredContent` of a structured result's
  JSON object, or `None`. A result whose text merely starts with `Error:`
  reads `False`. The string is now a `str` subclass, so code that uses it as
  a string keeps working, `json.loads` and `isinstance(r, str)` included,
  while an exact type check such as `type(r) is str` now reads `False`, and
  a result a script pickles loads only in the script runtime.
  `PyRunner`'s `onToolCall` may return a `ScriptToolResult` (exported) to
  set both, or a plain string as before, for which both read `None`.
  `code_execution`'s description changes, so the first request after the
  upgrade that carries it misses the prompt cache from its tool block on.
