import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { FrameworkConfig } from '../src/types/framework.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { McplServerConnection } from '../src/mcpl/server-connection.js';
import { AgentFramework } from '../src/framework.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

async function fixture(options: { server?: Record<string, unknown>; framework?: Partial<FrameworkConfig> } = {}) {
  const wss=new WebSocketServer({port:0,host:'127.0.0.1'}); await once(wss,'listening');
  let online=true;
  let socket:WebSocket; let next=1000; const receipts=new Map<number,(value:any)=>void>();
  const renders:any[]=[]; const hostCaps:any[]=[]; const published:any[]=[];
  let renderer: (params:any)=>Promise<unknown> = async()=>({content:[{type:'text',text:'document_diff'}]});
  wss.on('connection',ws=>{
    if(!online){ws.close();return;}
    socket=ws;
    ws.on('message',async bytes=>{
      const m=JSON.parse(String(bytes));
      if(!m.method) {receipts.get(m.id)?.(m);receipts.delete(m.id);return;}
      const reply=(result:unknown)=>ws.send(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
      if(m.method==='initialize') {
        hostCaps.push(m.params.capabilities.experimental.mcpl);
        reply({protocolVersion:'2024-11-05',capabilities:{tools:{},experimental:{mcpl:{version:'0.5',pushEvents:true,inferenceRequest:true,channels:{incoming:true,register:true,lifecycle:true,publish:true},featureSets:{doc:{description:'doc',uses:['pushEvents']}}}}},serverInfo:{name:'editor',version:'1'}});
      } else if(m.method==='featureSets/update') reply({accepted:true});
      else if(m.method==='tools/list') reply({tools:[]});
      else if(m.method==='channels/publish') {published.push(m.params); if(m.id!==undefined)reply({delivered:true});}
      else if(m.method==='channels/close')reply({closed:true});
      else if(m.method==='channels/open')reply({channel:{id:m.params.channelId,type:'discord',label:m.params.channelId}});
      else if(m.method==='push/render') {renders.push(m.params);reply(await renderer(m.params));}
      else if(m.id!==undefined) reply({});
    });
  });
  const dir=mkdtempSync(join(tmpdir(),'coalescing-host-'));
  let framework:AgentFramework; const membrane=new MockMembrane(); membrane.pushResponse(createMockResponse([{type:'text',text:'ok'}]));
  const create=async(grantPush=true)=>{
    framework=await AgentFramework.create({storePath:join(dir,'store'),membrane:membrane.asMembrane(),agents:[{name:'agent',model:'test',systemPrompt:'test'}],modules:[],...options.framework,mcplServers:[{id:'editor',url:`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,enabledFeatureSets:['doc'],...options.server,...(grantPush?{}:{disabledCapabilities:['pushEvents']})}]});
    return framework;
  };
  const send=(method:string,params:unknown):Promise<any>=>new Promise((resolve,reject)=>{
    const id=next++; const timer=setTimeout(()=>reject(Error(`no reply to ${method}`)),2000);
    receipts.set(id,value=>{clearTimeout(timer);resolve(value);});
    socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));
  });
  await create();
  return {get framework(){return framework;},membrane,renders,hostCaps,published,create,send,
    connection:()=> (framework as unknown as {mcplServerRegistry:{getServer(id:string):McplServerConnection}}).mcplServerRegistry.getServer('editor'),
    disconnect:()=>socket.terminate(),
    online:(value:boolean)=>{online=value;},
    register:(id='chat')=>send('channels/register',{channels:[{id,type:'discord',label:id,metadata:{channelType:'guild_text'}}]}),
    channel:(id:string,text:string,flags:Record<string,unknown>={},channelId='chat')=>({channelId,messageId:'m',eventId:id,timestamp:'2026-09-30T00:00:00Z',author:{id:'u',name:'User'},tags:['chat:mention'],content:text?[{type:'text',text}]:[],coalesce:{key:'message:m',...flags}}),
    renderer:(fn:typeof renderer)=>{renderer=fn;},
    close:async()=>{await framework.stop(); for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));rmSync(dir,{recursive:true,force:true});},
    params:(id:string,text:string,flags:Record<string,unknown>={})=>({featureSet:'doc',eventId:id,timestamp:'2026-09-30T00:00:00Z',coalesce:{key:'document',...flags},payload:{content:text?[{type:'text',text}]:[]}}),
    context:()=>JSON.stringify(framework.getAgent('agent')!.getContextManager().getAllMessages()),
  };
}

test('wire push receipts coalesce, content stays outside context until the real activation',async t=>{
  const f=await fixture();t.after(f.close);
  assert.deepEqual(f.hostCaps[0].eventCoalescing,{pushEvents:true,deferred:true,channelsIncoming:true,channelScopedPush:true});
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

test('unregistered channel scope is refused on both delivery lanes',async t=>{
  const f=await fixture();t.after(f.close);
  const bad=await f.send('push/event',f.params('1','text',{channelId:'chat'}));assert.equal(bad.error.code,-32023);
  const channel=await f.send('channels/incoming',{messages:[{channelId:'chat',messageId:'m',eventId:'e',timestamp:'now',author:{id:'u',name:'User'},content:[],coalesce:{key:'message:m'}}]});
  assert.match(channel.result.results[0].reason,/unknown channel/);
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
  assert(!f.context().includes('main_pending'));assert(f.context().includes('main_new'));
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

async function eventually(predicate:()=>boolean) {
  const deadline=Date.now()+3000;
  while(!predicate()) {assert(Date.now()<deadline,'condition did not settle');await new Promise(resolve=>setTimeout(resolve,10));}
}

test('channel create, push edit, push delete share one unread subject',async t=>{
  const f=await fixture();t.after(f.close);await f.register();
  const first=await f.send('channels/incoming',{messages:[f.channel('c','chat_original')]});
  const edit=await f.send('push/event',f.params('e','chat_edit',{channelId:'chat',key:'message:m'}));
  const deletion=await f.send('push/event',f.params('d','chat_deleted',{channelId:'chat',key:'message:m',retract:true}));
  assert.equal(first.result.results[0].coalesce.outcome,'first');
  assert.equal(edit.result.coalesce.outcome,'replaced');assert.equal(deletion.result.coalesce.outcome,'retracted');
  await f.framework.runUntilIdle();assert.equal(f.membrane.calls.length,0);
  assert(!f.context().includes('chat_original'));assert(!f.context().includes('chat_edit'));assert(!f.context().includes('chat_deleted'));
});

test('read original, unread edit, deletion preserves original and appends only the notice',async t=>{
  const f=await fixture();t.after(f.close);await f.register();
  await f.send('channels/incoming',{messages:[f.channel('c','read_original')]});await f.framework.runUntilIdle();
  await f.send('push/event',f.params('e','unread_edit',{channelId:'chat',key:'message:m'}));
  const deletion=await f.send('push/event',f.params('d','deletion_notice',{channelId:'chat',key:'message:m',retract:true}));
  assert.equal(deletion.result.coalesce.outcome,'noted');
  f.membrane.pushResponse(createMockResponse([{type:'text',text:'ok'}]));await f.framework.runUntilIdle();
  const request=JSON.stringify(f.membrane.calls[1]);
  assert(request.includes('read_original'));assert(request.includes('deletion_notice'));assert(!request.includes('unread_edit'));
  assert.equal(f.published.at(-1)?.channelId,'chat');
});

test('repeated channel edits keep message identity and deduplicate occurrence retries',async t=>{
  const f=await fixture();t.after(f.close);await f.register();
  await f.send('channels/incoming',{messages:[f.channel('c','original')]});
  const edit=await f.send('channels/incoming',{messages:[f.channel('e','newest')]});
  const retry=await f.send('channels/incoming',{messages:[f.channel('e','newest')]});
  assert.deepEqual(retry.result,edit.result);assert.equal(edit.result.results[0].coalesce.outcome,'replaced');
  await f.framework.runUntilIdle();assert.equal(f.membrane.calls.length,1);
  assert(JSON.stringify(f.membrane.calls[0]).includes('newest'));assert(!JSON.stringify(f.membrane.calls[0]).includes('original'));
});

test('both delivery lanes enforce the same inbound channel allow-list',async t=>{
  const f=await fixture({server:{allowedIncomingChannels:['chat:allowed*']}});t.after(f.close);
  await f.register('chat:allowed');await f.register('chat:blocked');
  const incoming=await f.send('channels/incoming',{messages:[f.channel('blocked','blocked',{},'chat:blocked'),f.channel('allowed','allowed',{},'chat:allowed')]});
  assert.equal(incoming.result.results[0].accepted,false);assert.equal(incoming.result.results[1].accepted,true);
  const push=await f.send('push/event',f.params('blocked-push','blocked',{channelId:'chat:blocked',key:'message:m'}));
  assert.equal(push.error.code,-32017);await f.framework.runUntilIdle();
  assert(!JSON.stringify(f.membrane.calls[0]).includes('blocked'));
});

test('revoked channel authority rejects a mixed-lane edit without touching the pending create',async t=>{
  const f=await fixture();t.after(f.close);await f.register();
  await f.send('channels/incoming',{messages:[f.channel('c','untouched_create')]});
  const oldGrant=f.connection().grant;f.connection().establishGrant(new CapabilityGrant(new Set(['pushEvents']),[]));
  const edit=await f.send('push/event',f.params('e','forbidden_edit',{channelId:'chat',key:'message:m'}));
  assert.equal(edit.error.code,-32017);f.connection().establishGrant(oldGrant);
  await f.framework.runUntilIdle();assert(JSON.stringify(f.membrane.calls[0]).includes('untouched_create'));assert(!JSON.stringify(f.membrane.calls[0]).includes('forbidden_edit'));
});

test('malformed coalescing fails per channel message and preserves valid siblings',async t=>{
  const f=await fixture();t.after(f.close);await f.register();
  const missing={...f.channel('bad','bad'),eventId:undefined};
  const deferred=f.channel('bad2','bad2',{deferred:true});
  const response=await f.send('channels/incoming',{messages:[missing,f.channel('good','good'),deferred]});
  assert.deepEqual(response.result.results.map((r:any)=>r.accepted),[false,true,false]);
  assert.equal(response.result.results[0].reason,'coalesce_invalid');
  const retract=await f.send('push/event',f.params('empty','',{channelId:'chat',key:'message:m',retract:true}));
  assert.equal(retract.error.code,-32602);await f.framework.runUntilIdle();assert(JSON.stringify(f.membrane.calls[0]).includes('good'));
});

test('channel scope is explicit and isolated from origin claims and other channels',async t=>{
  const f=await fixture();t.after(f.close);await f.register('chat:one');await f.register('chat:two');
  await f.send('channels/incoming',{messages:[f.channel('a','channel_one',{},'chat:one'),f.channel('b','channel_two',{},'chat:two')]});
  const misleading={...f.params('feature','feature_scope',{key:'message:m'}),origin:{channelId:'chat:one'}};
  await f.send('push/event',misleading);await f.framework.runUntilIdle();
  const request=JSON.stringify(f.membrane.calls[0]);for(const text of ['channel_one','channel_two','feature_scope'])assert(request.includes(text));
});

test('a transient reconnect retains pending channel content and receipt identity',async t=>{
  const f=await fixture({server:{reconnect:true,reconnectIntervalMs:20}});t.after(f.close);await f.register();
  const params={messages:[f.channel('c','survives_disconnect')]};
  const accepted=await f.send('channels/incoming',params);f.disconnect();
  await eventually(()=>f.hostCaps.length===2 && f.connection().policyEstablished);
  await f.register();const retry=await f.send('channels/incoming',params);
  assert.deepEqual(retry.result,accepted.result);await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length,1);assert(JSON.stringify(f.membrane.calls[0]).includes('survives_disconnect'));
});

test('recovered unread content can be retracted before assembly',async t=>{
  const f=await fixture();t.after(f.close);
  await f.send('push/event',f.params('c','withdraw_after_restart'));
  await f.framework.stop();await f.create();
  const deletion=await f.send('push/event',f.params('d','deleted',{retract:true}));assert.equal(deletion.result.coalesce.outcome,'retracted');
  await f.framework.runUntilIdle();assert.equal(f.membrane.calls.length,0);assert(!f.context().includes('withdraw_after_restart'));
});

test('durable occurrence receipts prevent duplicates after restart and consumption',async t=>{
  const f=await fixture();t.after(f.close);const params=f.params('once','exactly_once');
  const original=await f.send('push/event',params);await f.framework.runUntilIdle();
  await f.framework.stop();await f.create();const retry=await f.send('push/event',params);
  assert.deepEqual(retry.result,original.result);await f.framework.runUntilIdle();assert.equal(f.membrane.calls.length,1);
});

test('conversation-routed channel coalescing stays in its fork and pins the reply channel',async t=>{
  const f=await fixture({framework:{conversations:{templateAgent:'agent',bind:{channel:'always'},trigger:{channel:'always'}}}});t.after(f.close);await f.register();
  await f.send('channels/incoming',{messages:[f.channel('c','fork_original')]});
  await f.send('push/event',f.params('e','fork_latest',{channelId:'chat',key:'message:m'}));
  await f.framework.runUntilIdle();assert.equal(f.membrane.calls.length,1);
  const request=JSON.stringify(f.membrane.calls[0]);assert(request.includes('fork_latest'));assert(!request.includes('fork_original'));
  assert(!f.context().includes('fork_latest'));assert.equal(f.published.at(-1)?.channelId,'chat');
});

for (const debounce of [false,true]) test(`replacement with skip cancels ${debounce?'an already-fired debounce':'an immediate'} wake`,async t=>{
  const f=await fixture({framework:{gate:{config:{policies:[{name:'attention',match:{tagsAny:['doc:wake']},behavior:debounce?{debounce:100}:'always'}],default:'skip'}}}});t.after(f.close);
  await f.send('push/event',{...f.params('wake','obsolete_wake'),tags:['doc:wake']});
  if(debounce)await eventually(()=>(f.framework as unknown as {pendingRequests:unknown[]}).pendingRequests.length>0);
  await f.send('push/event',{...f.params('skip','quiet_update'),tags:['doc:quiet']});
  await f.framework.runUntilIdle();assert.equal(f.membrane.calls.length,0);
});

test('retract after a debounce fires cancels its queued inference request',async t=>{
  const f=await fixture({framework:{gate:{config:{policies:[{name:'attention',match:{source:'editor'},behavior:{debounce:100}}],default:'skip'}}}});t.after(f.close);
  await f.send('push/event',f.params('wake','withdrawn'));
  await eventually(()=>(f.framework as unknown as {pendingRequests:unknown[]}).pendingRequests.length>0);
  await f.send('push/event',f.params('retract','gone',{retract:true}));await f.framework.runUntilIdle();assert.equal(f.membrane.calls.length,0);
});

test('an idle resident cannot materialize coalesced content into a different resident live turn',async t=>{
  const f=await fixture({framework:{agents:[{name:'agent',model:'test',systemPrompt:'test'},{name:'reader',model:'test',systemPrompt:'test'}]}});t.after(f.close);
  const internals=f.framework as unknown as {activeTurnTokens:Map<string,number>;processNextEvent():Promise<void>};
  internals.activeTurnTokens.set('agent',100);
  await f.send('push/event',f.params('one','wait_for_boundary'));
  await internals.processNextEvent();assert.equal(f.membrane.calls.length,0);assert(!f.context().includes('wait_for_boundary'));
  internals.activeTurnTokens.delete('agent');
  // The provider mock needs a complete response for each independent resident.
  const { MockYieldingStream }=await import('./helpers/mock-membrane.js');
  f.membrane.streamYielding=request=>{f.membrane.calls.push(request);return new MockYieldingStream([createMockResponse([{type:'text',text:'ok'}])]);};
  await f.framework.runUntilIdle();assert.equal(f.membrane.calls.length,2);
  assert(f.membrane.calls.every(request=>JSON.stringify(request).includes('wait_for_boundary')));
});

test('opening or closing a channel does not change a subject coalescing identity',async t=>{
  const f=await fixture();t.after(f.close);await f.register();
  await f.send('channels/incoming',{messages:[f.channel('create','before_close')]});
  await f.send('channels/changed',{updated:[{id:'chat',type:'discord',label:'chat'}]});
  await eventually(()=>f.framework.channels!.isChannelOpen('chat')===false);
  const edit=await f.send('push/event',f.params('edit','after_close',{channelId:'chat',key:'message:m'}));
  assert.equal(edit.result.coalesce.outcome,'replaced');
  await f.framework.runUntilIdle();assert(JSON.stringify(f.membrane.calls[0]).includes('after_close'));assert(!JSON.stringify(f.membrane.calls[0]).includes('before_close'));
});

test('host-derived outbound routing entries cannot authorize channel coalescing',async t=>{
  const f=await fixture();t.after(f.close);
  f.framework.channels!.ensureChannelRegistered('editor','forged');
  const response=await f.send('push/event',f.params('forged','forged',{channelId:'forged'}));
  assert.equal(response.error.code,-32023);
});

test('a host restarting while its producer is offline wakes recovered work when reconnection succeeds',async t=>{
  const f=await fixture({server:{reconnect:true,reconnectIntervalMs:20}});t.after(f.close);
  await f.send('push/event',f.params('pending','offline_recovery'));
  await f.framework.stop();f.online(false);await f.create();assert.equal(f.membrane.calls.length,0);
  f.online(true);await eventually(()=>f.hostCaps.length>=2 && f.connection().policyEstablished);
  await eventually(()=>(f.framework as unknown as {pendingRequests:unknown[]}).pendingRequests.length>0);
  await f.framework.runUntilIdle();assert(JSON.stringify(f.membrane.calls[0]).includes('offline_recovery'));
});

test('a feature-scoped coalesced DM retains ordinary channel provenance and reply routing',async t=>{
  const f=await fixture();t.after(f.close);
  await f.send('push/event',{...f.params('dm','direct_message'),tags:['chat:dm'],origin:{source:'discord',channelId:'42',guildId:null,authorId:'u',authorName:'User'}});
  await f.framework.runUntilIdle();assert.equal(f.published.at(-1)?.channelId,'discord:dm:42');
});

test('mixed-lane edits retain the stable platform reply target after consumption',async t=>{
  const f=await fixture();t.after(f.close);await f.register();
  await f.send('channels/incoming',{messages:[{...f.channel('c','first_version'),threadId:'thread'}]});await f.framework.runUntilIdle();
  await f.send('push/event',f.params('e','second_version',{channelId:'chat',key:'message:m'}));
  f.membrane.pushResponse(createMockResponse([{type:'text',text:'ok'}]));await f.framework.runUntilIdle();
  const message=f.framework.getAgent('agent')!.getContextManager().getAllMessages().find(m=>m.metadata?.eventId==='e');
  assert.equal(message?.metadata?.messageId,'m');assert.equal(message?.metadata?.threadId,'thread');
  assert.deepEqual(message?.metadata?.author,{id:'u',name:'User'});
});

test('coalescing preserves the ordinary conversation bind predicate',async t=>{
  const f=await fixture({framework:{conversations:{templateAgent:'agent'}}});t.after(f.close);await f.register();
  const unbound=f.channel('unbound','not_a_personal_mention');unbound.tags=['chat:reply'];
  await f.send('channels/incoming',{messages:[unbound]});await f.framework.runUntilIdle();assert.equal(f.membrane.calls.length,0);
  const mentioned={...f.channel('mentioned','personal_mention'),metadata:{mentioned:true}};
  await f.send('channels/incoming',{messages:[mentioned]});await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length,1);assert(!JSON.stringify(f.membrane.calls[0]).includes('not_a_personal_mention'));
});

test('an isolated agent name cannot alias the shared coalescing audience',async t=>{
  const f=await fixture();t.after(f.close);
  const host=f.framework as unknown as {coalescingAudience(agentName?:string):string};
  assert.notEqual(host.coalescingAudience(),host.coalescingAudience('shared-messages'));
});
