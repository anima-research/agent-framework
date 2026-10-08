// MCPL fixture for the RFC-007 tool-lifecycle end-to-end test.
//
// ROLE=provider: offers two tools — `click`, classed `computer` via
//   _meta["mcpl/class"] (RFC-008), and `run`, unclassed. `run` returns an
//   error result. Every result carries RESULT-MARKER, which must never reach
//   an observer (tool results are never carried). A call whose arguments
//   carry `delay_ms` is answered that much later; one carrying `hold` (a
//   file path) is answered once that file exists.
// ROLE=observer: advertises toolLifecycle {observe, inputs}, offers its own
//   tool `ping` (its own calls must not be reported to it), and once the §5.3
//   policy exchange is done sends `tools/observe` with the rules in FILTER
//   (JSON). Received `tools/lifecycle` notifications go to LOG_PATH as JSONL.
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const role = process.env.ROLE ?? 'provider';
// DIE_PATH: exit as soon as this file exists — an unexpected provider death
// (the host has reconnect off, so the registry drops the server).
if (process.env.DIE_PATH) {
  setInterval(() => { if (existsSync(process.env.DIE_PATH)) process.exit(0); }, 50).unref?.();
}
const logPath = process.env.LOG_PATH;
const filter = process.env.FILTER ? JSON.parse(process.env.FILTER) : null;

const log = (event, extra = {}) => {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify({ event, ...extra }) + '\n');
};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

let nextId = 900;
let observeAttempts = 0;
const pendingObserve = new Set();

function sendObserve() {
  const id = nextId++;
  pendingObserve.add(id);
  observeAttempts++;
  send({ jsonrpc: '2.0', id, method: 'tools/observe', params: { rules: filter } });
}

const TOOLS = role === 'provider'
  ? [
    {
      name: 'click',
      description: 'Click at a point',
      inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      _meta: { 'mcpl/class': ['computer'] },
    },
    {
      name: 'run',
      description: 'Run something (declares no class)',
      inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
    },
  ]
  : [
    {
      name: 'ping',
      description: "The observer's own tool",
      inputSchema: { type: 'object', properties: {} },
      _meta: { 'mcpl/class': ['body'] },
    },
  ];

const rl = createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Responses to our own tools/observe requests.
  if (msg.id !== undefined && pendingObserve.has(msg.id) && !msg.method) {
    pendingObserve.delete(msg.id);
    if (msg.error) {
      log('observe-error', { code: msg.error.code, message: msg.error.message });
      // -32002 before the grant is active: the policy receipt races our send.
      if (msg.error.code === -32002 && observeAttempts < 40) setTimeout(sendObserve, 100);
    } else {
      log('observe-applied', { result: msg.result });
    }
    return;
  }

  if (msg.method === 'initialize') {
    const mcpl = { version: '0.5' };
    if (role === 'observer') {
      mcpl.toolLifecycle = { observe: true, inputs: true };
      mcpl.featureSets = {
        'body.activity': {
          description: "Act out the agent's tool use",
          uses: ['toolLifecycle.observe', 'toolLifecycle.inputs'],
        },
      };
    }
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, experimental: { mcpl } },
      serverInfo: { name: `tool-lifecycle-${role}`, version: '0.0.0' },
    });
    return;
  }
  if (msg.method === 'featureSets/update') {
    log('policy', { effectiveCapabilities: msg.params?.effectiveCapabilities ?? null });
    if (msg.id !== undefined && msg.id !== null) reply(msg.id, { accepted: true });
    if (role === 'observer' && filter && observeAttempts === 0) setTimeout(sendObserve, 50);
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: TOOLS });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    log('tools-call', { name });
    const answer = () => reply(msg.id, {
      content: [{ type: 'text', text: `RESULT-MARKER from ${name}` }],
      isError: name === 'run',
    });
    const hold = msg.params?.arguments?.hold;
    const delayMs = Number(msg.params?.arguments?.delay_ms ?? 0);
    if (typeof hold === 'string') {
      const poll = setInterval(() => {
        if (existsSync(hold)) {
          clearInterval(poll);
          answer();
        }
      }, 20);
    } else if (delayMs > 0) setTimeout(answer, delayMs);
    else answer();
    return;
  }
  if (msg.method === 'tools/lifecycle') {
    log('lifecycle', { params: msg.params });
    return;
  }
  if (msg.method === 'inference/lifecycle') {
    log('inference', { params: msg.params });
    return;
  }
  if (msg.id !== undefined && msg.id !== null && msg.method) {
    // Anything else that expects an answer gets an empty one.
    reply(msg.id, {});
  }
});
