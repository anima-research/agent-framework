// A hand-written modern-MCP (2026-07-28) stdio server, for the edge cases an
// SDK server won't produce on request. It logs every launch and request to
// a JSONL file, so tests can check what reached the wire against what the
// client reports.
// Usage: node modern-raw-server.mjs <flags> <log>
// Flags, comma-separated:
//   invalid-schema       tools/list advertises an outputSchema that doesn't compile
//   listen-fail-first    the first subscriptions/listen of each launch is refused
//   exit-on-listen-first  the first launch exits when its subscriptions/listen arrives
//   hang-discover-later  launches after the first never answer server/discover
//   hang-discover        no launch ever answers server/discover
//   reject-discover-later  launches after the first answer server/discover with an error
//   reject-discover      every launch answers server/discover with an error
//   ignore-sigterm       the process survives SIGTERM (only SIGKILL ends it)
//   deaf-at-discover     as server/discover arrives, closes its stdin and only then
//                        answers, so the client's next write (the connect-time
//                        subscriptions/listen) fails with EPIPE; it stays up
//   other-revision       every launch's server/discover lists only a revision the client doesn't speak
//   other-revision-later  launches after the first do
// Tools: op (outputSchema {value: integer}, answers with a string: invalid
// structured content), plain (text), separators (text holding U+2028 and
// U+2029), err (a JSON-RPC error), touch (announces
// a tool list change on the open subscription), nullframe (writes a line
// that isn't JSON and JSON lines that aren't JSON-RPC messages, then
// answers), cont (a state-only input_required first leg; the second leg
// does what arguments.leg2 says:
// 'error', 'hang', 'ok', or 'again' for another state-only round every time.
// arguments.leg1 'exit' stops reading its input, answers the first leg and
// exits once that answer is written, so no second leg can reach it, and
// 'elicit' asks for elicitation input instead), task (a result type this
// revision doesn't define), bare (a result with no resultType), die (exits),
// vanish (exits without answering), deafen (answers, then closes its stdin and
// stays up, so the next write to it fails with EPIPE).
import { createInterface } from 'node:readline';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from 'node:fs';

const [flagList = '', log] = process.argv.slice(2);
const flags = new Set(flagList.split(',').filter(Boolean));
const prior = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const launch = prior.filter((x) => x.event === 'start').length + 1;
const note = (x) => appendFileSync(log, `${JSON.stringify({ ...x, launch })}\n`);
note({ event: 'start', pid: process.pid });
if (flags.has('ignore-sigterm')) process.on('SIGTERM', () => note({ event: 'sigterm-ignored' }));

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const result = (id, body) => send({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...body } });
const error = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const SUB = 'io.modelcontextprotocol/subscriptionId';

let listens = 0;
let subscription = null;

const discovered = (id) => result(id, {
  supportedVersions: ['2026-07-28'],
  capabilities: { tools: { listChanged: true } },
  ttlMs: 60000,
  cacheScope: 'private',
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'raw-fixture', version: '1' } },
});

/** Close stdin and stay up, so the next write to this process fails with
 *  EPIPE; `then` runs once the read end is closed. */
