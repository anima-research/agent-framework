- **Scripts, hosts and modules that read the workspace's `read`, `grep`,
  `edit` or `edit_many` results:** each now answers as the text the model
  reads, with its fields beside it in `structured`. The model read each as
  one line of JSON, a page's lines escaped inside it. It now reads a header
  of the result's fields, one `key: value` to a line (`path: …`,
  `totalLines: …`, `nextOffsetChars: null`), then labelled sections: a
  page's `--- content ---`, grep's matches by file and version (`N:` for a
  match, `N-` for a line of its context, as grep writes them), what grep
  skipped, and a receipt's `--- files ---` and `--- changed ---`. A value
  outside a page's content and a receipt's changed lines that holds a line
  break (LF, CR, VT, FF, NEL, U+2028 or U+2029) or starts with `"`, such as
  a path or a line grep matched, is written as a JSON string, so a value
  shown as it is never starts with `"`. A control character in a file
  reaches the model as itself, where JSON wrote an escape such as `\u001b`.

  **Who needs to act:**
  - a `code_execution` script that parses one of these results' text as
    JSON (`JSON.parse(result.content[0].text)`): read
    `result.structuredContent`, which holds the fields the JSON held;
  - a host or module that reads these results' fields from `result.data`,
    through `executeToolCall` or `ctx.callTool`: read `result.structured`.
    connectome-host reads either since 0.11.0
    (anima-research/connectome-host#324), and needs that version or later:
    before it, its file viewers show such a file as empty.

  **What a page holds:** a page is held to the call's result limit as its
  text measures it, where it was measured as JSON, and so is a receipt.
  - A model's page holds more of a file whose lines JSON escapes: at the
    default 24,000 characters, a page of this repository's
    `src/modules/workspace/index.ts` now ends at line 475, where it ended at
    line 454. A spilled result's notice sizes the read-back page it suggests
    the same way, so below a cap of about 12,300 characters it suggests a
    longer one than before.
  - A script's page is never shorter than before, since a page's text is
    shorter than its JSON, unless the text quotes its path or a note. A script's answer carries the result's fields, a
    page's content among them, beside the text, and the limit counts the
    text alone. A script's limit counts each character at the six bytes it
    takes at most in the answer, and only a control character takes more
    than three, so the two together can pass what the script takes only on
    a page of more than half that limit (about 3.7 million characters at
    the default 128 MiB of script memory) that holds control characters.
    Such a page answers `ResultTooLarge`, which cuts nothing, and the script
    reads a smaller page.

  **Unchanged:** the tools' descriptions and inputs; the words of their
  notes; their errors, which were text already; the results of `write`,
  `delete`, `ls`, `glob`, `status`, `materialize`, `sync` and the other
  workspace tools, whose fields stay in `data`; and a page for a call made
  in process without a result limit, which holds to its line limit alone.
