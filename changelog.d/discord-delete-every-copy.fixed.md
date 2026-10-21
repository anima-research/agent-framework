- A Discord message stored twice in shards now loses both copies when it's
  deleted, by a live delete or by a history sync that finds it gone. The
  module removed one body per shard group id, and the group id names the
  text, so the second copy, under the same id, outlived the delete. It now
  removes each body as context-manager reads them (`continuesBody`, in store
  order).
