- **Hosts whose MCPL servers send coalesced events or channel messages:** on
  chronicle 0.8.0, a producer's retry of an acceptance can succeed on the same
  open store after a failed fsync of the store's log. Before the acceptance's
  write or its commit (`store.sync()`) goes on, chronicle 0.8.0 writes the
  records since the last good fsync again, and fsyncs. On chronicle 0.6 and
  0.7, each later commit on that store fails until the store is opened again,
  so the retry can't succeed.
