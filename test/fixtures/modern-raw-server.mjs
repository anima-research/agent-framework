// A hand-written modern-MCP (2026-07-28) stdio server, for the edge cases an
// SDK server won't produce on request. It logs every launch and request to
// a JSONL file, so tests can check what reached the wire against what the
// client reports.
// Usage: node modern-raw-server.mjs <flags> <log>
// Flags, comma-separated:
//   invalid-schema       tools/list advertises an outputSchema that doesn't compile
//   listen-fail-first    the first subscriptions/listen of each launch is refused
//   hang-discover-later  launches after the first never answer server/discover
//   hang-discover        no launch ever answers server/discover
//   reject-discover-later  launches after the first answer server/discover with an error
//   ignore-sigterm       the process survives SIGTERM (only SIGKILL ends it)
// Tools: op (outputSchema {value: integer}, answers with a string: invalid
// structured content), plain (text), err (a JSON-RPC error), touch (announces
// a tool list change on the open subscription), nullframe (writes JSON lines
// that aren't JSON-RPC messages, then answers), cont (a state-only
// input_required first leg; the second leg does what arguments.leg2 says:
// 'error', 'hang' or 'ok'), die (exits).
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

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

createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  note({ event: m.id === undefined ? 'notification' : 'request', method: m.method, id: m.id ?? null, ...(m.method === 'tools/call' ? { tool: m.params?.name } : {}) });
  switch (m.method) {
    case 'server/discover':
      if (flags.has('hang-discover-later') && launch > 1) return;
      if (flags.has('hang-discover')) return;
      if (flags.has('reject-discover-later') && launch > 1) return error(m.id, -32603, 'not today');
      return result(m.id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: { listChanged: true } },
        ttlMs: 60000,
        cacheScope: 'private',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'raw-fixture', version: '1' } },
      });
    case 'subscriptions/listen':
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
          { name: 'err', inputSchema: { type: 'object' } },
          { name: 'touch', inputSchema: { type: 'object' } },
          { name: 'nullframe', inputSchema: { type: 'object' } },
          { name: 'cont', inputSchema: { type: 'object' } },
          { name: 'die', inputSchema: { type: 'object' } },
        ],
      });
    case 'tools/call': {
      const name = m.params?.name;
      if (name === 'op') return result(m.id, { content: [], structuredContent: { value: 'not an integer' } });
      if (name === 'err') return error(m.id, -32603, 'boom', { why: 'on purpose' });
      if (name === 'touch') {
        if (subscription !== null) {
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { [SUB]: subscription } } });
        }
        return result(m.id, { content: [{ type: 'text', text: subscription === null ? 'no subscription' : 'touched' }] });
      }
      if (name === 'die') { setTimeout(() => process.exit(5), 10); return result(m.id, { content: [{ type: 'text', text: 'bye' }] }); }
      if (name === 'nullframe') {
        process.stdout.write('null\n[1,2]\n"just a string"\n{"no":"jsonrpc"}\n');
        return result(m.id, { content: [{ type: 'text', text: 'after the noise' }] });
      }
      if (name === 'cont') {
        const leg2 = m.params?.arguments?.leg2;
        if (m.params?.requestState === undefined) {
          return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'input_required', requestState: `state-for-${leg2}` } });
        }
        if (leg2 === 'error') return error(m.id, -32603, 'second leg failed', { leg: 2, state: m.params.requestState });
        if (leg2 === 'hang') return;
        return result(m.id, { content: [{ type: 'text', text: `leg 2 done (${m.params.requestState})` }] });
      }
      return result(m.id, { content: [{ type: 'text', text: 'plain' }] });
    }
    default:
      if (m.id !== undefined) error(m.id, -32601, `Method not found: ${m.method}`);
  }
});
process.stdin.on('end', () => process.exit(0));
