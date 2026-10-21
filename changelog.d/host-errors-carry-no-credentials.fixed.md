- An error a host's own call to agent-framework gets, thrown, rejected with
  or in an error answer's data, no longer carries a credential the framework
  replaces in its records, whoever wrote its words. Before:
  - a server's words in an error built from them were cut to 200 code
    points, with control characters replaced, before anything redacted
    them. That covers an initialize error, a refusal of the protocol
    revision, the revision a legacy server answered with, and a tool call's
    error answer. A credential the cut split kept its start in the
    framework's records and in an agent's tool result, and one holding a
    control character survived changed. An error answer's words were also
    trimmed first, so a credential ending in a space at their end survived
    whole. The caller of a connection got the server's words, an error
    answer's data, the revisions a refusal lists and a tools/list cursor in
    its errors unredacted;
  - a failed legacy handshake's `stderrTail` was the end of the server's
    stderr as written, cut before anything redacted it;
  - a modern connection's failed connect handed the host the SDK's error as
    raised, with the url in its words, and under Bun in its `path`;
  - a legacy stdio server that couldn't be started was refused with Node's
    error as the `cause`, its command line in `spawnargs`, and an argument
    Node refuses quoted in the words;
  - `McplUnreapedLaunchError` printed its connection's configuration,
    credentials included, wherever the error was inspected.

  Now each error redacts the server's words where it's built, then trims and
  bounds them, and redacts the strings in an error answer's data. In that
  data, a number whose digits hold a credential, as JavaScript reads the
  number, becomes a string, its digits with the credential replaced; a
  number with more significant digits than a double holds has lost its last
  ones before that. A redacted key that comes out the same as another key is
  numbered (`redacted (2)`), and data nested past 64 levels reads
  `[withheld: nested too deep to redact]`. A failed handshake's `stderrTail`
  is the same end of the server's stderr, with every credential of up to
  14,336 characters that reaches into it replaced whole. A library's error
  is handed on as its name and its redacted words alone, with a launch
  failure's `code`: a legacy stdio server that couldn't be started is
  refused with its words redacted and a `cause` that keeps Node's error's
  name, those words and its `code`, and nothing else of it; when Node
  refuses an argument or an env value at once, the words leave the value
  out. `McplUnreapedLaunchError.connection` isn't enumerable. With a
  configuration that can't be read, the server's words are withheld, as the
  records already withhold them, and an error answer's data is withheld
  whole.
- The record of a tools/call or push/render answer that came after its
  deadline is redacted as an on-time answer's record is.
