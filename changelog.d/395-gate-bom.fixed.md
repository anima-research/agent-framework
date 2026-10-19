- A `gate.json` or privileged-users file saved as UTF-8 with a leading BOM
  now loads. Before, `JSON.parse` rejected the invisible U+FEFF, and the gate
  reported an error and didn't apply the file (#395).
