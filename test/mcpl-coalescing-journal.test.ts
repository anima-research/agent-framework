import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { PushCoalescer, coalescingSubject, coalescingReceiptKey, type CoalescedPush, type CoalescerOptions } from '../src/mcpl/push-coalescer.js';
import { ChronicleCoalescingJournal, COALESCING_JOURNAL_ID } from '../src/mcpl/chronicle-coalescing-journal.js';
import { MemoryCoalescingJournal, journalRecords } from './helpers/coalescing-journal.js';

function push(id: string, flags = {}): CoalescedPush {
  return {serverId:'s',binding:'b',epoch:'e',audience:'a',params:{featureSet:'f',eventId:id,
    timestamp:'now',coalesce:{key:'k',...flags},payload:{content:[{type:'text',text:id}]}}};
}
function controller(journal: CoalescerOptions['journal'], overrides: Partial<CoalescerOptions> = {}) {
  return new PushCoalescer({journal,authorized:()=>true,wake:()=>true,cancelWake:()=>{},
    render:async()=>({content:[{type:'text',text:'rendered'}]}),...overrides});
}

test('every live journal prefix replays identically without policy, RPC, publication, or wake effects', async()=>{
  const journal=new MemoryCoalescingJournal();const c=controller(journal);
  const prefixes:Array<{records:ReturnType<typeof journalRecords>;state:ReturnType<PushCoalescer['inspect']>}>=[];
  const capture=()=>prefixes.push({records:journalRecords(journal),state:c.inspect()});
  journal.beforeAppend=capture; // Every committed prefix, including render/outbox boundaries.
  c.accept(push('1'));capture();c.accept(push('2'));capture();
  c.accept(push('3',{retract:true}));capture();
  c.accept(push('4',{deferred:true}));capture();await c.assemble('a',()=>{});capture();
  c.accept(push('5'));capture();c.disconnect('s');capture();c.recover();capture();
  for(const {records,state} of prefixes){
    const fail=()=>{throw Error('replay performed an effect');};
    const replayed=controller(new MemoryCoalescingJournal(records),{authorized:fail,available:fail,render:fail,wake:fail,cancelWake:fail});
    assert.deepEqual(replayed.inspect(),state);
  }

});

test('replacement and retraction append facts without modifying their predecessors',()=>{
  const journal=new MemoryCoalescingJournal();const c=controller(journal);
  c.accept(push('1'));const original=JSON.stringify(journal.records);
  c.accept(push('2'));assert.equal(c.pending(coalescingSubject(push('1')))!.params.eventId,'2');
  c.accept(push('3',{retract:true}));assert.deepEqual(c.pendingPushes(),[]);
  assert.equal(JSON.stringify(journal.records.slice(0,1)),original);
  assert.deepEqual(journal.records.map(r=>r.operation.kind),['accepted','accepted','accepted']);
  assert.deepEqual(controller(journal).pendingPushes(),[]);
});

for(const after of [false,true]) test(`acceptance crash ${after?'after':'before'} durable append is resolved only by replay`,()=>{
  const journal=new MemoryCoalescingJournal();let wakes=0;
  const c=controller(journal,{wake:()=>{wakes++;return true;}});
  journal[after?'afterAppend':'beforeAppend']=()=>{throw Error('disk failure');};
  assert.throws(()=>c.accept(push('1')),/disk failure/);assert.equal(wakes,0);
  assert.throws(()=>c.accept(push('2')),/rebuild/);
  const restored=controller(journal);
  assert.equal(!!restored.receipt(push('1')),after);assert.equal(restored.pendingPushes().length,after?1:0);
});

test('prepared append survives a crash before context publication',async()=>{
  const journal=new MemoryCoalescingJournal();const c=controller(journal);c.accept(push('1'));
  journal.afterAppend=r=>{if(r.operation.kind==='prepared')throw Error('crash');};
  let writes=0;await assert.rejects(c.assemble('a',()=>{writes++;}),/crash/);assert.equal(writes,0);
  journal.afterAppend=undefined;const restored=controller(journal);restored.recover();
  assert.equal(restored.accept(push('2')).coalesce!.outcome,'appended');
  const ids:string[]=[];await restored.assemble('a',p=>{ids.push(p.params.eventId);});
  assert.deepEqual(ids,['1','2']);assert.deepEqual(restored.pendingPushes(),[]);
});

