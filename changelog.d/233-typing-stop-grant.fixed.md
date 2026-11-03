- A typing stop is sent only to a server whose grant includes `channels.typing`,
  as its start and each refresh already were (SPEC §14.1). A server without
  the grant no longer gets a stop for a start it never received.
