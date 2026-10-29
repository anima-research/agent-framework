import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,chmodSync,statSync,existsSync,mkdirSync} from 'node:fs';
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


  // The tool list is the advertised definitions less the host's built-in toolset.
  const settingsToolset=['agent_settings','wake_add_rule','wake_remove_rule','gate_status','event_tags','set_tool_visibility','set_tool_description','heartbeat--heartbeat_status','heartbeat--heartbeat_trigger','workspace--status'];
  const listed=(preview.tools??[]).map(t=>t.name);
  assert.ok(!listed.includes(target),'a hidden tool leaves the tool list');
  assert.deepEqual(listed.filter(n=>settingsToolset.includes(n)),[],"the built-in toolset's tools are not listed");
  assert.deepEqual(snapshot.advertised.map(t=>t.name).filter(n=>!settingsToolset.includes(n)&&!listed.includes(n)),[],'every other advertised tool is listed');
  assert.deepEqual(listed.filter(n=>!snapshot.advertised.some(t=>t.name===n)),[],'and nothing beyond the advertised tools');
  const hiddenRun=await call(target,{pattern:'*'});
  assert.equal(hiddenRun.success,true,`a hidden tool still runs: ${hiddenRun.error}`);
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
  assert.equal(result.error,'Nothing was changed: the temporary copy this edit was writing was replaced while it was written. Call this again; if it fails the same way, ask whoever runs this host to check what else writes beside your tool presentation file.');
  assert.equal(readFileSync(path,'utf8'),before);
  assert.deepEqual(fs.readdirSync(dir).sort(),['private','tools.json']);
 } finally {fs.writeFileSync=originalWrite;syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});

// What an agent reads when an edit is refused, and what
// the catalogue says about a file the host can't use. Each refusal leads with
// "Nothing was changed", names every problem it can see, and says what helps.
const presentationTargets=(...names:string[])=>names.map(name=>({name,description:'original',inputSchema:{type:'object' as const}}));

