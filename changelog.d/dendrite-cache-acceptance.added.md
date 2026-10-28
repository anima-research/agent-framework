- `bench/dendrite/cache-acceptance.mjs`: a live acceptance run for the Dendrite
  rendering contract — a folding resident, a fork at the boundary and a fork
  derived mid-tool-call, each request's `cache_creation`/`cache_read` against the
  resident's own reuse. Measured 2026-10-10 on Claude Sonnet 5.5 (one model, one
  route, a synthetic 40-message history): the fork at the boundary read 10,193
  cached tokens and wrote 29; the fork derived mid-tool-call read 10,230 and
  wrote 152; the resident's own reuse read 10,173. Reuse follows the cache markers
  the strategy emits (autobiographical: messages; passthrough: system and
  tools only).
