- `bench/dendrite/cache-acceptance.mjs`: a live acceptance run for the Dendrite
  rendering contract — a folding resident, a fork at the boundary and a fork
  derived mid-tool-call, each request's `cache_creation`/`cache_read` against the
  resident's own reuse. Verified 2026-10-10 on Claude Sonnet 5.5: a fork's first
  request reads 100% of the resident's cached prefix.
