- `materialize` and `sync` took `"mount": ""` and `"path": ""` as no mount
  or path given, and acted on every mount. Without a path, `"mount": ""` is
  now refused, naming the mounts; `"path": ""` is refused whatever `"mount"`
  holds. Each refusal acts on no mount and says what leaving the field out
  covers: every mount, or for `"path"` beside a mount's name, that mount.
