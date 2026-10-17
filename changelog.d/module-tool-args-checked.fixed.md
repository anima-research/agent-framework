- A module tool's call that lacks a required argument, or whose input is
  there but isn't an object, is answered before the module runs with what to
  send, such as `Nothing was done: workspace--read needs "path" (a string),
  and this call gave none.`, every problem named at once. Before, the call
  reached the handler, which could fail deep inside with a `TypeError`, or
  run without it: `workspace--grep` with no `pattern` matched every line.
- The `utils` tool's check of a run's arguments reads the same way ("Nothing
  was done: …"), names every problem at once, and is still followed by the
  utility's schema. It now admits any type of a declared type list, where it
  refused every value of such a parameter; no longer checks the type of a
  parameter whose `type` names no JSON Schema type, such as `any`, or a list
  naming one, which it refused whatever it was (its `enum` is still
  checked); and takes a run of 16 or more digits sent as text for a number,
  passing it to the utility as text.
- The Discord module's `activate` reads a call with no input as no
  arguments, where it threw a `TypeError`.
