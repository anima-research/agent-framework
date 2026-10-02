import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { ToolDefinition, ToolResult } from './types/events.js';

export interface ToolPresentationConfig {
  /** Absolute path to shared editable JSON. Missing file means no overrides. */
  path: string;
  /** Reserved generated workspace path, e.g. board/tool-catalogue.md. */
  cataloguePath: string;
  /** Optional description-only profiles, bound to a registered component source. */
  defaults?: { source: string; path: string }[];
}
export interface ToolOverride { description?: string; visible?: boolean }
export interface PresentationDocument { version: 1; tools: Record<string, ToolOverride> }
export interface PresentationSnapshot {
  revision: string;
  source: string;
  cataloguePath: string;
  diagnostics: string[];
  available: ToolDefinition[];
  advertised: ToolDefinition[];
  entries: { name: string; source: string; visible: boolean; originalDescription: string; description: string; descriptionSource?: string; inputSchema: ToolDefinition['inputSchema'] }[];
}
const MAX_BYTES = 256 * 1024;
const protectedNames = new Set(['set_tool_visibility', 'set_tool_description', 'workspace--read']);
export const isPresentationTool = (name: string): boolean => name === 'set_tool_visibility' || name === 'set_tool_description';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export function parsePresentation(raw: string): PresentationDocument {
  const doc = JSON.parse(raw);
  if (!doc || doc.version !== 1 || !doc.tools || typeof doc.tools !== 'object' || Array.isArray(doc.tools)
      || Object.keys(doc).some(k => !['version', 'tools'].includes(k))) throw new Error('Expected {"version":1,"tools":{...}}');
  for (const [name, value] of Object.entries(doc.tools)) {
    if (!name || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid override: ${name}`);
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(k => !['description', 'visible'].includes(k))
      || ('description' in item && (typeof item.description !== 'string' || item.description.length > 32768))
      || ('visible' in item && typeof item.visible !== 'boolean')) throw new Error(`Invalid description/visibility for ${name}`);
    if (protectedNames.has(name) && item.visible === false) throw new Error(`Cannot hide recovery tool ${name}`);
  }
  return doc;
}

export function presentationTools(path: string): ToolDefinition[] {
  const signpost = ` Read the generated catalogue with workspace--read {"path":${JSON.stringify(path)},"limit":140}. Hidden tools remain available; changes affect the next newly compiled request, not an in-flight stream.`;
  return [
    {name:'set_tool_visibility', description:'Show or hide a tool definition. Hiding does not revoke permission.' + signpost,
      inputSchema:{type:'object',properties:{name:{type:'string'},visible:{type:'boolean'}},required:['name','visible'],additionalProperties:false}},
    {name:'set_tool_description', description:'Set a personal tool description; null restores the configured component default, or the installed description when none is configured.' + signpost,
      inputSchema:{type:'object',properties:{name:{type:'string'},description:{type:['string','null']}},required:['name','description'],additionalProperties:false}},
  ] as unknown as ToolDefinition[];
}

/** Per-agent presentation; files are the sole persistent source, independent of editor identity. */
export class ToolPresentation {
  constructor(readonly config: ToolPresentationConfig) {}
  private read(path = this.config.path, allowMissing = true): string {
    let fd: number;
    try { fd = openSync(path, 'r'); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return '{"version":1,"tools":{}}'; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Presentation must be a regular file under 256 KiB');
      const data = Buffer.alloc(MAX_BYTES + 1);
      let size = 0, count = 0;
      while (size < data.length && (count = readSync(fd, data, size, data.length - size, null)) > 0) size += count;
      if (size > MAX_BYTES) throw new Error('Presentation exceeds 256 KiB');
      return data.subarray(0,size).toString('utf8');
    } finally { closeSync(fd); }
  }
  resolve(tools: ToolDefinition[], sources: ReadonlyMap<string, string> = new Map()): PresentationSnapshot {
    let raw = '', doc: PresentationDocument = {version:1,tools:{}}, diagnostics: string[] = [];
    try { raw = this.read(); doc = parsePresentation(raw); }
    catch (error) { diagnostics.push(`Overrides not applied: ${String(error)}. Default visibility and component descriptions retained.`); }
    const defaults = new Map<string, {description: string; path: string}>();
    const configuredSources = new Set<string>();
    for (const profile of this.config.defaults ?? []) {
      if (configuredSources.has(profile.source)) {
        diagnostics.push(`Duplicate defaults source ignored: ${profile.source}`); continue;
      }
      configuredSources.add(profile.source);
      // Absent components contribute neither tools nor missing-file errors.
      if (!tools.some(t => (sources.get(t.name) ?? 'Unattributed') === profile.source)) continue;
      try {
        const profileDoc = parsePresentation(this.read(profile.path, false));
        if (Object.values(profileDoc.tools).some(item => Object.keys(item).some(k => k !== 'description')))
          throw new Error('Component defaults may contain descriptions only; visibility belongs to the resident');
        for (const tool of tools) {
          if ((sources.get(tool.name) ?? 'Unattributed') !== profile.source) continue;
          const item = Object.hasOwn(profileDoc.tools, tool.name) ? profileDoc.tools[tool.name] : undefined;
          if (item?.description !== undefined) defaults.set(tool.name, {description:item.description,path:profile.path});
        }
      } catch (error) { diagnostics.push(`Component defaults not applied (${profile.source}): ${String(error)}`); }
    }
    const names = new Set(tools.map(t => t.name));
    for (const name of Object.keys(doc.tools)) if (!names.has(name)) diagnostics.push(`Not currently available: ${name}`);
    const entries = tools.map(tool => {
      const override = Object.hasOwn(doc.tools, tool.name) ? doc.tools[tool.name] : undefined;
      // Always retain a usable discovery signpost, even when its wording is overridden.
      const componentDefault = defaults.get(tool.name);
      let description = override?.description ?? componentDefault?.description ?? tool.description;
      const descriptionSource = override?.description !== undefined ? this.config.path : componentDefault?.path ?? "installed component";
      if (isPresentationTool(tool.name) && override?.description !== undefined)
        description += `\nCatalogue: workspace--read {"path":${JSON.stringify(this.config.cataloguePath)},"limit":140}. Changes affect the next newly compiled request.`;
      return {name:tool.name,source:sources.get(tool.name) ?? 'Unattributed',visible:override?.visible ?? true,originalDescription:tool.description,description,descriptionSource,inputSchema:structuredClone(tool.inputSchema)};
    });
    const available = tools.map((tool,i) => ({...structuredClone(tool),description:entries[i].description}));
    return {revision:hash(JSON.stringify({raw,entries,diagnostics})),source:this.config.path,cataloguePath:this.config.cataloguePath,diagnostics,available,
      advertised:available.filter((_,i)=>entries[i].visible),entries};
  }
  edit(tool: string, input: unknown, available: ToolDefinition[]): ToolResult {
    const lock = this.config.path + '.lock';
    let fd: number | undefined, temp: string | undefined;
    try {
      if (!isPresentationTool(tool)) throw new Error('Unknown editing tool');
      const value = input as Record<string, unknown>;
      const field = tool === 'set_tool_visibility' ? 'visible' : 'description';
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string'
        || Object.keys(value).some(k=> !['name',field].includes(k)) || !Object.hasOwn(value,field)) throw new Error('Invalid editing arguments');
      if (!available.some(t=>t.name===value.name)) throw new Error('Tool is not currently available to this agent');
      if (field === 'visible' ? typeof value.visible !== 'boolean' : value.description !== null && typeof value.description !== 'string') throw new Error(`Invalid ${field}`);
      fd = openSync(lock, 'wx', 0o600);
      let mode = 0o600;
      try { const stat = lstatSync(this.config.path); if (stat.isSymbolicLink()) throw new Error('Edit the target file directly; tool editing refuses symlinks'); mode = stat.mode & 0o777; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const before = this.read(), doc = parsePresentation(before);
      const old = Object.hasOwn(doc.tools,value.name) ? doc.tools[value.name] : {};
      const updated = {...old};
      if (field === 'description' && value.description === null) delete updated.description;
      else Object.assign(updated,{[field]:value[field]});
      Object.defineProperty(doc.tools,value.name,{value:updated,enumerable:true,writable:true,configurable:true});
      const next = JSON.stringify(doc,null,2)+'\n';
      parsePresentation(next);
      if (Buffer.byteLength(next)>MAX_BYTES) throw new Error('Presentation exceeds 256 KiB');
      temp = this.config.path + '.' + randomUUID() + '.tmp';
      writeFileSync(temp,next,{flag:'wx',mode});
      if (this.read() !== before) throw new Error('File changed concurrently; retry after reading it');
      renameSync(temp,this.config.path); temp=undefined;
      return {success:true,data:{name:value.name,[field]:value[field],effective:'next newly compiled request',catalogue:this.config.cataloguePath}};
    } catch (error) { return {success:false,isError:true,error:String(error)}; }
    finally { if(temp) try{unlinkSync(temp);}catch{} if(fd!==undefined){closeSync(fd);unlinkSync(lock);} }
  }
}
export function renderCatalogue(snapshot: PresentationSnapshot): string {
  const groups = new Map<string, PresentationSnapshot['entries']>();
  for (const entry of snapshot.entries) {
    const group = groups.get(entry.source) ?? [];
    group.push(entry); groups.set(entry.source, group);
  }
  const visible = snapshot.entries.filter(e => e.visible).length;
  const lines: string[] = [
    '# Tool catalogue — generated from currently available tools', '',
    `Revision: ${snapshot.revision}`, '',
    `${snapshot.entries.length} tools: ${visible} visible, ${snapshot.entries.length-visible} hidden.`,
    'Visible = supplied in new requests. Hidden = stored away, still available.',
    'These are your visibility choices, not fixed primary/secondary rankings.',
    'Copy exact names from the index; similar-sounding names may not exist.',
    'Show a hidden tool: set_tool_visibility {"name":"EXACT_NAME","visible":true}.',
    `Read details: workspace--read {"path":${JSON.stringify(snapshot.cataloguePath)},"offset":LINE,"limit":LINES}.`,
    'Line references below belong to this revision; reread the index after changes.', '',
  ];
  for (const diagnostic of snapshot.diagnostics) lines.push('Diagnostic: '+diagnostic);
  lines.push('## Index by source', '');
  const index = new Map<string, number>();
  for (const [source, entries] of groups) {
    lines.push(`### ${source} (${entries.length})`);
    for (const entry of entries) {index.set(entry.name,lines.length);lines.push('');}
    lines.push('');
  }
  lines.push('## Full definitions', '');
  for (const [source, entries] of groups) {
    lines.push(`### ${source}`, '');
    for (const entry of entries) {
      const start = lines.length + 1;
      lines.push(`#### ${entry.name} (${entry.visible?'visible':'hidden'})`, '',
        ...entry.description.split('\n'), '', `Description from: ${entry.descriptionSource ?? 'installed component'}`, '', `Schema: ${JSON.stringify(entry.inputSchema)}`);
      if(entry.description!==entry.originalDescription) lines.push('', 'Original description:', ...entry.originalDescription.split('\n'));
      lines.push('');
      lines[index.get(entry.name)!] = `- [${entry.visible?'visible':'hidden'}] ${entry.name} — details: offset ${start}, limit ${lines.length-start+1}`;
    }
  }
  return lines.join('\n');
}
