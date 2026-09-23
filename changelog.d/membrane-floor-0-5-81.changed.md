- **Hosts:** the `@animalabs/membrane` floor is now `^0.5.81`. Earlier
  releases reported reason `user` from a broad abort catch for any error
  whose message contained "abort", which the new cancellation path would
  have recorded as a deliberate stop; from 0.5.81 `user` means exactly that
  the request's signal was aborted.