function deafen(then = () => {}) {
  // Node keeps a stdio descriptor open when its stream is destroyed, so
  // the read end is closed by hand once the stream is done with it, and
  // /dev/null takes fd 0 at once: libuv assumes fds 0 to 2 stay taken, and
  // on macOS this sequence, with fd 0 left free, was aborted at its first
  // stdout write by libuv's assertion `fd > STDERR_FILENO`.
  process.stdin.once('close', () => {
    try { closeSync(0); } catch { /* already closed */ }
    openSync('/dev/null', 'r');
    note({ event: 'deaf' });
    then();
  });
  lines.close();
  process.stdin.destroy();
  // Nothing else keeps the process up once its stdin is gone.
  setInterval(() => {}, 1 << 30);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  note({ event: m.id === undefined ? 'notification' : 'request', method: m.method, id: m.id ?? null, ...(m.method === 'tools/call' ? { tool: m.params?.name } : {}) });
  switch (m.method) {
    case 'server/discover':
      if (flags.has('other-revision') || (flags.has('other-revision-later') && launch > 1)) {
        return result(m.id, {
          supportedVersions: ['2099-01-01'],
          capabilities: { tools: {} },
          ttlMs: 60000,
          cacheScope: 'private',
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'raw-fixture', version: '1' } },
        });
      }
      if (flags.has('hang-discover-later') && launch > 1) return;
      if (flags.has('hang-discover')) return;
      if (flags.has('reject-discover-later') && launch > 1) return error(m.id, -32603, 'not today');
      if (flags.has('reject-discover')) return error(m.id, -32603, 'not today');
      if (flags.has('deaf-at-discover')) return deafen(() => discovered(m.id));
      return discovered(m.id);
    case 'subscriptions/listen':
      if (flags.has('exit-on-listen-first') && launch === 1) process.exit(0);
      listens++;
      if (flags.has('listen-fail-first') && listens === 1) return error(m.id, -32603, 'first listen unavailable');
      subscription = m.id;
      return send({
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: { notifications: { toolsListChanged: true }, _meta: { [SUB]: m.id } },
      });
    case 'tools/list':
      // 2026-07-28 list results carry cache hints.
      return result(m.id, {
        ttlMs: 60000,
        cacheScope: 'private',
        tools: [
          {
            name: 'op',
            inputSchema: { type: 'object' },
            outputSchema: {
              type: 'object',
              properties: { value: { type: flags.has('invalid-schema') ? 'not-a-json-schema-type' : 'integer' } },
              required: ['value'],
            },
          },
          { name: 'plain', inputSchema: { type: 'object' } },
          { name: 'separators', inputSchema: { type: 'object' } },
          { name: 'err', inputSchema: { type: 'object' } },
          { name: 'touch', inputSchema: { type: 'object' } },
          { name: 'nullframe', inputSchema: { type: 'object' } },
          { name: 'cont', inputSchema: { type: 'object' } },
          { name: 'task', inputSchema: { type: 'object' } },
          { name: 'bare', inputSchema: { type: 'object' } },
          { name: 'die', inputSchema: { type: 'object' } },
          { name: 'vanish', inputSchema: { type: 'object' } },
          { name: 'deafen', inputSchema: { type: 'object' } },
        ],
      });
    case 'tools/call': {
      const name = m.params?.name;
      if (name === 'op') return result(m.id, { content: [], structuredContent: { value: 'not an integer' } });
      if (name === 'err') return error(m.id, -32603, 'boom', { why: 'on purpose' });
      if (name === 'separators') return result(m.id, { content: [{ type: 'text', text: 'one\u2028two\u2029three' }] });
      if (name === 'touch') {
        if (subscription !== null) {
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { [SUB]: subscription } } });
        }
        return result(m.id, { content: [{ type: 'text', text: subscription === null ? 'no subscription' : 'touched' }] });
      }
      if (name === 'die') { setTimeout(() => process.exit(5), 10); return result(m.id, { content: [{ type: 'text', text: 'bye' }] }); }
      if (name === 'vanish') process.exit(6);
      if (name === 'deafen') {
        result(m.id, { content: [{ type: 'text', text: 'deaf now' }] });
        deafen();
        return;
      }
      if (name === 'task') return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 'task-1' } });
      if (name === 'bare') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'no resultType' }] } });
      if (name === 'nullframe') {
        process.stdout.write('plain words, not json\nnull\n[1,2]\n"just a string"\n{"no":"jsonrpc"}\n');
        return result(m.id, { content: [{ type: 'text', text: 'after the noise' }] });
      }
      if (name === 'cont') {
        const { leg1, leg2 } = m.params?.arguments ?? {};
        if (m.params?.requestState === undefined) {
          if (leg1 === 'elicit') {
            return send({
              jsonrpc: '2.0',
              id: m.id,
              result: {
                resultType: 'input_required',
                inputRequests: { confirm: { method: 'elicitation/create', params: { message: 'Proceed?', requestedSchema: { type: 'object', properties: {} } } } },
              },
            });
          }
          const answer = { jsonrpc: '2.0', id: m.id, result: { resultType: 'input_required', requestState: `state-for-${leg2}` } };
          // Stopping its input first, rather than exiting on a timer, keeps a
          // second leg out whatever the timing: the client's next round can
          // only meet the exit or a pipe nobody reads.
          if (leg1 === 'exit') return deafen(() => process.stdout.write(`${JSON.stringify(answer)}\n`, () => process.exit(5)));
          send(answer);
          return;
        }
        if (leg2 === 'error') return error(m.id, -32603, 'second leg failed', { leg: 2, state: m.params.requestState });
        if (leg2 === 'hang') return;
        if (leg2 === 'again') return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'input_required', requestState: `${m.params.requestState}+` } });
        return result(m.id, { content: [{ type: 'text', text: `leg 2 done (${m.params.requestState})` }] });
      }
      return result(m.id, { content: [{ type: 'text', text: 'plain' }] });
    }
    default:
      if (m.id !== undefined) error(m.id, -32601, `Method not found: ${m.method}`);
  }
});
process.stdin.on('end', () => process.exit(0));
