- `HistoryModule` gains an optional `semantic_search` tool: meaning-based search
  over the agent's raw messages (text plus its own think/journal/skip_reply
  notes) and every compression summary, backed by a shared remote
  embed-service whose vector index lives server-side, one namespace per store
  (`new HistoryModule({ semantic: { url, token, namespace } })`). The module
  keeps the index in sync itself — a background tick every 60 s and a bounded
  catch-up before each search, messages watermarked by timestamp with an
  overlap re-scan and summaries by `createdMs` — and backs off cleanly when
  the service is unreachable, so the other four history tools are unaffected.
