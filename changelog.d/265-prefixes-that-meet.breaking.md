- **Operators:** two MCPL servers whose `toolPrefix`es meet are refused, at
  `create()`, at a runtime connect and at a restart (before it disconnects
  anything), with an error naming both servers, both prefixes and the rule
  (#265). Two prefixes meet when one is the other's followed by `-`, or
  begins with the other's followed by `--`, as `foo` and `foo--bar` do. Their
  servers could give one tool name: `foo` listing `bar--echo` and `foo--bar`
  listing `echo` both gave `foo--bar--echo`. Such a name reached the model
  twice, which membrane's native formatter and Anthropic's API refuse, so
  every inference of an agent offered it failed, and in XML tool mode its
  calls reached whichever server listed it last. A configuration with such a
  pair needs one of the two prefixes changed, such as `foo-bar` for
  `foo--bar`. `foo` beside `foo-bar` or `foobar` is fine.
