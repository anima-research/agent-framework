import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const statusPath = process.env.STATUS_PATH;
const ledgerPath = process.env.LEDGER_PATH;
const releasePath = process.env.RELEASE_PATH;
const crashPath = process.env.CRASH_PATH;
const generationPath = process.env.GENERATION_PATH;
const listChangePath = process.env.LIST_CHANGE_PATH;
const failReaction = process.env.FAIL_REACTION === '1';
const permanentReaction = process.env.PERMANENT_REACTION === '1';
const failInitialGeneration = process.env.FAIL_INITIAL_GENERATION === '1';
const nestedListChangeGeneration = Number(process.env.NESTED_LIST_CHANGE_GENERATION ?? 0);
const dataMethod = process.env.DATA_METHOD ?? 'push/event';
const serverId = process.env.SERVER_ID ?? 'discord';
const arrivalPath = process.env.ARRIVAL_PATH;
const waitForArrivalPath = process.env.WAIT_FOR_ARRIVAL_PATH;

let generation = 1;
if (generationPath) {
  try {
    generation = Number(readFileSync(generationPath, 'utf8')) + 1;
  } catch {
    // First process for this test.
  }
  writeFileSync(generationPath, String(generation));
}

const log = (event, extra = {}) => {
  if (!statusPath) return;
  appendFileSync(statusPath, JSON.stringify({ event, generation, serverId, ...extra }) + '\n');
};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const request = (id, method, params) => send({ jsonrpc: '2.0', id, method, params });
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const channel = (suffix) => ({
  id: `${serverId}:guild:${suffix}`,
  type: serverId,
  label: suffix,
  direction: 'bidirectional',
});

if (failInitialGeneration && generation === 1) {
  log('initial-connect-failure');
  process.exit(9);
}

let initialized = false;
let registered = false;
let registrationReceived = false;
let pendingToolRequest = null;
let reactionQueued = false;
let pendingControl = false;
let listChangeTriggered = false;
let reactionOrdinal = 0;
let buf = '';

function ledgerDeliveryStatus() {
  if (!ledgerPath) return 'missing';
  try {
    const document = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    return document.batches?.[0]?.refs?.[0]?.deliveryStatus ?? 'missing';
  } catch {
    return 'unreadable';
  }
}

function maybeReplyToReaction() {
  if (!pendingToolRequest || pendingControl || failReaction) return;
  if (releasePath) {
    if (!existsSync(releasePath)) return;
    const releaseValue = readFileSync(releasePath, 'utf8').trim();
    const releaseOrdinal = Number(releaseValue);
    if (Number.isFinite(releaseOrdinal) && releaseOrdinal < pendingToolRequest.ordinal) return;
  }
  const requestId = pendingToolRequest.id;
  pendingToolRequest = null;
  log('reaction-response');
  reply(requestId, permanentReaction
    ? { isError: true, content: [{ type: 'text', text: 'Unknown Message' }] }
    : { content: [{ type: 'text', text: 'Reaction applied' }] });
}

function serviceReaction(message) {
  if (waitForArrivalPath && !existsSync(waitForArrivalPath)) {
    pendingToolRequest = message;
    return;
  }
  if (!registered) {
    pendingToolRequest = message;
    if (!reactionQueued) {
      reactionQueued = true;
      log('reaction-queued-before-registration');
    }
    return;
  }
  reactionOrdinal++;
  pendingToolRequest = { ...message, ordinal: reactionOrdinal };
  pendingControl = true;
  log('reaction-call', { name: message.params?.name, ordinal: reactionOrdinal });
  request(201, 'channels/register', { channels: [channel('control-during-barrier')] });
  if (
    nestedListChangeGeneration === generation
    && reactionOrdinal === 1
    && !listChangeTriggered
  ) {
    listChangeTriggered = true;
    log('tools-list-changed-notification');
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    sendDataRequest(302, 'list-change');
  }
}

function maybeFinishRegistration() {
  if (!registrationReceived || registered) return;
  if (pendingToolRequest && waitForArrivalPath && !existsSync(waitForArrivalPath)) return;
  if (pendingToolRequest && !reactionQueued) serviceReaction(pendingToolRequest);
  registered = true;
  log('registration-response');
  const queued = pendingToolRequest;
  pendingToolRequest = null;
  if (queued) serviceReaction(queued);
}

