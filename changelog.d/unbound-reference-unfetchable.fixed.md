- A reference registered with no server, such as one an in-process module
  returns, says it can't be fetched instead of inviting a `fetch_reference`
  call the fetcher can only refuse. Its stub, `fetch_reference`'s refusal
  (which read "reference has no server binding") and `save_recent_image`'s
  refusal now say "unbound: no server is recorded to fetch it from", as an
  expired reference's already say why. A saved copy is still offered.
