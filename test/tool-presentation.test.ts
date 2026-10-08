import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,chmodSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolPresentation,presentationTools,renderCatalogue} from '../src/tool-presentation.js';
import {AgentFramework,WorkspaceModule} from '../src/index.js';
import {AutobiographicalStrategy} from '@animalabs/context-manager';

test('edits persist, preserve originals, restore, reject invalid and protect recovery',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-'));
 try {
  const path=join(dir,'tools.json'), p=new ToolPresentation({path,cataloguePath:'board/tools.md'});
  const tools=[{name:'example',description:'original',inputSchema:{type:'object' as const}},...presentationTools('board/tools.md'),{name:'workspace--read',description:'read',inputSchema:{type:'object' as const}}];
  const first=p.resolve(tools);
  assert.equal(p.edit('set_tool_visibility',{name:'example',visible:false},tools).success,true);
  assert.equal(p.resolve(tools).advertised.some(t=>t.name==='example'),false);
  assert.equal(p.resolve(tools).available.some(t=>t.name==='example'),true);
  assert.equal(first.advertised.some(t=>t.name==='example'),true,'frozen prior result');
  assert.equal(p.edit('set_tool_description',{name:'example',description:'new'},tools).success,true);
  assert.equal(tools[0].description,'original');
  assert.equal(new ToolPresentation(p.config).resolve(tools).available[0].description,'new');
  assert.equal(p.edit('set_tool_description',{name:'example',description:null},tools).success,true);
  assert.equal(p.resolve(tools).available[0].description,'original');
  assert.equal(p.edit('set_tool_visibility',{name:'workspace--read',visible:false},tools).success,false);
  assert.equal(p.edit('set_tool_visibility',{name:'unknown',visible:true},tools).success,false);
  writeFileSync(path,JSON.stringify({version:1,tools:{example:{description:'file edit',visible:true}}}));
  assert.equal(p.resolve(tools).advertised[0].description,'file edit');
  writeFileSync(path,'broken');
  assert.equal(p.resolve(tools).advertised[0].description,'original');
  assert.equal(p.resolve(tools).diagnostics.length,1);
  assert.equal(p.edit('set_tool_visibility',{name:'example',visible:true},tools).success,false);
  assert.equal(readFileSync(path,'utf8'),'broken');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('framework preview, generated workspace read and both edit dispatch paths agree',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-framework-'));
 const workspace=new WorkspaceModule({mounts:[{name:'board',path:dir,mode:'read-write',watch:'never'}]});
 const strategy=()=>new AutobiographicalStrategy({adaptiveResolution:true,foldingStrategy:'kv-stable',recentWindowTokens:30000,kvStableReachTokens:8000});
 const framework=await AgentFramework.create({storePath:join(dir,'store'),membrane:{} as any,agents:[
  {name:'ada',model:'test',systemPrompt:'.',strategy:strategy(),toolPresentation:{path:join(dir,'tools.json'),cataloguePath:'board/tools.md'}},
  {name:'other',model:'test',systemPrompt:'.',strategy:strategy()},
 ],modules:[workspace]});
 try {
  const before=framework.inspectToolPresentation('ada')!;
  assert.equal(before.advertised.filter(t=>t.name.startsWith('set_tool_')).length,2);
  const target='workspace--glob'; assert.ok(before.available.some(t=>t.name===target));
  const call=(name:string,input:unknown)=>framework.executeToolCall({id:'test' as any,name,input:input as any,callerAgentName:'ada'});
  assert.equal((await call('set_tool_visibility',{name:target,visible:false})).success,true);
  const snapshot=framework.inspectToolPresentation('ada')!;
  const agent=(framework as any).agents.get('ada');
  const cm=agent.getContextManager();
  const setDefinitions=cm.setToolDefinitions.bind(cm);
  let compressionTools:any[]=[];
  cm.setToolDefinitions=(definitions:any[])=>{compressionTools=definitions;setDefinitions(definitions);};
  const preview=await framework.previewActivation('ada');
  assert.ok(compressionTools.some(t=>t.name===target),'preview retains hidden historical definitions for compression');
  const ready=cm.isReady;cm.isReady=()=>true;
  try {compressionTools=[];await (framework as any).runQueuedMaintenance();}
  finally {cm.isReady=ready;}
  assert.ok(compressionTools.some(t=>t.name===target),'maintenance retains hidden historical definitions');
  assert.ok(!(framework as any).agentToolSurface(agent).some((t:any)=>t.name===target),'RFC-008 listing follows advertised visibility');
  // The live streaming compiler must not overwrite the compression surface
  // with visible-only definitions after a preview/maintenance refresh.
  const membrane=agent.membrane;
  agent.membrane={streamYielding:(request:any)=>{
    assert.ok(!request.tools.some((t:any)=>t.name===target));
    return {cancel(){}};
  }};
  try {
    compressionTools=[];
    await agent.startStreamWithInjections(snapshot.advertised,undefined,undefined,snapshot.available);
    assert.ok(compressionTools.some(t=>t.name===target),'live stream retains hidden definitions for compression');
  } finally {agent.cancelStream();agent.membrane=membrane;}


  assert.deepEqual(preview.tools,snapshot.advertised);
  assert.ok((framework as any).getToolsForAgent('ada').some((t:any)=>t.name===target),'execution surface unchanged');
  assert.ok(!(await framework.previewActivation('other')).tools?.some(t=>t.name==='set_tool_visibility'));
  const read=await call('workspace--read',{path:'board/tools.md'});
  assert.equal(read.success,true);assert.match(JSON.stringify(read.data),/workspace--glob \(hidden\)/);
  assert.equal((await call('workspace--write',{path:'board/tools.md',content:'overwrite'})).success,false);
  // Real model dispatch queues a ToolCallEvent; test the whole native route,
  // not only executeToolCall (which already carries callerAgentName).
  const nativeRead = async (agentName: string) => {
    const oldPush = (framework as any).pushEvent;
    try {
      return await new Promise<any>((resolve) => {
        (framework as any).pushEvent = (event: any) => {
          if (event.type === 'tool-call') (framework as any).dispatchToolCallEvent(event);
          else if (event.type === 'tool-result') resolve(event.result);
        };
        (framework as any).dispatchToolCall(agentName, {
          id:'native-catalogue-read', name:'workspace--read', input:{path:'board/tools.md'},
          callerAgentName:'spoofed-identity',
        });
      });
    } finally { (framework as any).pushEvent = oldPush; }
  };
  const nativeResult = await nativeRead('ada');
  assert.equal(nativeResult.success,true, nativeResult.error);
  assert.match(JSON.stringify(nativeResult.data),/workspace--glob \(hidden\)/);
  assert.equal((await nativeRead('other')).success,false,'catalogue remains agent scoped');

  const events:any[]=[];const original=(framework as any).pushEvent;
  (framework as any).pushEvent=(e:any)=>events.push(e);
  (framework as any).dispatchToolCall('ada',{id:'restore',name:'set_tool_visibility',input:{name:target,visible:true}});
  (framework as any).pushEvent=original;
  assert.equal(events[0].result.success,true);
  assert.ok(framework.inspectToolPresentation('ada')!.advertised.some(t=>t.name===target));
  assert.equal((await framework.executeToolCall({id:'denied' as any,name:'set_tool_visibility',input:{name:target,visible:false},callerAgentName:'other'})).success,false);
 } finally {await framework.stop();rmSync(dir,{recursive:true,force:true});}
});

test('catalogue source groups and line references follow the live snapshot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'catalogue-groups-'));
 try {
  const p=new ToolPresentation({path:join(dir,'tools.json'),cataloguePath:'board/tools.md'});
  const tools=[{name:'custom--fetch',description:'First line\nSecond line',inputSchema:{type:'object' as const}},
   {name:'workspace--read',description:'Read',inputSchema:{type:'object' as const}}];
  const sources=new Map([['custom--fetch','MCPL server: web'],['workspace--read','Module: workspace']]);
  writeFileSync(p.config.path,JSON.stringify({version:1,tools:{'custom--fetch':{visible:false}}}));
  const text=renderCatalogue(p.resolve(tools,sources));
  assert.match(text,/MCPL server: web \(1\)/); assert.match(text,/Module: workspace \(1\)/);
  assert.match(text,/2 tools: 1 visible, 1 hidden/);
  const lines=text.split('\n');
  for(const name of tools.map(t=>t.name)) {
   const row=lines.find(l=>l.startsWith('- [') && l.includes(name))!;
   const match=row.match(/offset (\d+), limit (\d+)/)!;
   const start=Number(match[1])-1,count=Number(match[2]);
   assert.ok(lines[start].startsWith('#### '+name));
   assert.ok(lines.slice(start,start+count).some(l=>l.startsWith('Schema:')));
  }
  assert.ok(!renderCatalogue(p.resolve([tools[1]],sources)).includes('### MCPL server: web'));
 } finally {rmSync(dir,{recursive:true,force:true});}
});


