// Stdio MCP server for the legacy engine's protocol-version and pagination
// tests. Usage: node legacy-version-server.mjs <mode> [startLog]
//
// Modes (how `initialize` is answered):
//   ok            protocolVersion 2024-11-05
//   reject        error -32022 with data { supported: ['2026-07-28'], requested }
//   reject-nodata error -32022 without data
//   mismatch      protocolVersion 2025-06-18
//   missing       no protocolVersion at all
//   ok-then-reject  `ok` on the first start recorded in startLog, `reject` after
//
// tools/list pages: by default three pages (cursors p2, p3). MODE_LIST picks
// an edge case: loop (always nextCursor "same"), empty (nextCursor "" then a
// second page), notools (no tools array), badcursor (nextCursor 5),
// nullcursor (nextCursor null). Tool `die` exits the process.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

let mode = process.argv[2] ?? 'ok';
const startLog = process.argv[3];
if (startLog) {
  const priorStarts = existsSync(startLog) ? readFileSync(startLog, 'utf8').split('\n').filter(Boolean).length : 0;
  appendFileSync(startLog, `start ${process.pid}\n`);
  if (mode === 'ok-then-reject') mode = priorStarts === 0 ? 'ok' : 'reject';
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
      else if (mode === 'reject-nodata') error(m.id, -32022, `Unsupported protocol version: ${requested}`);
      else if (mode === 'mismatch') reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });
      else if (mode === 'missing') reply(m.id, { capabilities: { tools: {} } });
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