test('an edit refusal names every problem with its arguments, the call that works, and the closest names',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-refusals-'));
 try {
  const path=join(dir,'tools.json'), p=new ToolPresentation({path,cataloguePath:'board/tools.md'});
  const tools=[...presentationTargets('example','workspace--read'),...presentationTools('board/tools.md')];
  const refusal=(tool:string,input:unknown)=>{const r=p.edit(tool,input,tools);assert.equal(r.success,false);assert.equal(r.isError,true);return r.error;};
  assert.equal(refusal('set_tool_visibility',{nmae:'example',visible:'no'}),
   'Nothing was changed: "name" is missing; "visible" is "no", not true or false; "nmae" isn\'t an argument of set_tool_visibility. '
   +'set_tool_visibility takes {"name": a tool\'s exact name, "visible": true or false}.');
  assert.equal(refusal('set_tool_description',['example']),
   'Nothing was changed: the arguments were an array, not an object. '
   +'set_tool_description takes {"name": a tool\'s exact name, "description": the new text, or null to restore the default}.');
  assert.equal(refusal('set_tool_visibility',{name:'exampel',visible:false}),
   'Nothing was changed: no tool named "exampel" is available to you. Did you mean "example"? Copy the exact name from your tool catalogue\'s index, '
   +'workspace--read {"path":"board/tools.md","limit":140}, reading on with "offset" if the index runs past that.');
  // A suggested name is quoted whole, however long, since it's what the agent copies.
  const long='mcpl--'+'research_assistant_'.repeat(3)+'search_archive';
  const withLong=[...tools,...presentationTargets(long)];
  const r=p.edit('set_tool_visibility',{name:long.slice(0,-1),visible:false},withLong);
  assert.ok(long.length>60);
  assert.match(r.error!,new RegExp(`Did you mean ${JSON.stringify(long)}\\?`));
  // The name the agent typed is quoted as a file's names are: whole up to 60 characters, and past that cut, with its length.
  assert.ok(r.error!.startsWith(`Nothing was changed: no tool named ${JSON.stringify(long.slice(0,57))}... (76 characters) is available to you.`),r.error);
  assert.doesNotMatch(refusal('set_tool_visibility',{name:'deploy',visible:false})!,/Did you mean/,'a name close to nothing gets no guess');
  // Two close names are both offered, the closer first.
  const two=p.edit('set_tool_visibility',{name:'exampl',visible:false},[...tools,...presentationTargets('example_two')]);
  assert.match(two.error!,/ Did you mean "example" or "example_two"\? /);
  // These two limits are the file's rules too; the agent reads them as its own input.
  assert.equal(refusal('set_tool_description',{name:'example',description:'x'.repeat(32769)}),
   'Nothing was changed: the description is 32,769 characters, over the 32,768 allowed. Shorten it and call set_tool_description again.');
  assert.equal(refusal('set_tool_description',{name:'example',description:'\u{1F600}'.repeat(32769)}),
   'Nothing was changed: the description is 32,769 characters, over the 32,768 allowed. Shorten it and call set_tool_description again.',
   'an emoji of one code point counts once');
  assert.equal(refusal('set_tool_description',{name:'example',description:5}),
   'Nothing was changed: "description" is 5, not a string or null. '
   +'set_tool_description takes {"name": a tool\'s exact name, "description": the new text, or null to restore the default}.');
  for (const name of ['workspace--read','set_tool_visibility','set_tool_description']) assert.equal(refusal('set_tool_visibility',{name,visible:false}),
   `Nothing was changed: ${name} can't be hidden, since workspace--read, set_tool_visibility, set_tool_description and the toolsets-- tools are how you read the catalogue, reach hidden tools and undo these changes. Calling this again won't change that.`);
  assert.equal(existsSync(path),false,'no refusal wrote the file');
  assert.equal(p.edit('set_tool_description',{name:'example',description:'\u{1F600}'.repeat(32768)},tools).success,true,'at the limit in characters, though twice it in UTF-16 units');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a presentation file the host can\'t use: edits refuse it and the catalogue says so, each naming every problem',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-file-problems-'));
 try {
  const path=join(dir,'tools.json'), p=new ToolPresentation({path,cataloguePath:'board/tools.md'});
  const tools=presentationTargets('example','workspace--read');
  const broken=JSON.stringify({version:2,tools:{example:{visible:'no',hidden:true},'workspace--read':{visible:false}},note:'x'});
  writeFileSync(path,broken);
  const problems='"version" must be 1, and it is 2; only "version" and "tools" belong at the top level, not "note"; '
   +'the entry for "example" has "hidden", and an entry may have only "description" and "visible"; '
   +'the entry for "example" has "visible": "no", which must be true or false; '
   +'the entry for "workspace--read" hides it, which isn\'t allowed, since workspace--read, set_tool_visibility and set_tool_description are how the catalogue is read and how these settings are undone';
  assert.equal(p.edit('set_tool_visibility',{name:'example',visible:true},tools).error,
   `Nothing was changed: your tool presentation file can't be used (${problems}), and these tools won't write over it until it's repaired. Ask whoever runs this host to repair it.`);
  assert.equal(readFileSync(path,'utf8'),broken);
  assert.deepEqual(p.resolve(tools).diagnostics,[`Your tool presentation file can't be used (${problems}), so none of its settings apply: `
   +'every tool is visible and shows its configured default description, or its installed one where none is configured. '
   +'set_tool_visibility and set_tool_description won\'t change the file until it\'s repaired; ask whoever runs this host to repair it.']);
  writeFileSync(path,'{"version":1,');
  assert.match(p.edit('set_tool_visibility',{name:'example',visible:true},tools).error!,
   /^Nothing was changed: your tool presentation file can't be used \(it isn't valid JSON: .+\), and these tools won't write over it/);
  writeFileSync(path,'[]');
  const notObject=p.resolve(tools).diagnostics[0];
  assert.ok(notObject.startsWith('Your tool presentation file can\'t be used (its top level is an array, not an object like {"version":1,"tools":{}}), so none of its settings apply'),notObject);
  // A long value is quoted short, and past ten problems the rest are counted.
  writeFileSync(path,JSON.stringify({version:1,tools:Object.fromEntries(Array.from({length:12},(_,i)=>[`t${i}`,{visible:'y'.repeat(50)}]))}));
  const many=p.resolve(tools).diagnostics[0];
  assert.match(many,/\(the entry for "t0" has "visible": "y{36}\.\.\., which must be true or false; /);
  assert.match(many,/the entry for "t9" has [^;]*; 2 more problems\), so none of its settings apply/);
  writeFileSync(path,JSON.stringify({version:1,tools:Object.fromEntries(Array.from({length:11},(_,i)=>[`t${i}`,{visible:'y'}]))}));
  assert.match(p.resolve(tools).diagnostics[0],/; 1 more problem\), so none of its settings apply/);
  // A name of any length is quoted cut, with its length.
  writeFileSync(path,JSON.stringify({version:1,tools:{['k'.repeat(100)]:{visible:'no'}}}));
  assert.match(p.resolve(tools).diagnostics[0],/\(the entry for "k{57}"\.\.\. \(100 characters\) has "visible": "no", which must be true or false\)/);
  // Names and values are counted and cut in code points, so a cut never leaves half of a surrogate pair.
  writeFileSync(path,JSON.stringify({version:1,tools:{['\u{1F600}'.repeat(60)]:{visible:'no'},['\u{1F600}'.repeat(61)]:{visible:'\u{1F600}'.repeat(40)}}}));
  const emoji=p.resolve(tools).diagnostics[0];
  assert.ok(emoji.includes(`the entry for "${'\u{1F600}'.repeat(60)}" has`),'60 emoji are quoted whole');
  assert.ok(emoji.includes(`the entry for "${'\u{1F600}'.repeat(57)}"... (61 characters) has "visible": "${'\u{1F600}'.repeat(36)}...,`),'past 60 cut at 57, a value at 37');
  assert.doesNotMatch(emoji,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,'no half of a pair is left');
  // A key for a tool that isn't available is quoted, and cut, too.
  writeFileSync(path,JSON.stringify({version:1,tools:{['u'.repeat(100)]:{visible:false}}}));
  assert.deepEqual(p.resolve(tools).diagnostics,[`Not currently available: "${'u'.repeat(57)}"... (100 characters)`]);
  // A description in the file is counted in characters too.
  writeFileSync(path,JSON.stringify({version:1,tools:{example:{description:'\u{1F600}'.repeat(20000)}}}));
  assert.deepEqual(p.resolve(tools).diagnostics,[],'20,000 emoji are 20,000 characters, though 40,000 UTF-16 units');
  writeFileSync(path,JSON.stringify({version:1,tools:{example:{description:'x'.repeat(32769)}}}));
  assert.match(p.resolve(tools).diagnostics[0],/\(the entry for "example" has a "description" of 32,769 characters, over the 32,768 allowed\)/);
  // The catalogue gives each diagnostic one line, though a parse error can quote the file's own line breaks.
  writeFileSync(path,'{\n  "version": 1,\n  "tools": {\n    "example": {"visible": nope}\n  }\n}\n');
  const snapshot=p.resolve(tools);
  snapshot.diagnostics.push('first\nsecond','third\r\nfourth','fifth\rsixth');
  const lines=renderCatalogue(snapshot).split('\n').filter(l=>l.startsWith('Diagnostic: '));
  assert.equal(lines.length,4);
  assert.match(lines[0],/^Diagnostic: Your tool presentation file can't be used \(it isn't valid JSON: .*\), so none of its settings apply: .* ask whoever runs this host to repair it\.$/);
  assert.deepEqual(lines.slice(1),['Diagnostic: first\\nsecond','Diagnostic: third\\nfourth','Diagnostic: fifth\\nsixth']);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a presentation file holding {} is the empty document, as a missing one is, and a 0-byte file, half a document or a value that isn\'t an object still refuses',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-empty-object-'));
 try {
  const path=join(dir,'tools.json'), p=new ToolPresentation({path,cataloguePath:'board/tools.md'});
  const tools=presentationTargets('example','workspace--read');
  for (const empty of ['{}','{ }\n']) {
   writeFileSync(path,empty);
   const snapshot=p.resolve(tools);
   assert.deepEqual(snapshot.diagnostics,[],`${JSON.stringify(empty)} carries no settings, so nothing is said`);
   assert.deepEqual(snapshot.advertised.map(t=>[t.name,t.description]),[['example','original'],['workspace--read','original']]);
   assert.equal(p.edit('set_tool_visibility',{name:'example',visible:false},tools).success,true);
   assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),{version:1,tools:{example:{visible:false}}},'the edit writes the full form');
  }
  const refusedAs=(problem:string)=>`Nothing was changed: your tool presentation file can't be used (${problem}), and these tools won't write over it until it's repaired. Ask whoever runs this host to repair it.`;
  for (const [content,problem] of [
   ['{"tools":{}}','"version" must be 1, and it\'s missing'],
   ['{"version":1}','"tools" must be an object of tool names, and it\'s missing'],
   // Top-level values that aren't objects, for which Object.keys() gives no keys either (or, for null, throws).
   ...['null','true','1'].map(value=>[value,`its top level is ${value}, not an object like {"version":1,"tools":{}}`]),
  ]) {
   writeFileSync(path,content);
   assert.equal(p.edit('set_tool_visibility',{name:'example',visible:true},tools).error,refusedAs(problem),content);
   assert.equal(readFileSync(path,'utf8'),content);
   assert.equal(p.resolve(tools).diagnostics.length,1,content);
  }
  // 0 bytes is what a lost file looks like, since an edit's rename never leaves one.
  writeFileSync(path,'');
  assert.match(p.edit('set_tool_visibility',{name:'example',visible:true},tools).error!,
   /^Nothing was changed: your tool presentation file can't be used \(it isn't valid JSON: .+\), and these tools won't write over it/);
  assert.equal(readFileSync(path,'utf8'),'');
  assert.equal(p.resolve(tools).diagnostics.length,1);

  // A defaults file reads {} the same way, and still refuses half a document.
  const web=join(dir,'web.json');
  const q=new ToolPresentation({path:join(dir,'other.json'),cataloguePath:'board/tools.md',defaults:[{source:'MCPL server: web',path:web}]});
  const webTools=presentationTargets('web--fetch'), sources=new Map([['web--fetch','MCPL server: web']]);
  writeFileSync(web,'{}');
  assert.deepEqual(q.resolve(webTools,sources).diagnostics,[]);
  assert.equal(q.resolve(webTools,sources).available[0].description,'original');
  writeFileSync(web,'{"version":1}');
  assert.deepEqual(q.resolve(webTools,sources).diagnostics,['The description defaults for "MCPL server: web" can\'t be used ("tools" must be an object of tool names, and it\'s missing), '
   +'so its tools show their installed descriptions, or yours where you set one. Ask whoever runs this host to fix that defaults file.']);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('description defaults that set visibility, are missing or are configured twice are each said, and the rest still apply',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-defaults-problems-'));
 try {
  const web=join(dir,'web.json'), good=join(dir,'good.json'), absent=join(dir,'absent.json');
  writeFileSync(web,JSON.stringify({version:1,tools:{'web--fetch':{description:'fetch',visible:false},'web--post':{visible:true}}}));
  writeFileSync(good,JSON.stringify({version:1,tools:{'workspace--read':{description:'from defaults'}}}));
  const p=new ToolPresentation({path:join(dir,'tools.json'),cataloguePath:'board/tools.md',defaults:[
   {source:'MCPL server: web',path:web},{source:'Module: workspace',path:good},{source:'Module: workspace',path:absent},{source:'MCPL server: mail',path:absent}]});
  const tools=presentationTargets('web--fetch','web--post','workspace--read','mail--send');
  const sources=new Map([['web--fetch','MCPL server: web'],['web--post','MCPL server: web'],['workspace--read','Module: workspace'],['mail--send','MCPL server: mail']]);
  const snapshot=p.resolve(tools,sources);
  const fallback='so its tools show their installed descriptions, or yours where you set one. Ask whoever runs this host to fix that defaults file.';
  assert.deepEqual(snapshot.diagnostics,[
   `The description defaults for "MCPL server: web" can't be used (it sets "visible" for "web--fetch" and "web--post", and a defaults file may set only descriptions, since visibility is yours to choose), ${fallback}`,
   'The description defaults for "Module: workspace" are configured twice; only the first is read, and the other is ignored. Ask whoever runs this host to remove the duplicate.',
   `The description defaults for "MCPL server: mail" can't be used (it doesn't exist), ${fallback}`,
  ]);
  assert.deepEqual(snapshot.available.map(t=>t.description),['original','original','from defaults','original']);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a stale lock, a linked file, a full file, a change underneath and a failed write each say what happened and change nothing, and a lock left after a done edit leaves it done, with a note',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-conditions-'));
 const originalWrite=fs.writeFileSync, originalRename=fs.renameSync, originalUnlink=fs.unlinkSync;
 try {
  const path=join(dir,'tools.json'), p=new ToolPresentation({path,cataloguePath:'board/tools.md'});
  const tools=presentationTargets('example');
  const hide=()=>p.edit('set_tool_visibility',{name:'example',visible:false},tools).error;
  writeFileSync(path+'.lock','');
  assert.equal(hide(),'Nothing was changed: an earlier edit of your tool presentation file left its lock behind, or another edit is in progress. '
   +'Call this again in a few seconds. If it fails the same way, ask whoever runs this host to remove the stale lock, the presentation file\'s name with .lock added, once nothing is editing the file.');
  fs.unlinkSync(path+'.lock');
  const target=join(dir,'target.json');writeFileSync(target,'{"version":1,"tools":{}}');fs.symlinkSync(target,path);
  assert.equal(hide(),'Nothing was changed: your tool presentation file is a symbolic link, and these tools don\'t write through links. '
   +'Ask whoever runs this host to make the change in the file it points to, or to replace the link with that file.');
  assert.equal(readFileSync(target,'utf8'),'{"version":1,"tools":{}}');
  fs.unlinkSync(path);
  // A file a little under its limit, which one more long description would take over it.
  const fillers=Object.fromEntries(Array.from({length:8},(_,i)=>[`filler-${i}`,{description:'x'.repeat(32000)}]));
  const full=JSON.stringify({version:1,tools:fillers},null,2)+'\n';
  writeFileSync(path,full);
  const long='y'.repeat(32000);
  const size=Buffer.byteLength(JSON.stringify({version:1,tools:{...fillers,example:{description:long}}},null,2)+'\n');
  assert.ok(Buffer.byteLength(full)<256*1024 && size>256*1024,'the file fits, and the edit would not');
  assert.equal(p.edit('set_tool_description',{name:'example',description:long},tools).error,
   `Nothing was changed: with this change your tool presentation file would be ${size.toLocaleString('en-US')} bytes, ${(size-256*1024).toLocaleString('en-US')} over its limit of 262,144 (256 KiB). `
   +'Use a shorter description, or make room by restoring descriptions you no longer need with "description": null. '
   +'Entries for tools no longer available to you can be removed only by whoever runs this host.');
  assert.equal(readFileSync(path,'utf8'),full);
  // A file a few bytes under its limit, which hiding one more tool would take over it.
  const nine=Object.fromEntries(Array.from({length:9},(_,i)=>[`filler-${i}`,{description:'x'.repeat(29000)}]));
  const filled=(n:number)=>JSON.stringify({version:1,tools:{...nine,'filler-8':{description:'x'.repeat(n)}}},null,2)+'\n';
  const nearlyFull=filled(29000+256*1024-Buffer.byteLength(filled(29000))-10);
  writeFileSync(path,nearlyFull);
  const hidden=Buffer.byteLength(JSON.stringify({version:1,tools:{...JSON.parse(nearlyFull).tools,example:{visible:false}}},null,2)+'\n');
  assert.ok(Buffer.byteLength(nearlyFull)<=256*1024 && hidden>256*1024,'the file fits, and hiding one more tool would not');
  assert.equal(p.edit('set_tool_visibility',{name:'example',visible:false},tools).error,
   `Nothing was changed: with this change your tool presentation file would be ${hidden.toLocaleString('en-US')} bytes, ${(hidden-256*1024).toLocaleString('en-US')} over its limit of 262,144 (256 KiB). `
   +'Make room by restoring descriptions you no longer need with set_tool_description and "description": null. '
   +'Entries for tools no longer available to you can be removed only by whoever runs this host.');
  assert.equal(readFileSync(path,'utf8'),nearlyFull);
  // Another writer changes the file after this edit read it.
  writeFileSync(path,'{"version":1,"tools":{}}');
  const theirs='{"version":1,"tools":{"other":{"visible":false}}}';
  fs.writeFileSync=((...args:any[])=>{(originalWrite as any)(...args);if(typeof args[0]==='number')originalWrite(path,theirs);}) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  assert.equal(hide(),'Nothing was changed: your tool presentation file changed while this edit was being made. Call this again; it applies to the file as it is now.');
  fs.writeFileSync=originalWrite;syncBuiltinESMExports();
  assert.equal(readFileSync(path,'utf8'),theirs);
  // A failure no refusal names: the rename, the edit's last step.
  fs.renameSync=(()=>{throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'),{code:'EXDEV'});}) as typeof fs.renameSync;
  syncBuiltinESMExports();
  assert.equal(hide(),'Nothing was changed: the edit failed (EXDEV). Ask whoever runs this host to check your tool presentation file and its directory.');
  // One with no code is quoted, cut at 500 characters, since nobody wrote it for the agent.
  fs.renameSync=(()=>{throw new Error('z'.repeat(600));}) as typeof fs.renameSync;
  syncBuiltinESMExports();
  assert.equal(hide(),`Nothing was changed: the edit failed (${'z'.repeat(500)}… (600 characters)). Ask whoever runs this host to check your tool presentation file and its directory.`);
  fs.renameSync=originalRename;syncBuiltinESMExports();
  assert.equal(readFileSync(path,'utf8'),theirs);
  assert.deepEqual(fs.readdirSync(dir).sort(),['target.json','tools.json'],'no temporary copy or lock is left');
  // Cleanup after the rename can't undo the edit: a lock that won't go stays for the next edit to report, and this one succeeds,
  // saying what the next edit will meet. An edit whose lock goes says nothing of it.
  assert.equal('note' in (p.edit('set_tool_visibility',{name:'example',visible:true},tools).data as object),false);
  const busy=Object.assign(new Error('EBUSY: resource busy or locked, unlink'),{code:'EBUSY'});
  const left="This edit couldn't remove its lock afterwards, the presentation file's name with .lock added (EBUSY). "
   +'Until whoever runs this host removes it, set_tool_visibility and set_tool_description will be refused, saying an edit left its lock behind.';
  fs.unlinkSync=((target:fs.PathLike)=>{if(String(target).endsWith('.lock'))throw busy;return originalUnlink(target);}) as typeof fs.unlinkSync;
  syncBuiltinESMExports();
  const done=p.edit('set_tool_visibility',{name:'example',visible:false},tools);
  assert.equal(done.success,true);
  assert.equal((done.data as {note?:string}).note,left);
  fs.unlinkSync=originalUnlink;syncBuiltinESMExports();
  assert.equal(p.resolve(tools).advertised.some(t=>t.name==='example'),false,'the edit took effect');
  assert.match(hide()!,/^Nothing was changed: an earlier edit of your tool presentation file left its lock behind/);
  fs.unlinkSync(path+'.lock');
  // A lock something else removed first isn't left: its unlink finds nothing, and the edit says nothing of it.
  const gone=Object.assign(new Error('ENOENT: no such file or directory, unlink'),{code:'ENOENT'});
  fs.unlinkSync=((target:fs.PathLike)=>{if(String(target).endsWith('.lock')){originalUnlink(target);throw gone;}return originalUnlink(target);}) as typeof fs.unlinkSync;
  syncBuiltinESMExports();
  const removed=p.edit('set_tool_visibility',{name:'example',visible:true},tools);
  fs.unlinkSync=originalUnlink;syncBuiltinESMExports();
  assert.equal(removed.success,true);
  assert.equal('note' in (removed.data as object),false);
  // A refusal whose lock won't go says so too.
  fs.unlinkSync=((target:fs.PathLike)=>{if(String(target).endsWith('.lock'))throw busy;return originalUnlink(target);}) as typeof fs.unlinkSync;
  fs.renameSync=(()=>{throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'),{code:'EXDEV'});}) as typeof fs.renameSync;
  syncBuiltinESMExports();
  assert.equal(hide(),`Nothing was changed: the edit failed (EXDEV). Ask whoever runs this host to check your tool presentation file and its directory. ${left}`);
  fs.unlinkSync=originalUnlink;fs.renameSync=originalRename;syncBuiltinESMExports();
  fs.unlinkSync(path+'.lock');
  // A file the catalogue can't read says why: a link to nothing, a directory, a file this process can't open, a file too big to read.
  fs.unlinkSync(path);
  fs.symlinkSync(join(dir,'missing.json'),path);
  const unusable=()=>p.resolve(tools).diagnostics[0]?.match(/^Your tool presentation file can't be used \((.*)\), so none of its settings apply/)?.[1];
  assert.equal(unusable(),"it's a symbolic link to a file that doesn't exist");
  fs.unlinkSync(path);
  mkdirSync(path);
  assert.equal(unusable(),"it isn't a regular file");
  fs.rmdirSync(path);
  writeFileSync(path,'{"version":1,"tools":{}}');
  if (process.getuid?.() !== 0) {
   chmodSync(path,0o000);
   assert.equal(unusable(),"it couldn't be opened: EACCES");
   chmodSync(path,0o644);
  }
  // A path that runs through a file can't be opened, whoever runs the tests.
  assert.deepEqual(new ToolPresentation({path:join(path,'tools.json'),cataloguePath:'board/tools.md'}).resolve(tools).diagnostics[0]
   ?.match(/^Your tool presentation file can't be used \((.*)\), so none of its settings apply/)?.[1],"it couldn't be opened: ENOTDIR");
  writeFileSync(path,'x'.repeat(300_000));
  assert.equal(unusable(),"it's 300,000 bytes, over the 262,144 (256 KiB) this host reads");
 } finally {fs.writeFileSync=originalWrite;fs.renameSync=originalRename;fs.unlinkSync=originalUnlink;syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});

test('the catalogue quotes a read error no code names, cut at 500 characters, since nobody wrote it for the agent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-read-error-'));
 const originalRead=fs.readSync;
 try {
  const path=join(dir,'tools.json'), p=new ToolPresentation({path,cataloguePath:'board/tools.md'});
  writeFileSync(path,'{"version":1,"tools":{}}');
  fs.readSync=(()=>{throw new Error('z'.repeat(600));}) as typeof fs.readSync;
  syncBuiltinESMExports();
  const diagnostic=p.resolve(presentationTargets('example')).diagnostics[0];
  fs.readSync=originalRead;syncBuiltinESMExports();
  assert.equal(diagnostic?.match(/^Your tool presentation file can't be used \((.*)\), so none of its settings apply/)?.[1],`${'z'.repeat(500)}… (600 characters)`);
 } finally {fs.readSync=originalRead;syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});

test('a problem lists at most ten names, then how many more',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-lists-'));
 try {
  const path=join(dir,'tools.json'), defaults=join(dir,'defaults.json');
  const twelve=(prefix:string)=>Array.from({length:12},(_,i)=>`${prefix}${i}`);
  const listed=(names:string[])=>`${names.slice(0,10).map(name=>`"${name}"`).join(', ')} and 2 more`;
  const p=new ToolPresentation({path,cataloguePath:'board/tools.md',defaults:[{source:'MCPL server: big',path:defaults}]});
  const tools=[...presentationTargets('example',...twelve('big--t')),...presentationTools('board/tools.md')];
  // The agent's own call, with twelve arguments it doesn't take.
  const extra=p.edit('set_tool_visibility',{name:'example',visible:false,...Object.fromEntries(twelve('x').map(key=>[key,1]))},tools).error!;
  assert.ok(extra.startsWith(`Nothing was changed: ${listed(twelve('x'))} aren't arguments of set_tool_visibility. `),extra);
  // The file, with twelve keys at its top level and twelve in one entry.
  writeFileSync(path,JSON.stringify({version:1,tools:{example:Object.fromEntries(twelve('u').map(key=>[key,true]))},...Object.fromEntries(twelve('k').map(key=>[key,1]))}));
  const file=p.resolve(tools).diagnostics[0];
  assert.ok(file.includes(`only "version" and "tools" belong at the top level, not ${listed(twelve('k'))}; `),file);
  assert.ok(file.includes(`the entry for "example" has ${listed(twelve('u'))}, and an entry may have only "description" and "visible"`),file);
  // A defaults file that sets "visible" for twelve tools.
  rmSync(path);
  writeFileSync(defaults,JSON.stringify({version:1,tools:Object.fromEntries(twelve('big--t').map(name=>[name,{visible:false}]))}));
  const sources=new Map(twelve('big--t').map(name=>[name,'MCPL server: big']));
  const defaultsFile=p.resolve(tools,sources).diagnostics[0];
  assert.ok(defaultsFile.includes(`(it sets "visible" for ${listed(twelve('big--t'))}, and a defaults file may set only descriptions`),defaultsFile);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a FIFO at the presentation file is refused at once, not waited on with the process held',{skip:process.platform==='win32'?'no FIFOs':false},()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-fifo-'));
 try {
  const path=join(dir,'tools.json');
  assert.equal(spawnSync('mkfifo',[path]).status,0,'mkfifo');
  // Read in a child process, bounded: the read is synchronous, so an open that
  // waits for a writer holds the whole process it runs in.
  const module=new URL('../src/tool-presentation.js',import.meta.url).href;
  const script=`const {ToolPresentation}=await import(${JSON.stringify(module)});`
   +`const s=new ToolPresentation({path:${JSON.stringify(path)},cataloguePath:'board/tools.md'}).resolve([{name:'example',description:'original',inputSchema:{type:'object'}}]);`
   +'console.log(JSON.stringify({diagnostics:s.diagnostics,description:s.advertised[0].description}));';
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10_000});
  assert.equal(child.signal,null,`the read waited on the FIFO until the child was stopped (${child.signal})`);
  assert.equal(child.status,0,child.stderr);
  const out=JSON.parse(child.stdout);
  assert.match(out.diagnostics[0],/^Your tool presentation file can't be used \(it isn't a regular file\)/);
  assert.equal(out.description,'original','the default description stays');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
