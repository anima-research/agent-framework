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
