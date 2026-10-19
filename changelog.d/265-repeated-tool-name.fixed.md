- A tool name an MCPL server lists more than once reaches the model once:
  the server's first listing is offered and the rest are left out (#265).
  The model's tool list carried the name twice, which membrane's native
  formatter and Anthropic's API refuse. Each tool refresh that finds such a
  listing raises an `mcpl-tool-duplicate` ops alert naming the tools; its
  webhook post goes out at most once per server in 15 minutes.
