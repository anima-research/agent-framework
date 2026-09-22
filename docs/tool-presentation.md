# Opt-in tool presentation

Configure an agent with `toolPresentation: {path: "/absolute/path/tools.json", cataloguePath: "board/tool-catalogue.md"}`. Workspace is required; the catalogue mount must exist. This adds exactly `set_tool_visibility(name, visible)` and `set_tool_description(name, description)`. A null description removes its override. Tool names, schemas, permissions and dispatch remain unchanged.

The file is the sole persistent source for both tool edits and ordinary filesystem edits:

```json
{"version":1,"tools":{"mcpl--shell--runCommand":{"visible":true,"description":"Local shell guidance"}}}
```

Removing an entry restores its defaults. Unknown/unavailable names are retained with diagnostics, not activated. Missing files mean defaults. Malformed files cause all overrides to be ignored, with a diagnostic in inspection and the catalogue; editing tools refuse to overwrite malformed data. Read limits are 256 KiB per file and 32,768 characters per description. Tool edits serialize with a sibling `.lock`, check for intervening changes, preserve permission bits, and rename a temporary file. Arbitrary external editors do not participate in the lock: coordinate simultaneous editing; the revision check is not an operating-system transaction against uncooperative writers. A stale lock after process termination requires operator removal after checking no writer is active. Symlink targets must be edited directly; editing tools reject replacing symlinks.

`workspace--read {"path":"board/tool-catalogue.md","limit":140}` reads a generated, read-only virtual file, never a stale Chronicle blob. It lists available native definitions, including hidden ones, schemas, original/effective descriptions and a revision. It is not a physical disk file and does not yet appear in directory/glob results or the host's ordinary file-download endpoint. Its exact path is always signposted in both editing tools, even if their descriptions are overridden. Reserve an otherwise unused path. This does not expand `utils` into its internal module operations.

The two editing tools and `workspace--read` cannot be hidden. Permission to use them is required at setup, not granted by this feature. Distinct agents need distinct catalogue paths; no implicit inheritance into ephemeral or subconscious agents is added. Sharing an override file is explicit configuration, independent of who edits it.

Changes affect the next newly compiled request. They do not rewrite an in-flight Membrane stream or old conversation messages containing tool descriptions. Hidden tools remain in execution surfaces; visibility is not access control. Preview, inference and context maintenance share advertised-definition assembly. `inspectToolPresentation` returns current state; `getRequestToolPresentation(previewRequest)` returns the matching frozen preview metadata.

Framework unit/integration tests exercise persistent edits, reset, malformed input, direct file edits, isolation, preview matching, both dispatch routes, catalogue reads and recovery protection. Provider transport and permission enforcement remain in their existing owners.

The catalogue begins with exact names and visibility grouped by registered module or MCPL server, followed by full definitions. Index entries give offset/limit values for reading a definition. Those line references apply to the displayed revision; reread the index after changes. Sources come from the registries, including configured MCPL prefixes. Groups are rebuilt each read rather than maintained as a fixed taxonomy. Visible/hidden is not an imposed primary/secondary ranking.

## Component description defaults

Optional `toolPresentation.defaults` is an array of `{source, path}` profiles, with absolute file paths and unique registered source labels (for example `Module: workspace` or `MCPL server: discord`). Each profile uses `{version:1,tools:{"exact-tool-name":{description:"..."}}}`. Profiles may supply descriptions only; visibility stays in the resident file. Binding uses the tool registry's source attribution, not a guessed name prefix. A missing component contributes nothing, including no missing-profile error. Unknown tool entries never create tools.

Precedence: installed description → selected component profile → resident description. Setting a resident description to null removes that override and reveals the selected default. Existing configurations without profiles retain their behavior. Malformed active profiles produce diagnostics and fall back to installed wording; resident overrides still apply. Parameter descriptions are not overridden by these files. Snapshot entries expose descriptionSource, and the generated catalogue includes it.

Profiles are explicitly selected by deployment configuration in this prototype; packages are not automatically discovered. Shared wording can ultimately move upstream into each component. Local profiles let deployments try wording independently while preserving ordinary resident files.
