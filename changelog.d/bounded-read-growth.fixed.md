- **`readFileFromDisk`'s `maxBytes` and `read_image`'s size limit now bound
  the read itself, so they hold for a file that grows while it's read.**
  Both were checked against the size the open's `fstat` reported (for
  `read_image`, the mount's `maxFileSize`), and a file within the limit
  then was read with `readFile`, which in Node reads to the size its own
  `fstat` finds, or for a size of 0, to the file's end. So a file that
  grew in between was loaded whole. `readFileFromDisk` returned all of it
  with `truncated` false, and `read_image` loaded it before refusing it as
  too large.
  - Each now reads no more than its limit and one byte past it, which
    isn't kept and says whether the file goes on. `readFileFromDisk` reports
    a file that goes on as `truncated`, and `read_image` refuses it with its
    usual "Image file exceeds max size" words.
  - `readFileFromDisk`'s `truncated` and `size` now say what the read found.
    A file that shrank under `maxBytes` after the open is no longer reported
    `truncated`. `size` is `bytes.length` unless `truncated`, and then the
    file's size by an `fstat` after the read, or `maxBytes + 1` if that's
    less. Before, `size` was the open's `fstat` size, so it could disagree
    with the bytes returned for a file that changed in between.
- **A sync, listing or scan now takes a file that grew past the mount's
  `maxFileSize` after its `fstat` as oversize.** The workspace hashes it
  in chunks and keeps only its head, as for any file over the limit.
  Before, its read of a file within the limit at its `fstat` used
  `readFile`, so a file that grew in between was loaded whole, and a sync
  could store the whole of a text file over the limit.
