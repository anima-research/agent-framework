import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventGate, COALESCING_SUBJECT } from '../src/gate/event-gate.js';

for (const cancel of [false,true]) test(`coalesced debounce preserves deadline and ${cancel?'cancels without residue':'wakes without a context marker'}`, t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const dir=mkdtempSync(join(tmpdir(),'coalesce-gate-'));
  const configPath=join(dir,'gate.json');
  writeFileSync(configPath,JSON.stringify({policies:[{name:'doc',match:{serverId:'editor'},behavior:{debounce:1000}}],default:'skip'}));
  let wakes=0; const messages:unknown[]=[];
  const gate=new EventGate({configPath,emitTrace:()=>{},addMessage:(_p,c)=>{messages.push(c);return '';},requestInference:()=>{wakes++;},getAgentNames:()=>['agent']});
  t.after(()=>{gate.dispose();rmSync(dir,{recursive:true,force:true});});
  const cb=gate.asShouldTriggerCallback();
  cb('first',{serverId:'editor',eventType:'mcpl:push-event',[COALESCING_SUBJECT]:'subject'});
  for(let i=0;i<4;i++) {
    t.mock.timers.tick(200);
    cb('latest',{serverId:'editor',eventType:'mcpl:push-event',[COALESCING_SUBJECT]:'subject'});
  }
  if(cancel) gate.cancelCoalesced('subject');
  t.mock.timers.tick(200);
  assert.equal(wakes,cancel?0:1); assert.deepEqual(messages,[]);
});

test('wire metadata cannot counterfeit the host-only coalescing marker',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const dir=mkdtempSync(join(tmpdir(),'coalesce-gate-')); const configPath=join(dir,'gate.json');
  writeFileSync(configPath,JSON.stringify({policies:[{name:'doc',match:{serverId:'editor'},behavior:{debounce:1000}}],default:'skip'}));
  let wakes=0;
  const gate=new EventGate({configPath,emitTrace:()=>{},addMessage:()=>'',requestInference:()=>{wakes++;},getAgentNames:()=>['agent']});
  t.after(()=>{gate.dispose();rmSync(dir,{recursive:true,force:true});});
  const cb=gate.asShouldTriggerCallback();
  cb('first',{serverId:'editor',eventType:'mcpl:push-event',coalescingSubject:'forged'});
  t.mock.timers.tick(500); cb('second',{serverId:'editor',eventType:'mcpl:push-event',coalescingSubject:'forged'});
  t.mock.timers.tick(500); assert.equal(wakes,0); t.mock.timers.tick(500); assert.equal(wakes,1);
});

for (const changePolicy of [false,true]) test(`coalesced wake survives ${changePolicy?'policy changes':'unrelated traffic'} without postponement or duplication`,t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const dir=mkdtempSync(join(tmpdir(),'coalesce-gate-')); const configPath=join(dir,'gate.json');
  writeFileSync(configPath,JSON.stringify({policies:[
    {name:'special',match:{tagsAny:['doc:special']},behavior:{debounce:2000}},
    {name:'doc',match:{serverId:'editor'},behavior:{debounce:1000}},
  ],default:'skip'}));
  let wakes=0;
  const gate=new EventGate({configPath,emitTrace:()=>{},addMessage:()=>'',requestInference:()=>{wakes++;},getAgentNames:()=>['agent']});
  t.after(()=>{gate.dispose();rmSync(dir,{recursive:true,force:true});});
  const cb=gate.asShouldTriggerCallback();
  cb('first',{serverId:'editor',eventType:'mcpl:push-event',[COALESCING_SUBJECT]:'subject'});
  for(let i=0;i<4;i++) {
    t.mock.timers.tick(200);
    cb('update',{serverId:'editor',eventType:'mcpl:push-event',...(changePolicy?{tags:['doc:special'],[COALESCING_SUBJECT]:'subject'}:{})});
  }
  t.mock.timers.tick(200);assert.equal(wakes,1);
  t.mock.timers.tick(2000);assert.equal(wakes,1);
});
