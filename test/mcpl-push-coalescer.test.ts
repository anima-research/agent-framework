import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushCoalescer, CoalesceError, PUSH_COALESCING_SUPPORT, type CoalescedPush, type CoalescerOptions, type PushRenderResult } from '../src/mcpl/push-coalescer.js';

import { MemoryCoalescingJournal, journalRecords } from './helpers/coalescing-journal.js';

function push(id: string, text = id, flags: Record<string, unknown> = {}, override: Partial<CoalescedPush> = {}): CoalescedPush {
  return { serverId: 'server', epoch: 'epoch', audience: 'agent', params: {
    featureSet: 'doc', eventId: id, timestamp: '2026-09-30T00:00:00Z',
    coalesce: { key: 'K', ...flags }, payload: { content: text ? [{ type: 'text', text }] : [] },
  }, ...override };
}
function pending<T>() {
  let resolve!: (v: T) => void;
  let reject!: (v: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(overrides: Partial<CoalescerOptions> = {}) {
  const deliveries: CoalescedPush[] = [], wakes: string[] = [], calls: unknown[] = [];
  const journal = overrides.journal ?? new MemoryCoalescingJournal();
  const c = new PushCoalescer({
    journal, authorized: () => true,
    render: async (_push, params) => { calls.push(params); return { content: [{ type: 'text', text: 'rendered' }] }; },
    wake: (_push, key) => { wakes.push(key); return true; }, cancelWake: () => {},
    ...overrides,
  });
  return { c, journal, deliveries, wakes, calls,
    get operations() { return journalRecords(journal).map(record => record.operation); },
    assemble: () => c.assemble('agent', p => { deliveries.push(structuredClone(p)); }),
    texts: () => deliveries.map(p => p.params.payload.content.map(b => b.type === 'text' ? b.text : '').join('')) };
}

const result = (s: ReturnType<typeof setup>, p: CoalescedPush) => s.c.accept(p).coalesce!.outcome;
const rendered = (text: string): PushRenderResult => ({ content: [{ type: 'text', text }] });

test('vectors 1–6: replace until assembly, then append forever (including compression/failure)', async () => {
  const s = setup();
  assert.equal(result(s,push('create')), 'first');
  for (let i=1;i<=3;i++) assert.equal(result(s,push(`edit${i}`)), 'replaced');
  assert.deepEqual(s.texts(), []);
  assert.equal(s.wakes.length, 4); // policy is re-evaluated for every replacement
  await s.assemble();
  assert.deepEqual(s.texts(), ['edit3']);
  // Publication at assembly is the only boundary; no provider response is needed.
  assert.equal(result(s,push('later')), 'appended');
  await s.assemble();
  assert.deepEqual(s.texts(), ['edit3','later']);
});

test('vectors 7/31/32: uncertain history never suppresses a deletion', async () => {
  const s = setup(); s.c.forgetHistory();
  assert.equal(result(s,push('edit')), 'appended');
  assert.equal(result(s,push('delete','deleted',{retract:true})), 'noted');
  await s.assemble();
  assert.deepEqual(s.texts(),['deleted']);
  const fresh=setup();
  assert.equal(result(fresh,push('delete','deleted',{retract:true})), 'noted');
});

test('vectors 9/35: namespace isolation and retries return the original receipt', async () => {
  const s=setup();
  const one=push('same');
  const receipt=s.c.accept(one);
  s.c.accept(push('same','other',{},{serverId:'other'}));
  assert.deepEqual(s.c.accept(one),receipt);
  assert.equal(s.operations.filter(r=>r.kind==='accepted').length,2);
  await s.assemble();
  assert.deepEqual(s.texts(),['same','other']);
});

test('feature-set and key isolate subjects; transport epochs do not', async () => {
  const s=setup();
  const cases=[push('1'),push('2','2',{key:'J'}),push('3','3',{},{epoch:'new'})];
  const fourth=push('4'); fourth.params.featureSet='other'; cases.push(fourth);
  assert.deepEqual(cases.map(p=>result(s,p)),['first','first','replaced','first']);
  await s.assemble(); assert.deepEqual(s.texts(),['3','2','4']);
});

test('vector 12: replacing a subject cannot widen its audience', async () => {
  const s=setup(); s.c.accept(push('1')); s.c.accept(push('2','2',{},{audience:'other'}));
  await s.assemble(); await s.c.assemble('other',p=>{s.deliveries.push(p);});
  assert.deepEqual(s.texts(),[]);
});

test('vectors 16–20: notices render once, carry private data and never expose fallback', async () => {
  const s=setup();
  for(let i=0;i<100;i++) s.c.accept(push(String(i),'fallback',{deferred:true,data:{i}}));
  assert.equal(s.calls.length,0); await s.assemble();
  const params=s.calls[0] as {notices:Array<{data:{i:number}}>;dropped:number};
  assert.equal(params.notices.length,64); assert.equal(params.dropped,36);
  assert.equal(params.notices[0].data.i,36); assert.equal(params.notices.at(-1)!.data.i,99);
  assert.deepEqual(s.texts(),['rendered']); await s.assemble(); assert.equal(s.calls.length,1);
  assert.equal(result(s,push('next','fallback',{deferred:true})),'first');
  await s.assemble(); assert.equal(s.calls.length,2);
  const empty=setup({render:async()=>({content:[]})});
  empty.c.accept(push('1','fallback',{deferred:true})); await empty.assemble();
  assert.deepEqual(empty.texts(),[]); assert.deepEqual(empty.c.pendingPushes(),[]);
});

test('vectors 21/23: timeout consumes fallback; late render cannot rewrite it', async () => {
  const r=pending<PushRenderResult>(); const s=setup({timeoutMs:5,render:()=>r.promise});
  s.c.accept(push('1','fallback',{deferred:true})); await s.assemble();
  assert.deepEqual(s.texts(),['fallback']); r.resolve(rendered('late')); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(s.texts(),['fallback']); assert(s.operations.some(r=>r.kind==='observed' && r.detail.kind==='late-render'));
});

for(const kind of ['error','malformed','oversized'] as const) test(`vector 21: ${kind} render uses bounded admitted fallback`,async()=>{
  const s=setup({maxContentBytes:100,render:async()=>{
    if(kind==='error') throw Error('offline');
    if(kind==='malformed') return {content:[null]} as never;
    return rendered('x'.repeat(101));
  }});
  s.c.accept(push('1','fallback',{deferred:true})); await s.assemble(); assert.deepEqual(s.texts(),['fallback']);
});

test('vectors 22/25: concurrent assemblies share a frozen render; later notices wait', async () => {
  const r=pending<PushRenderResult>(); let calls=0;
  const s=setup({render:()=>{calls++; return r.promise;}});
  s.c.accept(push('1','f1',{deferred:true}));
  const a=s.assemble(), b=s.assemble();
  assert.equal(result(s,push('2','f2',{deferred:true})),'first');
  await Promise.resolve(); assert.equal(calls,1);
  r.resolve(rendered('r1')); await Promise.all([a,b]);
  assert.deepEqual(s.texts(),['r1']); assert.equal(s.c.pendingPushes()[0].params.eventId,'2');
  await s.assemble(); assert.equal(calls,2); assert.deepEqual(s.texts(),['r1','r1']);
});

test('vector 24: authority revocation before/during render suppresses all content', async () => {
  let allowed=true; const r=pending<PushRenderResult>(); let calls=0;
  const s=setup({authorized:()=>allowed,render:()=>{calls++;return r.promise;}});
  s.c.accept(push('1','fallback',{deferred:true})); const work=s.assemble();
  await Promise.resolve(); allowed=false; r.resolve(rendered('secret')); await work;
  assert.deepEqual(s.texts(),[]); assert.equal(calls,1);
  allowed=true; s.c.accept(push('2','fallback',{deferred:true})); allowed=false;
  await s.assemble(); assert.equal(calls,1); assert.deepEqual(s.texts(),[]);
});

for(const operation of ['retract','plain'] as const) for(const completion of ['result','timeout'] as const)
  test(`vectors 27a–h: ${operation} cancels frozen AND newer pending batch (${completion})`,async()=>{
    const r=pending<PushRenderResult>(); let calls=0;
    const s=setup({timeoutMs:5,render:()=>{calls++;return r.promise;}});
    s.c.accept(push('1','f1',{deferred:true})); const work=s.assemble(); await Promise.resolve();
    s.c.accept(push('2','f2',{deferred:true}));
    assert.equal(result(s,push('3',operation==='plain'?'snapshot':'deleted',operation==='retract'?{retract:true}:{})),operation==='plain'?'replaced':'retracted');
    if(completion==='result') r.resolve(rendered('old'));
    await work; await s.assemble();
    assert.deepEqual(s.texts(),operation==='plain'?['snapshot']:[]);
    assert.equal(calls,1); assert.deepEqual(s.c.pendingPushes(),[]);
  });

test('vector 27i: deferred notice replaces unread plain content; consumed plain survives', async()=>{
  const s=setup(); s.c.accept(push('plain'));
  assert.equal(result(s,push('notice','fallback',{deferred:true})),'replaced');
  await s.assemble(); assert.deepEqual(s.texts(),['rendered']);
  s.c.accept(push('plain2')); await s.assemble();
  s.c.accept(push('notice2','fallback',{deferred:true})); await s.assemble();
  assert.deepEqual(s.texts(),['rendered','plain2','rendered']);
});

test('vector 27j: cancellation does not discard a notice admitted AFTER the plain replacement', async()=>{
  const r=pending<PushRenderResult>(); const notices:string[][]=[];
  const s=setup({render:(_push,params)=>{notices.push(params.notices.map(n=>n.eventId));return notices.length===1?r.promise:Promise.resolve(rendered('new'));}});
  s.c.accept(push('1','f1',{deferred:true})); const work=s.assemble(); await Promise.resolve();
  s.c.accept(push('2','f2',{deferred:true})); s.c.accept(push('plain'));
  s.c.accept(push('3','f3',{deferred:true})); r.resolve(rendered('old')); await work;
  await s.assemble(); assert.deepEqual(notices,[['1'],['3']]); assert.deepEqual(s.texts(),['new']);
});

test('vectors 28–30/34: retraction removes unread content but retains consumed history', async()=>{
  const unread=setup(); unread.c.accept(push('create')); unread.c.accept(push('edit'));
  assert.equal(result(unread,push('delete','deleted',{retract:true})),'retracted');
  await unread.assemble(); assert.deepEqual(unread.texts(),[]);
  const s=setup(); s.c.accept(push('create')); await s.assemble(); s.c.accept(push('edit'));
  assert.equal(result(s,push('delete','deleted',{retract:true})),'noted');
  await s.assemble(); assert.deepEqual(s.texts(),['create','deleted']);
  s.c.accept(push('new')); assert.equal(result(s,push('delete2','',{retract:true})),'consumed');
  await s.assemble(); assert.deepEqual(s.texts(),['create','deleted']);
});

for(const flags of [{key:''},{key:'é'.repeat(129)},{deferred:true,retract:true},{data:{}},{deferred:true,data:'x'.repeat(4097)},{channelId:''}, {deferred:'yes'}])
  test(`vector 38: malformed ${JSON.stringify(flags).slice(0,70)} leaves subject untouched`,async()=>{
    const s=setup(); s.c.accept(push('good'));
    assert.throws(()=>s.c.accept(push('bad','bad',flags)),CoalesceError);
    await s.assemble(); assert.deepEqual(s.texts(),['good']);
  });

test('receipts and projection queries cannot be mutated by callers; journal keeps private notice data',async()=>{
  const s=setup(); const p=push('one','fallback',{deferred:true,data:{private:'notice'}});
  const receipt=s.c.accept(p); receipt.coalesce!.outcome='consumed';
  p.params.payload.content[0]={type:'text',text:'mutated'};
  assert.equal(s.c.accept(p).coalesce!.outcome,'first');
  assert.equal(s.c.pendingPushes()[0].params.payload.content[0].type,'text');
  assert(JSON.stringify(s.operations).includes('notice'));
  await s.assemble(); assert(!JSON.stringify(s.deliveries.map(d=>d.params.payload)).includes('notice'));
});

test('disconnect preserves acknowledged fallback; reconnect retry has no second effect',async()=>{
  const r=pending<PushRenderResult>(); let available=true;
  const s=setup({available:()=>available,render:()=>r.promise});
  const first=s.c.accept(push('one','fallback',{deferred:true})); const work=s.assemble();
  available=false; s.c.disconnect('server'); r.resolve(rendered('old')); await work;
  assert.deepEqual(s.texts(),[]); assert.equal(s.c.pendingPushes().length,1);
  available=true;
  assert.deepEqual(s.c.accept(push('one','fallback',{deferred:true},{epoch:'next'})),first);
  await s.assemble(); assert.deepEqual(s.texts(),['fallback']);
  assert.deepEqual(PUSH_COALESCING_SUPPORT,{pushEvents:true,deferred:true,channelsIncoming:true,channelScopedPush:true});
});

test('resource limit rejects new pending subject without evicting admitted content',async()=>{
  const s=setup({maxSubjects:1}); s.c.accept(push('one'));
  assert.throws(()=>s.c.accept(push('two','two',{key:'another'})),/limit/);
  await s.assemble(); assert.deepEqual(s.texts(),['one']);
  assert.equal(result(s,push('two','two',{key:'another'})),'appended');
});

test('restored pending subject keeps identity and unread history across transport epochs',async()=>{
  const before=setup();before.c.accept(push('c','pending'));
  const after=setup({journal:before.journal});after.c.recover();
  assert.equal(result(after,push('d','deleted',{retract:true},{epoch:'new'})),'retracted');
  await after.assemble();assert.deepEqual(after.texts(),[]);
});

test('old receipts are rebuilt from journal positions without a persisted receipt index',()=>{
  const s=setup();const first=s.c.accept(push('original'));
  for(let i=0;i<4100;i++)s.c.accept(push(`update-${i}`));
  const rebuilt=setup({journal:s.journal});const length=s.journal.length();
  assert.deepEqual(rebuilt.c.accept(push('original')),first);assert.equal(s.journal.length(),length);
});

test('an acceptance appended before a crash recovers with its receipt and pending work',async()=>{
  const journal=new MemoryCoalescingJournal();
  journal.afterAppend=record=>{if(record.operation.kind==='accepted')throw Error('crash after append');};
  const before=setup({journal});assert.throws(()=>before.c.accept(push('once')),/crash/);
  journal.afterAppend=undefined;
  const after=setup({journal});after.c.recover();
  assert.equal(result(after,push('once','once',{},{epoch:'reconnected'})),'first');
  await after.assemble();assert.deepEqual(after.texts(),['once']);
});

test('reassigning a server binding cannot replace or deduplicate the former principal',async()=>{
  const s=setup();assert.equal(result(s,push('same','old',{},{binding:'old'})),'first');
  assert.equal(result(s,push('same','new',{},{binding:'new'})),'first');
  await s.assemble();assert.deepEqual(s.texts(),['old','new']);
});

test('replacement cannot remove tune-out visibility restrictions',async()=>{
  const s=setup();s.c.accept(push('old','private',{},{routing:{targetAgents:['subconscious'],metadata:{tuneOut:{epochId:'muted'}}}}));
  s.c.accept(push('new','public',{},{routing:{targetAgents:['resident'],metadata:{}}}));
  await s.assemble();assert.deepEqual(s.texts(),[]);
});
