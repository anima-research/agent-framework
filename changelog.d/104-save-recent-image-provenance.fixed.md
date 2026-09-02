- **`save_recent_image` can no longer save the wrong image** (#104). Tool-result
  images never reached the persisted window — history keeps a text placeholder
  and only the live wire copy carries bytes — so the recency scan walked past a
  snapshot the resident had just seen and quietly saved an OLDER attachment
  under the snapshot's filename (or reported "no images found"). Every
  tool-result image is now retained per agent at ingestion in a bounded
  in-memory ledger with provenance (tool call, block, MIME, size, SHA-256), and
  the history placeholder carries its handle:
  `[image: image/png, ~691KB, ref img_7]`. The tool walks one ordered inventory
  across attachments, tool images and image-typed RFC-005 reference stubs; when
  the image at the requested index cannot be produced (evicted, from an earlier
  process, a pre-retention placeholder, a quoted/forged placeholder whose ref
  belongs to another call, or a reference whose bytes live behind
  `fetch_reference`) it fails **at that index** and writes nothing — it never
  substitutes an older image. New `ref` argument saves by provenance; receipts
  report source, tool call, MIME, byte size and SHA-256.
