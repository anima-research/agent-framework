- Image blocks whose declared `media_type` disagrees with their bytes (e.g. a
  PNG labeled `image/webp` by an upstream surface) are corrected from the
  magic bytes at compile time. The provider rejects any request with such a
  mismatch, so one mislabeled image used to fail every subsequent turn.