test('edits preserve group-write permissions even under a restrictive umask',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-mode-'));
 const originalMask=process.umask(0o077);
 try {
  const path=join(dir,'tools.json');writeFileSync(path,'{"version":1,"tools":{}}');chmodSync(path,0o664);
  const p=new ToolPresentation({path,cataloguePath:'board/tools.md'});
  assert.equal(p.edit('set_tool_visibility',{name:'example',visible:false},[{name:'example',description:'original',inputSchema:{type:'object'}}]).success,true);
  assert.equal(statSync(path).mode & 0o777,0o664);
 } finally {process.umask(originalMask);rmSync(dir,{recursive:true,force:true});}
});

test('catalogue aliases preserve generated content, ownership and read-only access',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'catalogue-alias-'));
 const workspace=new WorkspaceModule({mounts:[{name:'board',path:dir,mode:'read-write',watch:'never',autoMaterialize:true},{name:'alias',path:dir,mode:'read-write',watch:'never',autoMaterialize:true}]});
 try {
  workspace.registerGeneratedTextFile('board/tools.md',()=> 'generated catalogue','resident');
  for(const path of ['board/tools.md','board/./tools.md','board/sub/../tools.md','alias/tools.md']) {
   const call=(name:string,callerAgentName='resident')=>workspace.handleToolCall({id:'alias',name,callerAgentName,input:{path,content:'overwrite',oldString:'generated',newString:'bad'}});
   const read=await call('read');assert.equal(read.success,true,read.error);assert.match(JSON.stringify(read.data),/generated catalogue/);
   assert.equal((await call('read','other')).success,false);
   for(const name of ['write','edit','delete','materialize','sync'])assert.equal((await call(name)).success,false,name+' '+path);
  }
  assert.equal((await workspace.handleToolCall({id:'absolute',name:'read',callerAgentName:'resident',input:{path:'board//tools.md'}})).success,false);
  assert.equal(existsSync(join(dir,'tools.md')),false);
  assert.throws(()=>workspace.registerGeneratedTextFile('alias/tools.md',()=> 'duplicate','resident'),/Duplicate/);
  assert.equal((await workspace.handleToolCall({id:'outside',name:'write',input:{path:'board/../outside',content:'no'}})).success,false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('live compilation captures advertised and compression definitions before context hooks refresh tools',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-refresh-'));
 const path=join(dir,'tools.json');
 writeFileSync(path,JSON.stringify({version:1,tools:{hidden:{visible:false}}}));
 const framework=await AgentFramework.create({storePath:join(dir,'store'),membrane:{} as any,
  agents:[{name:'ada',model:'test',systemPrompt:'.',toolPresentation:{path,cataloguePath:'board/tools.md'}}],
  modules:[new WorkspaceModule({mounts:[{name:'board',path:dir,mode:'read-write',watch:'never'}]})]});
 try {
  const internal=framework as any, agent=internal.agents.get('ada');
  const original=[{name:'visible',description:'before',inputSchema:{type:'object'}},{name:'hidden',description:'historical',inputSchema:{type:'object'}}];
  let current=original;
  internal.getToolsForAgent=()=>current;
  internal.moduleRegistry.gatherContext=async()=>{
   await Promise.resolve();
   original[0].description='mutated';
   current=[{name:'replacement',description:'after',inputSchema:{type:'object'}}];
   return [];
  };
  let captured:any[]|undefined;
  agent.startStreamWithInjections=async(...args:any[])=>{captured??=args;throw new Error('test: stop before provider call');};
  await internal.startAgentStream(agent);
  assert.ok(captured,'reached live compiler');
  assert.deepEqual(captured[0].map((t:any)=>[t.name,t.description]),[['visible','before']]);
  assert.deepEqual(captured[3].map((t:any)=>[t.name,t.description]),[['visible','before'],['hidden','historical']]);
 } finally {await framework.stop();rmSync(dir,{recursive:true,force:true});}
});

test('replaced temporary pathname cannot redirect permission changes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-temp-race-'));
 const path=join(dir,'tools.json'), victim=join(dir,'private');
 const before=JSON.stringify({version:1,tools:{}});
 writeFileSync(path,before);chmodSync(path,0o664);
 writeFileSync(victim,'private');chmodSync(victim,0o600);
 const originalWrite=fs.writeFileSync;
 let replaced=false;
 try {
  fs.writeFileSync=((...args:any[])=>{
   (originalWrite as any)(...args);
   const temp=fs.readdirSync(dir).find(name=>name.endsWith('.tmp'));
   if(temp&&!replaced){replaced=true;fs.unlinkSync(join(dir,temp));fs.symlinkSync(victim,join(dir,temp));}
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  const p=new ToolPresentation({path,cataloguePath:'board/tools.md'});
  const result=p.edit('set_tool_visibility',{name:'example',visible:false},[{name:'example',description:'example',inputSchema:{type:'object'}}]);
  assert.equal(replaced,true,'injected replacement after writing');
  assert.equal(statSync(victim).mode&0o777,0o600,'private target mode unchanged');
  assert.equal(readFileSync(victim,'utf8'),'private');
  assert.equal(result.success,false,'detected replacement refuses commit');
  assert.equal(readFileSync(path,'utf8'),before);
  assert.deepEqual(fs.readdirSync(dir).sort(),['private','tools.json']);
 } finally {fs.writeFileSync=originalWrite;syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});
