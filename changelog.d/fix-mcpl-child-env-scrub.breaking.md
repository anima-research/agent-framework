- **Operators of stdio MCPL servers:** children no longer inherit the whole
  host environment. They get a small allowlist (`PATH`, `HOME`, locale/`LC_*`,
  `TMPDIR`, TLS roots, …; see `CHILD_ENV_ALLOWLIST`) plus the server's own
  `env`, so one server's credentials (provider API keys, other bots' tokens)
  are no longer readable by another. A server that relied on an inherited
  variable must declare it in its `env` (recipes can `${VAR}`-substitute), or
  set `inheritEnv: true` to restore full inheritance.
