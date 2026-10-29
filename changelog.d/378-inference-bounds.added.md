- `FrameworkConfig.inferenceBounds` sets how long a model call may go without
  progress: `progressBounds`, membrane's `beforeContentMs`, `betweenEventsMs`
  and `thinkTokensPerSecond`, from which the flat and whole-call bounds also
  derive, and `flatMinimumMs`, by default `FLAT_MINIMUM_MS` (exported). `false`
  sets none. A value it can't use is refused at `create()`, naming the field
  under `inferenceBounds`. One setting covers every agent, so a host with one
  slower model raises the bounds for all of them.
- Settings passed to `new DefaultErrorPolicy(settings)` can carry a
  `deadline` schedule for deadline expiries.
