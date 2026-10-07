- **`save_recent_image` accepts null for the selector a caller isn't using.** `ref` is now
  advertised as string-or-null and `index`/`count` as integer-or-null, and null, like
  omission, means the selector isn't used. Callers whose provider presents every property
  as required can therefore save by `ref` or by `index`/`count`; before, `ref: null`, `ref: ""`
  and `count: null` were all refused, so neither selector worked for them. A supplied value
  is still checked, never read as absent: an empty or malformed `ref` is refused as before,
  and an `index` or `count` given as an empty or whitespace string, a boolean or an array is
  now refused with the existing message instead of being coerced. Before, such an `index`
  was read as a number (`""`, `false` and `[]` as 0), which saved the newest image rather
  than the one the caller meant; such a `count` was either refused by the range check or,
  for `true` or `[2]`, accepted as 1 or 2. Integer numbers and decimal-digit strings are
  accepted. The conflict refusal for a `ref` alongside a non-null `index`/`count` now names
  the null option.
