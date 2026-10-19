- **`stop()` ends an MCPL connect still in flight, in either engine,
  instead of waiting for it.** The connect rejects with "was not connected:
  the framework stopped while it was connecting", and `stop()` doesn't wait
  on a server for it, in its handshake (its launch reaped), its setup or its
  tool listing, which asks every server. A restart in flight ends too, its
  connect refused once `stop()` has begun, so the server it was restarting
  is down. A disconnect admitted before `stop()` began still finishes
  first.
