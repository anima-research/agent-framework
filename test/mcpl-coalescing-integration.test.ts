import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { AgentFramework } from '../src/framework.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

async function fixture() {
  const wss=new WebSocketServer({port:0,host:'127.0.0.1'}); await once(wss,'listening');
  let socket:WebSocket; let next=1000; const receipts=new Map<number,(value:any)=>void>();
  const renders:any[]=[]; const hostCaps:any[]=[];
  let renderer: (params:any)=>Promise<unknown> = async()=>({content:[{type:'text',text:'document_diff'}]});
  wss.on('connection',ws=>{
    socket=ws;
    ws.on('message',async bytes=>{
      const m=JSON.parse(String(bytes));
      if(!m.method) {receipts.get(m.id)?.(m);receipts.delete(m.id);return;}
      const reply=(result:unknown)=>ws.send(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
      if(m.method==='initialize') {
        hostCaps.push(m.params.capabilities.experimental.mcpl);
        reply({protocolVersion:'2024-11-05',capabilities:{tools:{},experimental:{mcpl:{version:'0.5',pushEvents:true,inferenceRequest:true,channels:{incoming:true,register:true},featureSets:{doc:{description:'doc',uses:['pushEvents']}}}}},serverInfo:{name:'editor',version:'1'}});
      } else if(m.method==='featureSets/update') reply({accepted:true});
      else if(m.method==='tools/list') reply({tools:[]});
      else if(m.method==='push/render') {renders.push(m.params);reply(await renderer(m.params));}
      else if(m.id!==undefined) reply({});
    });
  });
  const dir=mkdtempSync(join(tmpdir(),'coalescing-host-'));
  let framework:AgentFramework; const membrane=new MockMembrane(); membrane.pushResponse(createMockResponse([{type:'text',text:'ok'}]));
  const create=async(grantPush=true)=>{
    framework=await AgentFramework.create({storePath:join(dir,'store'),membrane:membrane.asMembrane(),agents:[{name:'agent',model:'test',systemPrompt:'test'}],modules:[],mcplServers:[{id:'editor',url:`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,enabledFeatureSets:['doc'],...(grantPush?{}:{disabledCapabilities:['pushEvents']})}]});
    return framework;
  };
  const send=(method:string,params:unknown):Promise<any>=>new Promise((resolve,reject)=>{
    const id=next++; const timer=setTimeout(()=>reject(Error(`no reply to ${method}`)),2000);
    receipts.set(id,value=>{clearTimeout(timer);resolve(value);});
    socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));
  });
  await create();
  return {get framework(){return framework;},membrane,renders,hostCaps,create,send,
    renderer:(fn:typeof renderer)=>{renderer=fn;},
    close:async()=>{await framework.stop(); for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));rmSync(dir,{recursive:true,force:true});},
    params:(id:string,text:string,flags:Record<string,unknown>={})=>({featureSet:'doc',eventId:id,timestamp:'2026-09-30T00:00:00Z',coalesce:{key:'document',...flags},payload:{content:text?[{type:'text',text}]:[]}}),
    context:()=>JSON.stringify(framework.getAgent('agent')!.getContextManager().getAllMessages()),
  };
}

test('wire push receipts coalesce, content stays outside context until the real activation',async t=>{
  const f=await fixture();t.after(f.close);
  assert.deepEqual(f.hostCaps[0].eventCoalescing,{pushEvents:true,deferred:true,channelsIncoming:false,channelScopedPush:false});
  const first=await f.send('push/event',f.params('1','edit_original'));
  const last=await f.send('push/event',f.params('2','edit_latest'));
  assert.equal(first.result.coalesce.outcome,'first'); assert.equal(last.result.coalesce.outcome,'replaced');
  assert(!f.context().includes('edit_original'));assert(!f.context().includes('edit_latest'));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length,1);
  const request=JSON.stringify(f.membrane.calls[0]);
  assert(request.includes('edit_latest')); assert(!request.includes('edit_original'));
  assert.deepEqual((await f.send('push/event',f.params('2','edit_latest'))).result,last.result);
  await f.framework.runUntilIdle(); assert.equal(f.membrane.calls.length,1);
});

test('deferred wire pushes render once at assembly and never expose notice data',async t=>{
  const f=await fixture();t.after(f.close);
  await f.send('push/event',f.params('1','fallback_unavailable',{deferred:true,data:{private:'hidden_notice'}}));
  await f.send('push/event',f.params('2','fallback_unavailable',{deferred:true,data:{private:'hidden_notice_2'}}));
  assert.equal(f.renders.length,0);await f.framework.runUntilIdle();
  assert.equal(f.renders.length,1);assert.equal(f.renders[0].notices.length,2);
  const request=JSON.stringify(f.membrane.calls[0]);
  assert(request.includes('document_diff'));assert(!request.includes('fallback_unavailable'));assert(!request.includes('hidden_notice'));
});

test('retraction before assembly cancels the wake and leaves no model-visible trace',async t=>{
  const f=await fixture();t.after(f.close);
  await f.send('push/event',f.params('1','unread_original'));
  const response=await f.send('push/event',f.params('2','deletion_notice',{retract:true}));
  assert.equal(response.result.coalesce.outcome,'retracted');await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length,0);assert(!f.context().includes('unread_original'));assert(!f.context().includes('deletion_notice'));
});

test('unsupported channel scope is a request error; channel batches fail per message',async t=>{
  const f=await fixture();t.after(f.close);
  const bad=await f.send('push/event',f.params('1','text',{channelId:'chat'}));assert.equal(bad.error.code,-32602);
  const channel=await f.send('channels/incoming',{messages:[{channelId:'chat',messageId:'m',eventId:'e',timestamp:'now',author:{id:'u',name:'User'},content:[],coalesce:{key:'message:m'}}]});
  assert.equal(channel.result.results[0].reason,'coalesce_invalid');
});

test('clean restart recovers the latest durable fallback without replaying a render',async t=>{
  const f=await fixture();t.after(f.close);
  await f.send('push/event',f.params('1','old_fallback',{deferred:true}));
  await f.send('push/event',f.params('2','recovered_fallback',{deferred:true}));
  await f.framework.stop();await f.create();
  assert(!f.context().includes('recovered_fallback'));
  await f.framework.runUntilIdle();
  assert(!f.context().includes('old_fallback'));assert(f.context().includes('recovered_fallback'));assert.equal(f.renders.length,0);
  const count=f.framework.getAgent('agent')!.getContextManager().getAllMessages().length;
  await f.framework.stop();await f.create();
  assert.equal(f.framework.getAgent('agent')!.getContextManager().getAllMessages().length,count);
});

test('inference/request during push/render is rejected without starting recursive inference',async t=>{
  const f=await fixture();t.after(f.close);
  f.renderer(async()=>{
    const response=await f.send('inference/request',{featureSet:'doc',messages:[]});
    assert.equal(response.error.code,-32600);return {content:[{type:'text',text:'rendered_after_refusal'}]};
  });
  await f.send('push/event',f.params('1','fallback',{deferred:true}));await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length,1);assert(JSON.stringify(f.membrane.calls[0]).includes('rendered_after_refusal'));
});

test('plain replacement during wire render supersedes both frozen and newer pending work',async t=>{
  const f=await fixture();t.after(f.close);
  let release!: (value:unknown)=>void; let began!: ()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});
  f.renderer(()=>{began();return new Promise(resolve=>{release=resolve;});});
  await f.send('push/event',f.params('1','fallback_one',{deferred:true}));
  const run=f.framework.runUntilIdle(); await started;
  await f.send('push/event',f.params('2','fallback_two',{deferred:true}));
  const receipt=await f.send('push/event',f.params('3','complete_snapshot'));
  assert.equal(receipt.result.coalesce.outcome,'replaced');release({content:[{type:'text',text:'late_old_render'}]});
  await run;
  assert.equal(f.membrane.calls.length,1);assert.equal(f.renders.length,1);
  const request=JSON.stringify(f.membrane.calls[0]);
  assert(request.includes('complete_snapshot'));assert(!request.includes('fallback_one'));assert(!request.includes('fallback_two'));assert(!request.includes('late_old_render'));
});

test('reference disposition remains binding on materialized render content',async t=>{
  const f=await fixture();t.after(f.close);
  f.renderer(async()=>({content:[{type:'resource',uri:'https://example.test/secret-capability',name:'render.wav',mimeType:'audio/wav',disposition:'never'}]}));
  await f.send('push/event',f.params('1','fallback',{deferred:true}));await f.framework.runUntilIdle();
  const request=JSON.stringify(f.membrane.calls[0]);
  assert(request.includes('render.wav'));assert(!request.includes('secret-capability'));
});

test('operator branch switches do not move pending payloads or overwrite another branch recovery state',async t=>{
  const f=await fixture();t.after(f.close);
  await f.send('push/event',f.params('1','main_pending'));
  const cm=f.framework.getAgent('agent')!.getContextManager();
  await cm.fork('alternate');
  await f.send('push/event',f.params('2','alternate_pending'));
  await f.framework.runUntilIdle();
  assert(!JSON.stringify(f.membrane.calls[0]).includes('main_pending'));
  assert(JSON.stringify(f.membrane.calls[0]).includes('alternate_pending'));
  await cm.switchBranch('main');
  await f.send('push/event',f.params('3','main_new'));
  f.membrane.pushResponse(createMockResponse([{type:'text',text:'ok'}]));
  await f.framework.runUntilIdle();
  assert(f.context().includes('main_pending'));
  assert(!f.context().includes('alternate_pending'));
});

test('restart cannot publish a saved fallback before the newly denied grant',async t=>{
  const f=await fixture();t.after(f.close);
  await f.send('push/event',f.params('1','previously_permitted',{deferred:true}));
  await f.framework.stop();await f.create(false);
  await f.framework.runUntilIdle();
  assert(!f.context().includes('previously_permitted'));assert.equal(f.membrane.calls.length,0);assert.equal(f.renders.length,0);
});

test('a render arriving after the RPC deadline is audit-only and cannot replace fallback',async t=>{
  const f=await fixture();t.after(f.close);
  f.renderer(async()=>{await new Promise(resolve=>setTimeout(resolve,5200));return {content:[{type:'text',text:'wire_late_payload'}]};});
  await f.send('push/event',f.params('1','bounded_fallback',{deferred:true}));await f.framework.runUntilIdle();
  const request=JSON.stringify(f.membrane.calls[0]);
  assert(request.includes('bounded_fallback'));assert(!request.includes('wire_late_payload'));
  await new Promise(resolve=>setTimeout(resolve,300));
  const store=(f.framework as unknown as {store:{getStateJson(id:string):unknown}}).store;
  const audit=JSON.stringify(store.getStateJson('mcpl/coalescing-audit'));
  assert(audit.includes('late-render'));assert(audit.includes('wire_late_payload'));
  assert(!f.context().includes('wire_late_payload'));
});
