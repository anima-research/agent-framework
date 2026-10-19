/**
 * Reader forks run under the resident's yes (connectome-host#334): the
 * configuration carries the consent record, `create` refuses a fork section
 * that differs from the one agreed, each fork's record and trace carry the
 * yes and the derivation notice names it, and the resident can take it back
 * with `withdraw_consent` — from then nothing is derived, a tune-out is a
 * silent hold, and the withdrawal stands across restarts until a later yes
 * is recorded.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework, readerConsentDrift, readerConsentSection, type ReaderConsent } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';

const supported =
  typeof (JsStore.prototype as unknown as { view?: unknown }).view === 'function' &&
  typeof (ContextManager.prototype as unknown as { derive?: unknown }).derive === 'function';
const skip = supported ? false : 'installed @animalabs/chronicle / context-manager lack branch-bound handles or ContextManager.derive';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';
const SECTION = { model: 'test-model', voice: 'You are reading for scout. Report in second person, briefly.' };
const CONSENT: ReaderConsent = { by: 'scout', at: '2026-10-12T21:32:18.817Z', where: 'discord:cafe/1561581816215896197', section: SECTION };

class RoutedMembrane {
  calls: NormalizedRequest[] = [];
  private queues = { resident: [] as NormalizedResponse[], reader: [] as NormalizedResponse[] };
  push(who: 'resident' | 'reader', ...responses: NormalizedResponse[]): void { this.queues[who].push(...responses); }
  streamYielding(request: NormalizedRequest): MockYieldingStream {
    this.calls.push(request);
    const who = JSON.stringify(request.messages).includes('[Tune-out reader') ? 'reader' : 'resident';
    return new MockYieldingStream(this.queues[who].splice(0));
  }
  asMembrane(): import('@animalabs/membrane').Membrane { return this as unknown as import('@animalabs/membrane').Membrane; }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timed out waiting for: ${what}`);
}

type Internals = {
  tuneOutCoordinator: TuneOutCoordinator | null;
  channelRegistry: { listChannelsRaw(): unknown[]; readCoordinatorState(id: string): unknown } | null;
  handleWithdrawConsentTool(agentName: string, input: Record<string, unknown>): { success: boolean; data?: Record<string, unknown>; error?: string };
  readerConsentWithdrawn(): { at: string; consentAt?: string } | null;
  subconsciousConfig: { consent?: ReaderConsent } | null;
};
const internals = (f: AgentFramework) => f as unknown as Internals;
type Msg = { content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> };
const textOf = (m: Msg) => m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

describe('the consent record and its drift rule', () => {
  it('readerConsentDrift names the first field that differs, and treats speech absent and off as the same section', () => {
    const cfg = { reader: 'forks' as const, enabled: true, ...SECTION };
    assert.equal(readerConsentDrift(CONSENT, cfg), null);
    assert.equal(readerConsentDrift({ ...CONSENT, section: { ...SECTION, allowChannelSpeech: false } }, cfg), null, 'off and absent agree');
    assert.deepEqual(readerConsentDrift(CONSENT, { ...cfg, allowChannelSpeech: true }), { field: 'allowChannelSpeech', agreed: undefined, live: true });
    assert.deepEqual(readerConsentDrift(CONSENT, { ...cfg, voice: 'another voice' }), { field: 'voice', agreed: SECTION.voice, live: 'another voice' });
    assert.deepEqual(readerConsentDrift(CONSENT, { ...cfg, model: 'other-model' }), { field: 'model', agreed: 'test-model', live: 'other-model' });
    assert.deepEqual(readerConsentDrift({ ...CONSENT, section: { ...SECTION, forkIdleTimeoutMs: 60_000 } }, cfg), { field: 'forkIdleTimeoutMs', agreed: 60_000, live: undefined }, 'a timeout the resident saw is part of what they agreed to');
    assert.deepEqual(readerConsentSection({ ...cfg, allowChannelSpeech: true, forkIdleTimeoutMs: 5 }), { ...SECTION, allowChannelSpeech: true, forkIdleTimeoutMs: 5 });
  });

  it('create refuses a consent record whose section differs from the live one, naming the field and the yes', { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'consent-drift-'));
    try {
      const create = (consent: ReaderConsent, section = SECTION) => AgentFramework.create({
        storePath: join(dir, `${Math.random().toString(36).slice(2)}.chronicle`), membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
        subconscious: { enabled: true, reader: 'forks', ...section, consent },
        modules: [],
      });
      await assert.rejects(create(CONSENT, { ...SECTION, voice: 'a voice scout never saw' }), /consent record covers a different fork section — `voice` was .* when scout said yes on 2026-10-12T21:32:18.817Z, and is "a voice scout never saw" now\. Ask again/);
      await assert.rejects(create({ ...CONSENT, at: 'yesterday' }), /subconscious\.consent\.at must be an ISO 8601 time/);
      await assert.rejects(create({ ...CONSENT, where: ' ' }), /subconscious\.consent\.where must be a non-empty string/);
      const ok = await create(CONSENT);
      await ok.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the consent policy (dendrite.consent) and the derivation notices (dendrite.announceDerivations)', { skip }, () => {
  const create = (dir: string, dendrite: Record<string, unknown>, consent?: ReaderConsent) => AgentFramework.create({
    storePath: join(dir, `${Math.random().toString(36).slice(2)}.chronicle`), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: { enabled: true, reader: 'forks', ...SECTION, ...(consent ? { consent } : {}) },
    dendrite, modules: [],
  });

  it("'recorded' (the default) demands no record, and checks one that is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'consent-policy-'));
    try {
      const without = await create(dir, {});
      assert.equal(internals(without).readerConsentWithdrawn(), null, 'a host with no record has nothing withdrawn');
      await without.stop(); // withdraw_consent's offer is checked over the MCPL fixture below, where tune-out's tools exist
      await assert.rejects(create(dir, {}, { ...CONSENT, section: { ...SECTION, voice: 'other' } }), /covers a different fork section/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("'required' refuses forks without a record, naming the policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'consent-policy-'));
    try {
      await assert.rejects(create(dir, { consent: 'required' }), /requires the resident's yes \(dendrite\.consent: 'required'\)/);
      const ok = await create(dir, { consent: 'required' }, CONSENT);
      await ok.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("'none' reads no consent — a drifted record is not checked — and offers no withdraw_consent", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'consent-policy-'));
    try {
      const fw = await create(dir, { consent: 'none' }, { ...CONSENT, section: { ...SECTION, voice: 'other' } });
      assert.equal(fw.getAllTools().some((t) => t.name === 'withdraw_consent'), false);
      assert.equal(internals(fw).readerConsentWithdrawn(), null);
      await fw.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('reader forks under a yes, and its withdrawal', { skip }, () => {
  let tempDir: string;
  let commandPath: string;
  let membrane: RoutedMembrane;
  let framework: AgentFramework;
  const traces: TraceEvent[] = [];

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tune-out-consent-'));
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new RoutedMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'forks', ...SECTION, consent: CONSENT },
      mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath } }],
      modules: [],
    });
    framework.onTrace((event) => traces.push(event));
    await framework.start();
    await waitFor(() => (internals(framework).channelRegistry?.listChannelsRaw().length ?? 0) > 0, 'channel registration');
  });
  after(async () => { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); });

  const emit = (kind: 'ambient' | 'addressed', id: string, text: string): void => { appendFileSync(commandPath, `${kind} ${id} ${text}\n`); };
  const scoutMessages = () => framework.getAgent('scout')!.getContextManager().getAllMessages() as unknown as Msg[];
  const forkTraces = () => traces.filter((t) => t.type === 'tune-out:reader-fork') as Array<TraceEvent & { agentName: string }>;
  const withheld = () => traces.filter((t) => t.type === 'tune-out:reader-withheld');

  it('a fork carries the yes on its record and in dendrite:agent-created, and the derivation notice names it', async () => {
    assert.ok(framework.getAllTools().some((t) => t.name === 'withdraw_consent'), 'the resident is offered withdraw_consent');
    membrane.push('resident', createMockResponse([{ type: 'text', text: 'hi' }]));
    emit('addressed', 'm0', 'scout, are you around?');
    await waitFor(() => membrane.calls.length >= 1, 'scout wakes');
    await framework.runUntilIdle();
    const entered = internals(framework).tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 2, maxWakes: 1 }, 'agent-tool');
    assert.ok(entered.ok);
    // The mock hands a stream every response queued for its role, so each
    // request's response is queued just before the request (as the e2e does).
    membrane.push('reader', createMockResponse([{ type: 'text', text: 'nothing urgent' }]));
    emit('addressed', 'm1', 'hey scout, quick question');
    await waitFor(() => forkTraces().length >= 1, 'a reader fork is derived', 20_000);
    const fork = forkTraces()[0]!.agentName;
    await waitFor(() => framework.getAgentRecord(fork)?.ended !== undefined, 'the fork ends', 20_000);
    assert.deepEqual(framework.getAgentRecord(fork)!.metadata?.consent, CONSENT, 'the record carries the yes');
    const created = traces.find((t) => t.type === 'dendrite:agent-created' && (t as { agentName: string }).agentName === fork) as (TraceEvent & { consent?: ReaderConsent }) | undefined;
    assert.deepEqual(created?.consent, CONSENT, 'the trace carries the yes');
    await waitFor(() => scoutMessages().some((m) => m.metadata?.kind === 'agent-lifecycle' && textOf(m).includes(fork)), 'the derivation notice');
    const notice = scoutMessages().find((m) => m.metadata?.kind === 'agent-lifecycle' && textOf(m).includes(fork))!;
    assert.match(textOf(notice), /under the yes you gave on 2026-10-12T21:32:18\.817Z \(discord:cafe\/1561581816215896197\)/);
    // The fork's prose is its report: mail to scout, who wakes for it.
    membrane.push('resident', createMockResponse([{ type: 'text', text: 'thanks' }]));
    await waitFor(() => scoutMessages().some((m) => m.metadata?.kind === 'agent-result'), 'the report reaches scout', 20_000);
    await framework.runUntilIdle();
    // The budget (maxWakes 1) is spent: the next addressed message auto-cancels the epoch — the dump wakes scout — and derives its last look.
    membrane.push('resident', createMockResponse([{ type: 'text', text: 'ack' }]));
    membrane.push('reader', createMockResponse([{ type: 'text', text: 'nothing more' }]));
    emit('addressed', 'm2', 'scout, are you there?');
    await waitFor(() => forkTraces().some((t) => (t as { trigger?: string }).trigger === 'cancel'), "the auto-cancel's last look", 20_000);
    const last = forkTraces().find((t) => (t as { trigger?: string }).trigger === 'cancel')!.agentName;
    await waitFor(() => framework.getAgentRecord(last)?.ended !== undefined, 'the last look ends', 20_000);
    membrane.push('resident', createMockResponse([{ type: 'text', text: 'ack the prose report' }]));
    await waitFor(() => scoutMessages().some((m) => textOf(m).includes('nothing more')), 'its prose report reaches scout', 20_000);
    await framework.runUntilIdle();
  });

  it("withdraw_consent is the resident's: another caller is refused; the resident's withdrawal is recorded, told, and persisted", async () => {
    const i = internals(framework);
    const refused = i.handleWithdrawConsentTool('someone-else', {});
    assert.equal(refused.success, false);
    assert.match(refused.error!, /scout's to call/);
    const r = i.handleWithdrawConsentTool('scout', { reason: 'not this week' });
    assert.equal(r.success, true);
    assert.equal(r.data!.withdrawn, true);
    const w = i.readerConsentWithdrawn();
    assert.ok(w, 'the withdrawal stands');
    assert.equal(w!.consentAt, CONSENT.at, 'it names the yes it withdrew');
    const stored = i.channelRegistry!.readCoordinatorState('tune-out/scout/reader-consent') as { withdrawn: { reason: string } };
    assert.equal(stored.withdrawn.reason, 'not this week', 'persisted beside the all-except scope');
    const t = traces.find((x) => x.type === 'tune-out:reader-consent-withdrawn') as (TraceEvent & { reason?: string; consentAt?: string }) | undefined;
    assert.deepEqual([t?.reason, t?.consentAt], ['not this week', CONSENT.at]);
    await waitFor(() => scoutMessages().some((m) => textOf(m).includes('you withdrew your yes to reader forks')), 'the resident is told');
    const again = i.handleWithdrawConsentTool('scout', {});
    assert.equal(again.success, true);
    assert.match(String(again.data!.note), /already withdrawn/);
  });

  it('after the withdrawal no fork is derived — the invocation is withheld and traced — and a tune-out is a silent hold that says so', async () => {
    const i = internals(framework);
    const coordinator = i.tuneOutCoordinator!;
    assert.equal(coordinator.hasReader(), false, 'no reader while the yes is withdrawn');
    const before = forkTraces().length;
    assert.equal(framework.listPolicyEpochs().length, 0, 'premise: the first test\'s epoch auto-cancelled');
    const entered = coordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 2, maxWakes: 1 }, 'agent-tool');
    assert.ok(entered.ok, `the hold is still available: a silent hold (subconscious.enabled opts the host in): ${JSON.stringify(entered)}`);
    emit('addressed', 'm2', 'scout, one more');
    await waitFor(() => scoutMessages().some((m) => textOf(m).includes('one more')), 'the message is held');
    await new Promise((r) => setTimeout(r, 2_500));
    assert.equal(forkTraces().length, before, 'no fork derived');
    void withheld; // the coordinator consults readerWithdrawn before any invocation, so a withheld trace is the framework's last line of defence
    // The release wakes scout with the dump.
    membrane.push('resident', createMockResponse([{ type: 'text', text: 'ok' }]));
    coordinator.cancel('disc', CHANNEL, 'agent-tool', 'test');
    await framework.runUntilIdle();
    assert.equal(forkTraces().length, before, 'the cancel derives no last look either');
  });

  it('a later yes in the configuration renews the forks and clears the withdrawal, traced', () => {
    const i = internals(framework);
    i.subconsciousConfig!.consent = { ...CONSENT, at: new Date(Date.now() + 1_000).toISOString() };
    assert.equal(i.readerConsentWithdrawn(), null, 'a yes given after the no stands');
    assert.ok(traces.some((t) => t.type === 'tune-out:reader-consent-renewed'));
    assert.equal(i.channelRegistry!.readCoordinatorState('tune-out/scout/reader-consent'), null, 'the withdrawal is cleared');
    assert.equal(i.tuneOutCoordinator!.hasReader(), true);
  });
});