function sendDataRequest(id, phase) {
  let params;
  if (dataMethod === 'inference/request') {
    params = {
      featureSet: 'chat',
      messages: [{ role: 'user', content: `must wait for ${phase} awareness` }],
    };
  } else if (dataMethod === 'channels/incoming') {
    params = {
      messages: [{
        channelId: `${serverId}:guild:startup`,
        messageId: `${serverId}-${phase}-incoming-${generation}`,
        author: { id: 'human', name: 'Human' },
        timestamp: new Date().toISOString(),
        content: [{ type: 'text', text: `must wait for ${phase} awareness` }],
      }],
    };
  } else if (dataMethod === 'host/command') {
    params = { command: 'barrier-probe', agentName: 'assistant' };
  } else {
    params = {
      featureSet: 'chat',
      eventId: `${serverId}-${phase}-push-${generation}`,
      timestamp: new Date().toISOString(),
      payload: { content: [{ type: 'text', text: `must wait for ${phase} awareness` }] },
    };
  }
  log('data-request-sent', { method: dataMethod, phase });
  if (arrivalPath) writeFileSync(arrivalPath, `${serverId}:${dataMethod}:${phase}`);
  request(id, dataMethod, params);
}

function beginServerTraffic() {
  if (initialized) return;
  initialized = true;
  log('initialized');
  request(200, 'channels/register', { channels: [channel('startup')] });
  // The reconnect generation carries an inference-bearing event in the same
  // registration window. Initial-start tests use generation 1 as well.
  sendDataRequest(202, 'startup');
}

function handle(message) {
  if (message.method === 'initialize') {
    reply(message.id, {
      capabilities: {
        experimental: {
          mcpl: {
            version: '0.5',
            // §5.4/§6.2: the grant is computed from this advertisement, and
            // admission denies what it cannot contain. This fixture SENDS
            // channels/register, channels/incoming and inference/request, so
            // it must advertise them — with only pushEvents declared, the
            // 0.5 host correctly rejected the released data requests
            // (accepted:false), which is exactly what PR #79's ubuntu CI
            // caught on the inference/request + channels/incoming matrix.
            pushEvents: true,
            inferenceRequest: true,
            channels: { register: true, incoming: true },
            featureSets: {
              chat: { description: 'chat', uses: ['pushEvents'] },
            },
          },
        },
      },
    });
    return;
  }
  if (message.method === 'featureSets/update') {
    // MCPL 0.5 (§5.3/§6.7): the host sends initial policy as a Request and
    // activates the grant only on this degradation receipt. Without it the
    // host times out (15s), the grant stays empty, and every push/channel
    // in these tests is rejected fail-closed.
    if (message.id !== undefined && message.id !== null) {
      reply(message.id, { accepted: true });
    }
    return;
  }
  if (message.method === 'notifications/initialized') {
    beginServerTraffic();
    return;
  }
  if (message.method === 'tools/list') {
    log('tools-list');
    reply(message.id, {
      tools: [
        { name: 'add_reaction', description: 'add', inputSchema: { type: 'object' } },
        { name: 'remove_reaction', description: 'remove', inputSchema: { type: 'object' } },
      ],
    });
    return;
  }
  if (message.method === 'tools/call') {
    serviceReaction(message);
    return;
  }
  if (message.id === 200) {
    registrationReceived = true;
    maybeFinishRegistration();
    return;
  }
  if (message.id === 201) {
    pendingControl = false;
    log('control-response-during-barrier');
    maybeReplyToReaction();
    return;
  }
  if (message.id === 202 || message.id === 302) {
    const event = message.id === 202 ? 'push-response' : 'list-change-push-response';
    const accepted = message.result?.accepted
      ?? message.result?.results?.[0]?.accepted
      ?? (message.error == null);
    log(event, {
      method: dataMethod,
      accepted,
      ledgerStatus: ledgerDeliveryStatus(),
    });
  }
}

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let newline;
  while ((newline = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, newline);
    buf = buf.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      log('server-error', { message: error instanceof Error ? error.message : String(error) });
    }
  }
});

const timer = setInterval(() => {
  if (pendingToolRequest && !registered && waitForArrivalPath && existsSync(waitForArrivalPath)) {
    serviceReaction(pendingToolRequest);
    maybeFinishRegistration();
  }
  maybeReplyToReaction();
  if (listChangePath && existsSync(listChangePath) && !listChangeTriggered) {
    listChangeTriggered = true;
    log('tools-list-changed-notification');
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    sendDataRequest(302, 'list-change');
  }
  if (crashPath && existsSync(crashPath) && generation === 1) {
    log('crashing');
    process.exit(7);
  }
}, 5);
timer.unref();
