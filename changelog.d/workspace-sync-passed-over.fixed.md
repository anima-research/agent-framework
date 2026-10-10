- Workspace `sync` says what it didn't look at (#276). A sync without a path
  now counts, under `passedOver`, what each mount's scan skipped by design,
  by reason. Today that's the names its ignore list covers, with an ignored
  directory counted once. So `totalSynced: 0` means only that nothing it
  looked at had changed. A path the ignore list covers is still taken when
  named, and the result lists it under `ignored`, noting that a sync without
  a path won't maintain it.