for(const after of [false,true]) test(`completion crash ${after?'after':'before'} append preserves one context publication`,async()=>{
  const journal=new MemoryCoalescingJournal();const c=controller(journal);c.accept(push('1'));
  const context=new Map<string,string>();let calls=0;
  const publish=(p:CoalescedPush)=>{calls++;assert(p.publicationId);context.set(p.publicationId,p.params.eventId);};
  journal[after?'afterAppend':'beforeAppend']=r=>{if(r.operation.kind==='delivered')throw Error('crash');};
  await assert.rejects(c.assemble('a',publish),/crash/);assert.equal(context.size,1);
  journal.beforeAppend=undefined;journal.afterAppend=undefined;
  const restored=controller(journal);restored.recover();await restored.assemble('a',publish);
  assert.equal(context.size,1);assert.equal(calls,after?1:2);assert.deepEqual(restored.pendingPushes(),[]);
});

test('unfinished render recovers admitted fallback without repeating the request',async()=>{
  const journal=new MemoryCoalescingJournal();let calls=0;let began!:()=>void;
  const started=new Promise<void>(r=>{began=r;});
  const c=controller(journal,{render:()=>{calls++;began();return new Promise(()=>{});}});
  c.accept(push('fallback',{deferred:true}));const assembly=c.assemble('a',()=>assert.fail('published before crash'));
  await started;c.suspend();await assembly;
  const restored=controller(journal,{render:async()=>{calls++;throw Error('render repeated');}});
  assert.equal(restored.inspect().subjects[0][1].rendering!==undefined,true);
  restored.recover();const texts:string[]=[];await restored.assemble('a',p=>{texts.push(p.params.eventId);});
  assert.equal(calls,1);assert.deepEqual(texts,['fallback']);
});

test('current policy changes publication decisions only when new facts are appended',async()=>{
  const journal=new MemoryCoalescingJournal();const c=controller(journal);c.accept(push('1'));
  await assert.rejects(c.assemble('a',()=>{throw Error('publication failed');}),/publication failed/);
  const state=c.inspect();const restored=controller(journal,{authorized:()=>false});
  assert.deepEqual(restored.inspect(),state);await restored.assemble('a',()=>assert.fail('revoked content published'));
  assert.deepEqual(restored.pendingPushes(),[]);
  assert.equal(journal.records.at(-1)!.operation.kind,'delivered');
  assert.deepEqual(controller(journal).inspect(),restored.inspect());
});

test('callers cannot mutate projected state through callbacks or diagnostic reads',()=>{
  const journal=new MemoryCoalescingJournal();const c=controller(journal,{authorized:p=>{p.params.eventId='tampered';return true;}});
  const input=push('1');c.accept(input);const state=c.inspect();
  input.params.eventId='changed';c.pendingPushes()[0].params.eventId='changed';c.inspect().subjects[0][1].slot!.push.params.eventId='changed';
  c.canAssemble('a');assert.deepEqual(c.inspect(),state);assert.deepEqual(controller(journal).inspect(),state);
});

test('Chronicle compaction and reopen rebuild receipts and pending work from the journal alone',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'coalescing-journal-'));const path=join(dir,'store');let store=JsStore.openOrCreate({path});
  try {
    const journal=new ChronicleCoalescingJournal(store);const c=controller(journal);const receipt=c.accept(push('1'));c.accept(push('2'));
    const records=journalRecords(journal);store.compactAllStates();store.close();store=JsStore.openOrCreate({path});
    const reopened=new ChronicleCoalescingJournal(store);assert.deepEqual(journalRecords(reopened),records);
    const restored=controller(reopened);assert.deepEqual(restored.receipt(push('1')),receipt);
    assert.equal(restored.pendingPushes()[0].params.eventId,'2');
    assert.deepEqual(store.listStates().map(s=>s.id),[COALESCING_JOURNAL_ID]);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('prototype migration imports uncertain publication and receipts once; old stores lose authority',()=>{
  const dir=mkdtempSync(join(tmpdir(),'coalescing-migration-'));const store=JsStore.openOrCreate({path:join(dir,'store')});
  try {
    const p=push('1');const result={accepted:true as const,coalesce:{outcome:'first' as const}};
    store.registerState({id:'mcpl/coalescing-pending',strategy:'snapshot'});
    store.setStateJson('mcpl/coalescing-pending',{version:2,pending:[p],history:[],receipt:[JSON.stringify(['s','b','1']),result]});
    const journal=new ChronicleCoalescingJournal(store);const c=controller(journal);
    assert.equal(journal.length(),1);assert.deepEqual(c.receipt(p),result);
    assert.equal(c.inspect().publications.length,1);assert.equal(c.inspect().subjects[0][1].history,'unknown');
    const key=coalescingReceiptKey(p);assert(c.inspect().receipts.some(([k])=>k===key));
    store.setStateJson('mcpl/coalescing-pending',{version:999,pending:[{invalid:true}]});
    assert.deepEqual(controller(new ChronicleCoalescingJournal(store)).inspect(),c.inspect());
    assert.equal(journal.length(),1);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
