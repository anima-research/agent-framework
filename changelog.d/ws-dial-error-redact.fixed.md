- A WebSocket client's error no longer quotes the server's credentials.
  Under Bun, the client's own message for a failed dial names the url as
  dialed (its user, password, path and query, and the token, a static one
  or an access provider's), and the dial's error carried that message on as
  it read, to the caller of `connectMcplServer` among others. The client's
  text, for a failed dial, for a client that throws as the socket is
  constructed, and for an error after the socket opened, now has the url as
  dialed and as configured shown as `redactUrl` shows it, the strings the
  configuration and its dials know to be credentials replaced
  (`redactServerText`), and any other ws(s) url masked the same way; the
  error is a new one with no `cause` holding the client's original. Node's
  `ws` quotes no url, so its errors read as before.
