- The code-execution python interpreter no longer inherits the host
  environment: it gets the same operating allowlist as stdio MCPL children
  (#175), plus the runner's declared `env`, with `inheritEnv: true` as the
  escape hatch — model-authored code can no longer read host secrets via
  `os.environ`. The child env is rebuilt at every spawn, and on Windows the
  allowlist matches names case-insensitively (`Path`, `SystemRoot`,
  `ComSpec` survive with their original spelling).
