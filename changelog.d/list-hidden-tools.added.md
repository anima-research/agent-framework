- `list_hidden_tools`, a third tool-presentation tool, lists the tools the
  resident has hidden, each with the description it would show, so deciding
  to show one again needs no catalogue read. The two editing tools'
  descriptions point to it instead of to `workspace--read` of the catalogue,
  and the unknown-name refusal of `set_tool_visibility` and
  `set_tool_description` keeps its closest-names hint but no longer tells the
  resident to read the catalogue: the visible tools are already in the
  request, and a catalogue read puts every description into context a second
  time. `list_hidden_tools` can't be hidden, like the two editing tools.
