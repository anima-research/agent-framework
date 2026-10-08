- Add opt-in resident-editable tool descriptions and visibility, a source-grouped generated catalogue, and optional component description profiles. Hidden tools retain their existing execution permissions.
- Keep hidden definitions available to compression, protect catalogue path aliases and discovery instructions, and preserve shared override-file permissions during resident edits.

- Live requests capture advertised and compression definitions together before asynchronous context gathering, so mid-gather tool refreshes cannot split their snapshots. Settings edits preserve permissions through the open temporary-file descriptor and reject detected pathname replacement before committing.
