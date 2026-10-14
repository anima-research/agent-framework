- **`save_recent_image` takes null or an empty string for the selector a caller isn't using.**
  `ref` is now advertised as string-or-null and `index`/`count` as integer-or-null, and
  null, an empty string and omission all mean the selector isn't used. Callers whose
  provider presents every property as required can therefore save by `ref` or by
  `index`/`count`; before, `ref: null`, `ref: ""` and `count: null` were all refused, so
  neither selector worked for them. Any other supplied value is checked, never read as
  absent: a whitespace or malformed `ref` is refused, and an `index` or `count` given as a
  whitespace string, a boolean, an array, or a numeric string other than plain decimal
  digits (`"2.0"`, `" 2"`, `"+2"`, `"1e0"`, `"0x2"`) is refused with the existing message
  instead of being coerced. Before, `Number()` read such an `index`: `" "`, `false` and `[]`
  as 0, which saved the newest image, `true` as 1 and `[2]` as 2, which saved the second-
  and third-newest, and `"2.0"` or `"+2"` as 2; a `count` was read the same way, then
  range-checked. Integer numbers and decimal-digit strings are accepted within each
  selector's range (`index` from 0, `count` 1..20). The refusals now say that null, or
  leaving the selector out, marks one that isn't used.
