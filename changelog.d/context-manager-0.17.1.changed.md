- Depends on `@animalabs/context-manager` `^0.17.1` (was `^0.17.0`), whose
  compile provenance no longer reads each raw run's first stored message to
  learn its sequence: since context-manager 0.16.0 that read cost a
  long-lived store about 100 ms of every compile, more than the #45 solve
  work saved there (context-manager#273). Patch release from the v0.21.4 tag
  with this dependency bump only.
