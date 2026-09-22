import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
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
  const preview=await framework.previewActivation('ada');
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
