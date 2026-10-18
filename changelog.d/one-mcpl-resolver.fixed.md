- A programmatic MCPL tool call, through `executeToolCall` or a module's
  `ctx.callTool`, now reaches the server the model's own call of the name
  reaches, and sends it the same tool name: the server whose tool listing
  offers the name, else the longest matching prefix. It took the first
  configured server whose prefix the name began with, so where one prefix
  begins with another's, such as `foo` beside `foo--bar` or beside `foo-`, it
  reached whichever of the two was configured first (#227, #230). Where two
  servers list the same full name, the listing holds the one listed last
  (#265), and both paths reach that one.
- An MCPL tool's source in the tool presentation now names the server a call
  of it reaches, by the same resolver. **Operators:** a tool's source was the
  first configured server whose prefix its name began with, so with `foo`
  configured before `foo--bar`, a component description profile bound to
  `MCPL server: foo` also described `foo--bar`'s tools. Those tools now take
  the profile bound to `MCPL server: foo--bar`, if there is one, and lose
  `foo`'s descriptions.
- A server's close forgets only its own tools' RFC-008 class declarations.
  Closing `foo` also forgot `foo--bar`'s, leaving its tools unclassed until
  the next tool refresh.
