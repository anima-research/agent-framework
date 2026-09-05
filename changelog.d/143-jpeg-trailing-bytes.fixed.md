- `read_image` / workspace `read_image` no longer reject a JPEG that carries
  padding after its EOI marker (#143). Hardware encoders such as the Raspberry
  Pi camera pad every still to a 4-byte boundary (`ff d9 00 00 00`), and
  decoders stop at EOI, so these are valid images; the validator used to
  require EOI to be the final byte and reported them as `Invalid JPEG image`,
  which made an rpi camera unviewable for a resident. The SOI..EOI stream is
  still fully validated.
