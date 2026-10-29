- **`save_recent_image` takes null or an empty string for the selector a caller isn't using.**
  `ref` is now advertised as string-or-null and `index`/`count` as integer-or-null, and
  null, an empty string and omission all mean the selector isn't used. Callers whose
  provider presents every property as required can therefore save by `ref` or by
  `index`/`count`; before, `ref: null`, `ref: ""` and `count: null` were all refused, so
  neither selector worked for them. Any other supplied value is checked, never read as
  absent: a whitespace or malformed `ref` is refused, and an `index` or `count` given as a
  whitespace string, a boolean, an array, or a numeric string other than decimal digits
  (`"2.0"`, `"+2"`, `"1e0"`, `"0x2"`) is refused, as an out-of-range one is, instead of
  being coerced. Before, `Number()` read such an `index`: `" "`, `false` and `[]` as 0,
  which saved the newest image, `true` as 1 and `[2]` as 2, which saved the second- and
  third-newest, and `"2.0"` or `"+2"` as 2; a `count` was read the same way, then
  range-checked. Integer numbers and decimal-digit strings, with surrounding whitespace
  trimmed, are accepted within each selector's range (`index` from 0, `count` 1..20) and
  within the integers a number holds exactly, so a value past them is refused rather
  than read as a different number. A malformed `ref` beside an `index` or `count` in use is
  refused with a note that null, or leaving the selector out, marks one that isn't used, as
  the conflict refusal of a well-formed `ref` beside them says. A refusal of one selector on
  its own carries no such note: dropping a lone `ref` would save the newest image, and
  dropping `index` or `count`, which together are one selector, would save other images than
  the call named.
- **`drafts` reads its nullable fields by the same rule.** An empty string now means
  `draftIds`, `destination`, `confirmDuplicate` or `offset` isn't in use, as null and
  omission already did, so a caller that fills the fields it isn't using with `""` can
  use the tool. Before, `{action: "list", destination: ""}` was refused as passing a
  field `list` doesn't use. `confirmDuplicate: false` is now taken as "don't confirm" on
  `list`, `read` and `dismiss` too, as the field's description already offered. `offset`
  is read as `index` is, so one past the integers a number holds exactly is refused;
  before, it was read as a rounded number, past every draft.
- **The selectors' schema uses JSON Schema type arrays** (`["integer", "null"]`,
  `["string", "null"]`), as `drafts` and `set_tool_description` already did. Membrane 0.7.0
  and later send a tool's schema to Gemini as `parametersJsonSchema`, so the arrays reach it
  as JSON Schema. A host whose own membrane is older than 0.7.0 still sends them as the
  function declaration's `parameters`, where Gemini's `Schema.type` takes a single type.
