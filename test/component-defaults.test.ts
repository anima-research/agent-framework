import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolPresentation} from '../src/tool-presentation.js';
test('component defaults are scoped, resident edits win, reset reveals default, missing components stay absent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'component-defaults-'));
 try {
  const path=join(dir,'resident.json'),profile=join(dir,'discord.json');
  writeFileSync(profile,JSON.stringify({version:1,tools:{send:{description:'clear'},other:{description:'wrong source'}}}));
  const p=new ToolPresentation({path,cataloguePath:'board/catalogue.md',defaults:[{source:'MCPL server: discord',path:profile},{source:'MCPL server: absent',path:join(dir,'absent.json')}]});
  const tools=[{name:'send',description:'original',inputSchema:{type:'object' as const}},{name:'other',description:'untouched',inputSchema:{type:'object' as const}}];
  const sources=new Map([['send','MCPL server: discord'],['other','Module: other']]);
  assert.deepEqual(p.resolve(tools,sources).available.map(t=>t.description),['clear','untouched']);
  assert.equal(p.resolve(tools,sources).diagnostics.length,0);
  assert.equal(p.edit('set_tool_description',{name:'send',description:'mine'},tools).success,true);
  p.edit('set_tool_visibility',{name:'send',visible:false},tools);
  assert.equal(p.resolve(tools,sources).entries[0].description,'mine');
  p.edit('set_tool_description',{name:'send',description:null},tools);
  assert.equal(p.resolve(tools,sources).entries[0].description,'clear');
  assert.equal(p.resolve(tools,sources).entries[0].visible,false);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).tools.send.description,undefined);
  assert.equal(p.resolve([tools[1]],sources).available.length,1);
  writeFileSync(profile,JSON.stringify({version:1,tools:{send:{visible:false,description:'bad'}}}));
  assert.equal(p.resolve(tools,sources).entries[0].description,'original');
  assert.equal(p.resolve(tools,sources).diagnostics.length,1);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('component and resident descriptions both retain catalogue discovery on editing tools',()=>{
 const dir=mkdtempSync(join(tmpdir(),'component-signpost-'));
 try {
  const profile=join(dir,'framework.json'),path=join(dir,'resident.json');
  const tools=['set_tool_visibility','set_tool_description'].map(name=>({name,description:'installed',inputSchema:{type:'object' as const}}));
  writeFileSync(profile,JSON.stringify({version:1,tools:Object.fromEntries(tools.map(t=>[t.name,{description:'profile wording'}]))}));
  const p=new ToolPresentation({path,cataloguePath:'board/recovery.md',defaults:[{source:'Framework',path:profile}]});
  const sources=new Map(tools.map(t=>[t.name,'Framework']));
  for(const tool of p.resolve(tools,sources).advertised){assert.match(tool.description,/profile wording/);assert.match(tool.description,/workspace--read.*board\/recovery.md/);}
  p.edit('set_tool_description',{name:'set_tool_visibility',description:'mine'},tools);
  const own=p.resolve(tools,sources).advertised[0];assert.match(own.description,/mine/);assert.match(own.description,/workspace--read.*board\/recovery.md/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('previewEdit resolves what an edit would leave, a reset exposing the default it reveals, and writes nothing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'component-preview-'));
 try {
  const path=join(dir,'resident.json'),profile=join(dir,'framework.json');
  writeFileSync(profile,JSON.stringify({version:1,tools:{send:{description:'clear'},set_tool_visibility:{description:'profile wording'}}}));
  const p=new ToolPresentation({path,cataloguePath:'board/catalogue.md',defaults:[{source:'Framework',path:profile}]});
  const tools=['send','set_tool_visibility','plain'].map(name=>({name,description:'installed '+name,inputSchema:{type:'object' as const}}));
  const sources=new Map(tools.map(t=>[t.name,'Framework']));
  writeFileSync(path,JSON.stringify({version:1,tools:{send:{description:'mine'},set_tool_visibility:{description:'mine too'},plain:{description:'mine as well'}}}));
  const before=readFileSync(path,'utf8');
  const entry=(snapshot: ReturnType<ToolPresentation['resolve']>,name: string)=>snapshot.entries.find(e=>e.name===name)!;
  // Each preview equals what the edit itself then leaves.
  for (const [tool,input] of [
   ['set_tool_description',{name:'send',description:null}],
   ['set_tool_description',{name:'set_tool_visibility',description:null}],
   ['set_tool_description',{name:'plain',description:null}],
   ['set_tool_description',{name:'send',description:'newer'}],
   ['set_tool_visibility',{name:'plain',visible:false}],
  ] as const) {
   const preview=entry(p.previewEdit(tool,input,tools,sources),input.name);
   assert.equal(readFileSync(path,'utf8'),before,'a preview writes nothing');
   assert.equal(p.edit(tool,input,tools).success,true);
   const after=entry(p.resolve(tools,sources),input.name);
   assert.deepEqual({visible:preview.visible,description:preview.description},{visible:after.visible,description:after.description},`${tool} ${JSON.stringify(input)}`);
   writeFileSync(path,before);
  }
  assert.equal(entry(p.previewEdit('set_tool_description',{name:'send',description:null},tools,sources),'send').description,'clear','the component default');
  assert.equal(entry(p.previewEdit('set_tool_description',{name:'plain',description:null},tools,sources),'plain').description,'installed plain','else the installed wording');
  assert.match(entry(p.previewEdit('set_tool_description',{name:'set_tool_visibility',description:null},tools,sources),'set_tool_visibility').description,/^profile wording\nCatalogue: workspace--read/,'with the editing tools\' signpost');
  // A preview refuses what the edit would refuse, with the same reason.
  for (const [tool,input] of [
   ['set_tool_visibility',{name:'workspace--read',visible:false}],
   ['set_tool_description',{name:'unknown',description:null}],
   ['set_tool_description',{name:'send',description:7}],
  ] as const) {
   const refused=p.edit(tool,input,[...tools,{name:'workspace--read',description:'read',inputSchema:{type:'object' as const}}]);
   assert.equal(refused.success,false);
   assert.throws(()=>p.previewEdit(tool,input,[...tools,{name:'workspace--read',description:'read',inputSchema:{type:'object' as const}}],sources),(e: Error)=>String(e)===refused.error);
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});
