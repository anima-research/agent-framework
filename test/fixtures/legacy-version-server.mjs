// Stdio MCP server for the legacy engine's protocol-version and pagination
// tests. Usage: node legacy-version-server.mjs <mode> [startLog]
//
// Modes (how `initialize` is answered):
//   ok            protocolVersion 2024-11-05
//   reject        error -32022 with data { supported: ['2026-07-28'], requested }
//   reject-old    error -32022 with data { supported: ['2025-03-26'], requested }
//   reject-nodata error -32022 without data
//   mismatch      protocolVersion 2025-06-18
//   missing       no protocolVersion at all
//   error         a JSON-RPC error (-32603), not a version verdict
//   hang          never answers
//   slow          `ok`, after SLOW_INIT_MS (default 600)
//   deaf-ping     at initialize, closes its stdin and says so on stderr, then
//                 pings the client, whose answer fails with EPIPE; answers
//                 `ok` once it gets SIGUSR2, and stays up
//   deaf-ping-answered  as deaf-ping, but sends nothing until SIGUSR2, then
//                 writes the ping and the `ok` answer together, so the client
//                 reads both in one callback
//   ok-then-<mode>  `ok` on the first start recorded in startLog, <mode> after
//
// IGNORE_SIGTERM=1 makes the process survive SIGTERM (only SIGKILL ends it),
// noting each SIGTERM it gets in <startLog>.sigterm.
//
// tools/list pages: by default three pages (cursors p2, p3). MODE_LIST picks
// an edge case: loop (always nextCursor "same"), empty (nextCursor "" then a
// second page), notools (no tools array), badcursor (nextCursor 5),
// nullcursor (nextCursor null), endless (a new cursor on every page, so the
// list never ends), badlater (a well-formed first page, then a page with no
// tools array). Tool `die` exits the process.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from 'node:fs';

let mode = process.argv[2] ?? 'ok';
const startLog = process.argv[3];
if (startLog) {
  const priorStarts = existsSync(startLog) ? readFileSync(startLog, 'utf8').split('\n').filter(Boolean).length : 0;
  appendFileSync(startLog, `start ${process.pid}\n`);
  if (mode.startsWith('ok-then-')) mode = priorStarts === 0 ? 'ok' : mode.slice('ok-then-'.length);
}
if (process.env.IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => { if (startLog) appendFileSync(`${startLog}.sigterm`, `sigterm ${process.pid}\n`); });
}
const listMode = process.env.MODE_LIST ?? 'pages';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const error = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

const tool = (name) => ({ name, description: name, inputSchema: { type: 'object' } });

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      const requested = m.params?.protocolVersion;
      if (mode === 'reject') error(m.id, -32022, `Unsupported protocol version: ${requested}`, { supported: ['2026-07-28'], requested });
      else if (mode === 'reject-old') error(m.id, -32022, `Unsupported protocol version: ${requested}`, { supported: ['2025-03-26'], requested });
      else if (mode === 'reject-nodata') error(m.id, -32022, `Unsupported protocol version: ${requested}`);
      else if (mode === 'mismatch') reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });
      else if (mode === 'missing') reply(m.id, { capabilities: { tools: {} } });
      else if (mode === 'error') error(m.id, -32603, 'initialize failed on purpose');
      else if (mode === 'hang') { /* never answers */ }
      else if (mode === 'slow') setTimeout(() => reply(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} } }), Number(process.env.SLOW_INIT_MS ?? 600));
      else if (mode === 'deaf-ping' || mode === 'deaf-ping-answered') {
        const ok = { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } };
        const ping = { jsonrpc: '2.0', id: 'server-ping', method: 'ping' };
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        // Node keeps a stdio descriptor open when its stream is destroyed, so
        // the read end is closed by hand once the stream is done with it, and
        // /dev/null takes fd 0 at once, as libuv assumes fds 0 to 2 stay taken
        // (see deafen() in modern-raw-server.mjs).
        process.stdin.once('close', () => {
          try { closeSync(0); } catch { /* already closed */ }
          openSync('/dev/null', 'r');
          // SIGUSR2's handler is in place before the stderr line, which a test
          // may take as its cue to send it: until then the signal's default
          // action would end the process.
          process.once('SIGUSR2', mode === 'deaf-ping-answered'
            ? () => process.stdout.write(`${JSON.stringify(ping)}\n${JSON.stringify(ok)}\n`)
            : () => send(ok));
          process.stderr.write('deaf-ping: stdin closed\n');
          if (mode === 'deaf-ping') send(ping);
        });
        process.stdin.destroy();
        setInterval(() => {}, 1 << 30);
        return;
      }
      else reply(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} } });
    } else if (m.method === 'tools/list') {
      const cursor = m.params?.cursor;
      if (listMode === 'loop') reply(m.id, { tools: [tool(`loop-${cursor ?? 'first'}`)], nextCursor: 'same' });
      // '' is an opaque cursor like any other: it continues to a second page.
      else if (listMode === 'empty' && cursor === undefined) reply(m.id, { tools: [tool('first')], nextCursor: '' });
      else if (listMode === 'empty' && cursor === '') reply(m.id, { tools: [tool('second')] });
      else if (listMode === 'notools') reply(m.id, {});
      else if (listMode === 'badcursor') reply(m.id, { tools: [tool('x')], nextCursor: 5 });
      else if (listMode === 'nullcursor') reply(m.id, { tools: [tool('x')], nextCursor: null });
      else if (listMode === 'endless') {
        const n = cursor === undefined ? 1 : Number(String(cursor).slice(1)) + 1;
        reply(m.id, { tools: [tool(`t${n}`)], nextCursor: `c${n}` });
      }
      else if (listMode === 'badlater' && cursor === undefined) reply(m.id, { tools: [tool('first')], nextCursor: 'p2' });
      else if (listMode === 'badlater') reply(m.id, {});
      else if (cursor === undefined) reply(m.id, { tools: [tool('a1'), tool('a2')], nextCursor: 'p2' });
      else if (cursor === 'p2') reply(m.id, { tools: [tool('b1')], nextCursor: 'p3' });
      else if (cursor === 'p3') reply(m.id, { tools: [tool('c1'), tool('die')] });
      else error(m.id, -32602, `unknown cursor ${cursor}`);
    } else if (m.method === 'tools/call') {
      if (m.params?.name === 'die') process.exit(3);
      reply(m.id, { content: [{ type: 'text', text: 'ok' }] });
    } else if (m.id !== undefined) {
      error(m.id, -32601, `Method not found: ${m.method}`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
