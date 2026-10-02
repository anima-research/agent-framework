- MCPL tool calls under nested tool prefixes (one server's prefix `foo`,
  another's `foo--bar`) went to whichever prefix was registered first. A
  call now goes to the server whose `tools/list` produced the name; a name
  no live server listed goes to the longest matching prefix.
  `listMcplServers()` counts and lists each tool under that one server.
