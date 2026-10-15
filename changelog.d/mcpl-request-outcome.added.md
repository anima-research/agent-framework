- **`McplRequestError`: why an MCPL request produced no result.** A request
  to an MCPL server that fails now rejects with `McplRequestError` (exported),
  whose `outcome` says which of three things happened: `not-sent` (refused
  before anything was written: the connection was already closed),
  `error-response` (the server answered with a JSON-RPC error; `code` and the
  error's `data` are kept), or `no-response` (the request was handed to the
  transport and no answer came back: a timeout, or the connection closed
  while awaiting; it may or may not have reached the server). Only
  `not-sent` proves the server never saw the request. Messages are unchanged,
  and it is still an `Error`, so existing handling keeps working.
