- **A stdio MCP server whose pipe fails while it's connecting no longer reads
  as connected, in both engines.** Such a connect now fails: one whose
  transport found the child's stdin or stdout failed before the connection
  was taken on, as when the modern engine's connect-time list-change
  subscribe, or the legacy engine's answer to a ping the server sent during
  the handshake, meets EPIPE. Before, unless the child had already exited,
  the modern connect was taken on once that subscribe gave up, and the legacy
  handshake took an initialize answer that came afterwards. The connection
  then read as connected while refusing every call as not sent, and said the
  host was reconnecting to it when reconnect was on, until the child exited;
  for a child that outlived SIGKILL that never came, and nothing held or
  reported the launch. The connect's error is now `MCP server "<id>" stdio
  pipe failed with <error> while connecting` (modern) or `MCPL server "<id>"
  stdio pipe failed with <error> during the handshake` (legacy). A child that
  can't be reaped is held as for any failed connect: `connect()` throws
  `McplUnreapedLaunchError`, and a reconnect's failure is a permanent
  `reconnect-failed`. A modern connect that the SDK resolved after such a
  failure had already ended the child, which read `MCP server "<id>" closed
  its connection while connecting`, now names the pipe too. A connect that
  fails some other way after its pipe failed, such as one the SDK rejects,
  keeps its words.
