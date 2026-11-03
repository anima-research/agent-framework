- A host that stopped quiesced now restores its quiesce mode before its
  modules start. A write a module makes from its `start()` on such a boot
  is handled as a write to a quiesced host: it takes no clock row. Before,
  the mode was read after the modules started, so that write took one.
