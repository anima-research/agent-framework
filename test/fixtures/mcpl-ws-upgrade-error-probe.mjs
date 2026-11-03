// Runs as a separate process: connects to a WebSocket server that sends a
// frame with a reserved opcode in the same write as its 101 upgrade response,
// before the host has sent initialize. ws raises that frame's 'error' before
// the handshake has attached any listener. Prints "refused after N ms: …"
// when connect() rejects, or "connected"; an 'error' thrown with nothing
// listening would end the process before it prints either.
// Mode "answers-close" (the default): the server answers the client's close
// frame and ends the socket, as most servers do. ws reads nothing more once it
// has failed the connection, so it's the socket's end, not the answering
// frame, that ends the wait. Mode "silent": it never answers or ends, so the
// connect waits out a 30 s timeout, ws's close timeout or the handshake's own.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { McplServerConnection } from '../../src/mcpl/server-connection.js';

const mode = process.argv[2] ?? 'answers-close';
const server = createServer();
server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1')
    .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(Buffer.concat([
    Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    ),
    // A frame header with opcode 3, which RFC 6455 reserves.
    Buffer.from([0x83, 0x00]),
  ]));
  socket.on('error', () => {});
  if (mode === 'answers-close') {
    // The client's next frame is its close frame: answer it with one, and end.
    socket.once('data', () => socket.end(Buffer.from([0x88, 0x00])));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const started = Date.now();
try {
  const connection = await McplServerConnection.connect(
    { id: 'probe', url: `ws://127.0.0.1:${server.address().port}` },
    { version: '0.5' },
  );
  console.log('connected');
  await connection.close();
} catch (error) {
  console.log(`refused after ${Date.now() - started} ms: ${error.message}`);
}
server.closeAllConnections?.();
server.close();
