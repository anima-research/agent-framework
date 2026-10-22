import { createHash, randomUUID } from 'node:crypto';
import { constants, fchmodSync, closeSync, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { closestNames } from './closest-names.js';
import { boundedErrorMessage, errorMessage } from './error-message.js';
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
/**
 * Opened with each read of a presentation file, as observe.ts opens workspace
 * files: a FIFO at the operator's path opens at once and fails the regular-file
 * check, where a blocking open would hold the whole process (it's synchronous)
 * until something opened the FIFO for writing.
 */
const NONBLOCK = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
const MAX_DESCRIPTION_CHARS = 32768;
const protectedNames = new Set(['set_tool_visibility', 'set_tool_description', 'workspace--read']);
export const isPresentationTool = (name: string): boolean => name === 'set_tool_visibility' || name === 'set_tool_description';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * A presentation or defaults file this host can't use. Each problem is a
 * clause about the file, such as `the entry for "x" has "visible": "no",
 * which must be true or false`; whoever reports it names the file and says
 * what follows from it.
 */
class PresentationFileError extends Error {
  constructor(problems: string[]) {
    const more = problems.length - 10;
    super((more > 0 ? [...problems.slice(0, 10), `${more} more problem${more === 1 ? '' : 's'}`] : problems).join('; '));
  }
}

/** An edit refused, in words for the agent: its message is the whole result. */
class PresentationRefusal extends Error {}

const count = (n: number): string => n.toLocaleString('en-US');

/** A text's length in code points, so a character outside the Basic Multilingual Plane, such as 😀, counts once where UTF-16 counts it twice. */
const characters = (text: string): number => [...text].length;

/** A text's first `n` characters, never splitting a code point. */
const firstCharacters = (text: string, n: number): string => [...text].slice(0, n).join('');

/** A name as a message quotes it: whole up to 60 characters, and past that cut, with its length, since a file can hold a key of any size. */
function quoted(name: string): string {
  return characters(name) <= 60 ? JSON.stringify(name) : `${JSON.stringify(firstCharacters(name, 57))}... (${count(characters(name))} characters)`;
}

/** A file's problem as a message quotes it: its own clauses whole, and anything else bounded, since nobody wrote that text for its reader. */
const problemText = (error: unknown): string => error instanceof PresentationFileError ? error.message : boundedErrorMessage(error);

/** A value as a message quotes it: short JSON for a scalar, the kind of anything bigger. */
function shown(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value !== null && typeof value === 'object') return 'an object';
  const json = JSON.stringify(value) ?? String(value);
  return characters(json) > 40 ? `${firstCharacters(json, 37)}...` : json;
}

/** Names quoted and joined: "a", "a" and "b", "a", "b" and "c"; past ten, the first ten and how many more, since a file can hold any number of keys. Each is quoted by `quote`: quoted() by default, which cuts a file's long keys, or JSON.stringify for names the agent should copy whole. */
function quotedList(names: string[], conjunction: 'and' | 'or' = 'and', quote: (name: string) => string = quoted): string {
  const each = names.slice(0, 10).map((name) => quote(name));
  if (names.length > 10) return `${each.join(', ')} ${conjunction} ${count(names.length - 10)} more`;
  return each.length > 1 ? `${each.slice(0, -1).join(', ')} ${conjunction} ${each[each.length - 1]}` : each.join('');
}

/**
 * Every problem that keeps a document from being used, each by where it is;
 * none for a usable one. A defaults file (`descriptionsOnly`) may set
 * descriptions only, since visibility is the resident's to choose.
 */
function documentProblems(doc: unknown, descriptionsOnly: boolean): string[] {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [`its top level is ${shown(doc)}, not an object like {"version":1,"tools":{}}`];
  const top = doc as Record<string, unknown>;
  const problems: string[] = [];
  if (top.version !== 1) problems.push(`"version" must be 1, and ${Object.hasOwn(top, 'version') ? `it is ${shown(top.version)}` : "it's missing"}`);
  const extra = Object.keys(top).filter((key) => key !== 'version' && key !== 'tools');
  if (extra.length) problems.push(`only "version" and "tools" belong at the top level, not ${quotedList(extra)}`);
  const tools = top.tools;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    problems.push(`"tools" must be an object of tool names, and ${Object.hasOwn(top, 'tools') ? `it is ${shown(tools)}` : "it's missing"}`);
    return problems;
  }
  const setsVisibility: string[] = [];
  for (const [name, value] of Object.entries(tools)) {
    if (!name) { problems.push('"tools" has an entry with an empty name'); continue; }
    const entry = `the entry for ${quoted(name)}`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${entry} is ${shown(value)}, not an object such as {"visible":false}`); continue; }
    const item = value as Record<string, unknown>;
    const unknown = Object.keys(item).filter((key) => key !== 'description' && key !== 'visible');
    if (unknown.length) problems.push(`${entry} has ${quotedList(unknown)}, and an entry may have only ${descriptionsOnly ? '"description"' : '"description" and "visible"'}`);
    if (Object.hasOwn(item, 'description')) {
      if (typeof item.description !== 'string') problems.push(`${entry} has a "description" that is ${shown(item.description)}, not a string`);
      else if (characters(item.description) > MAX_DESCRIPTION_CHARS) problems.push(`${entry} has a "description" of ${count(characters(item.description))} characters, over the ${count(MAX_DESCRIPTION_CHARS)} allowed`);
    }
    if (!Object.hasOwn(item, 'visible')) continue;
    if (descriptionsOnly) setsVisibility.push(name);
    else if (typeof item.visible !== 'boolean') problems.push(`${entry} has "visible": ${shown(item.visible)}, which must be true or false`);
    else if (!item.visible && protectedNames.has(name)) problems.push(`${entry} hides it, which isn't allowed, since workspace--read, set_tool_visibility and set_tool_description are how the catalogue is read and how these settings are undone`);
  }
  if (setsVisibility.length) problems.push(`it sets "visible" for ${quotedList(setsVisibility)}, and a defaults file may set only descriptions, since visibility is yours to choose`);
  return problems;
}

function parseDocument(raw: string, descriptionsOnly: boolean): PresentationDocument {
  let doc: unknown;
  try { doc = JSON.parse(raw); }
  catch (error) { throw new PresentationFileError([`it isn't valid JSON: ${errorMessage(error)}`]); }
  const problems = documentProblems(doc, descriptionsOnly);
  if (problems.length) throw new PresentationFileError(problems);
  return doc as PresentationDocument;
}

/** A resident's presentation document, or an error naming every problem that keeps it from being used. */
export function parsePresentation(raw: string): PresentationDocument {
  return parseDocument(raw, false);
}

/**
 * What an agent is told when an edit fails. Every throw in `edit()` comes
 * before its rename, and the cleanup after it never throws, so nothing was
 * changed: a refusal says so in its own words, a file this host can't use is
 * the host's to repair, and anything else is reported as the error it is.
 */
function editFailure(error: unknown): string {
  if (error instanceof PresentationRefusal) return error.message;
  if (error instanceof PresentationFileError) return `Nothing was changed: your tool presentation file can't be used (${error.message}), and these tools won't write over it until it's repaired. Ask whoever runs this host to repair it.`;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return `Nothing was changed: the edit failed (${typeof code === 'string' ? code : boundedErrorMessage(error)}). Ask whoever runs this host to check your tool presentation file and its directory.`;
}

/** Whether a path is a symbolic link, so an open that found nothing can tell a dangling link from no file. */
function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Runs one step of an edit's cleanup, which must not throw: it returns what the step threw, if it did. */
function tidy(step: () => void): { error: unknown } | undefined {
  try { step(); return undefined; } catch (error) { return { error }; }
}

/** What an edit says when its lock couldn't be removed afterwards, since every later edit will meet that lock. */
function lockLeftBehind(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return `This edit couldn't remove its lock afterwards, the presentation file's name with .lock added${typeof code === 'string' ? ` (${code})` : ''}. `
    + 'Until whoever runs this host removes it, set_tool_visibility and set_tool_description will be refused, saying an edit left its lock behind.';
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
    try { fd = openSync(path, constants.O_RDONLY | NONBLOCK); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (isLink(path)) throw new PresentationFileError(["it's a symbolic link to a file that doesn't exist"]);
        if (allowMissing) return '{"version":1,"tools":{}}';
        throw new PresentationFileError(["it doesn't exist"]);
      }
      throw new PresentationFileError([`it couldn't be opened: ${code ?? boundedErrorMessage(error)}`]);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new PresentationFileError(["it isn't a regular file"]);
      if (stat.size > MAX_BYTES) throw new PresentationFileError([`it's ${count(stat.size)} bytes, over the ${count(MAX_BYTES)} (256 KiB) this host reads`]);
      const data = Buffer.alloc(MAX_BYTES + 1);
      let size = 0, bytesRead = 0;
      while (size < data.length && (bytesRead = readSync(fd, data, size, data.length - size, null)) > 0) size += bytesRead;
      if (size > MAX_BYTES) throw new PresentationFileError([`it grew past ${count(MAX_BYTES)} bytes (256 KiB) while it was being read`]);
      return data.subarray(0,size).toString('utf8');
    } finally { closeSync(fd); }
  }
  resolve(tools: ToolDefinition[], sources: ReadonlyMap<string, string> = new Map()): PresentationSnapshot {
    let raw = '', doc: PresentationDocument = {version:1,tools:{}}, diagnostics: string[] = [];
    try { raw = this.read(); doc = parsePresentation(raw); }
    catch (error) { diagnostics.push(`Your tool presentation file can't be used (${problemText(error)}), so none of its settings apply: every tool is visible and shows its configured default description, or its installed one where none is configured. set_tool_visibility and set_tool_description won't change the file until it's repaired; ask whoever runs this host to repair it.`); }
    const defaults = new Map<string, {description: string; path: string}>();
    const configuredSources = new Set<string>();
    for (const profile of this.config.defaults ?? []) {
      if (configuredSources.has(profile.source)) {
        diagnostics.push(`The description defaults for ${JSON.stringify(profile.source)} are configured twice; only the first is read, and the other is ignored. Ask whoever runs this host to remove the duplicate.`); continue;
      }
      configuredSources.add(profile.source);
      // Absent components contribute neither tools nor missing-file errors.
      if (!tools.some(t => (sources.get(t.name) ?? 'Unattributed') === profile.source)) continue;
      try {
        const profileDoc = parseDocument(this.read(profile.path, false), true);
        for (const tool of tools) {
          if ((sources.get(tool.name) ?? 'Unattributed') !== profile.source) continue;
          const item = Object.hasOwn(profileDoc.tools, tool.name) ? profileDoc.tools[tool.name] : undefined;
          if (item?.description !== undefined) defaults.set(tool.name, {description:item.description,path:profile.path});
        }
      } catch (error) { diagnostics.push(`The description defaults for ${JSON.stringify(profile.source)} can't be used (${problemText(error)}), so its tools show their installed descriptions, or yours where you set one. Ask whoever runs this host to fix that defaults file.`); }
    }
    const names = new Set(tools.map(t => t.name));
    for (const name of Object.keys(doc.tools)) if (!names.has(name)) diagnostics.push(`Not currently available: ${quoted(name)}`);
    const entries = tools.map(tool => {
      const override = Object.hasOwn(doc.tools, tool.name) ? doc.tools[tool.name] : undefined;
      // Always retain a usable discovery signpost, even when its wording is overridden.
      const componentDefault = defaults.get(tool.name);
      let description = override?.description ?? componentDefault?.description ?? tool.description;
      const descriptionSource = override?.description !== undefined ? this.config.path : componentDefault?.path ?? "installed component";
      if (isPresentationTool(tool.name) && (override?.description !== undefined || componentDefault !== undefined))
        description += `\nCatalogue: workspace--read {"path":${JSON.stringify(this.config.cataloguePath)},"limit":140}. Changes affect the next newly compiled request.`;
      return {name:tool.name,source:sources.get(tool.name) ?? 'Unattributed',visible:override?.visible ?? true,originalDescription:tool.description,description,descriptionSource,inputSchema:structuredClone(tool.inputSchema)};
    });
    const available = tools.map((tool,i) => ({...structuredClone(tool),description:entries[i].description}));
    return {revision:hash(JSON.stringify({raw,entries,diagnostics})),source:this.config.path,cataloguePath:this.config.cataloguePath,diagnostics,available,
      advertised:available.filter((_,i)=>entries[i].visible),entries};
  }
  edit(tool: string, input: unknown, available: ToolDefinition[]): ToolResult {
    const lock = this.config.path + '.lock';
    let fd: number | undefined, tempFd: number | undefined, temp: string | undefined;
    let result: ToolResult, lockLeft: { error: unknown } | undefined;
    try {
      if (!isPresentationTool(tool)) throw new Error(`${tool} isn't a tool presentation editing tool`);
      const field = tool === 'set_tool_visibility' ? 'visible' : 'description';
      const name = this.editedName(tool, field, input, available);
      const value = input as Record<string, unknown>;
      try { fd = openSync(lock, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new PresentationRefusal("Nothing was changed: an earlier edit of your tool presentation file left its lock behind, or another edit is in progress. Call this again in a few seconds. If it fails the same way, ask whoever runs this host to remove the stale lock, the presentation file's name with .lock added, once nothing is editing the file.");
      }
      let mode = 0o600;
      try {
        const stat = lstatSync(this.config.path);
        if (stat.isSymbolicLink()) throw new PresentationRefusal("Nothing was changed: your tool presentation file is a symbolic link, and these tools don't write through links. Ask whoever runs this host to make the change in the file it points to, or to replace the link with that file.");
        mode = stat.mode & 0o777;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const before = this.read(), doc = parsePresentation(before);
      const old = Object.hasOwn(doc.tools,name) ? doc.tools[name] : {};
      const updated = {...old};
      if (field === 'description' && value.description === null) delete updated.description;
      else Object.assign(updated,{[field]:value[field]});
      Object.defineProperty(doc.tools,name,{value:updated,enumerable:true,writable:true,configurable:true});
      const next = JSON.stringify(doc,null,2)+'\n';
      // editedName has checked what this adds, so this can't fail on the agent's input;
      // it keeps a gap in those checks from writing a file the host would then ignore.
      parsePresentation(next);
      const size = Buffer.byteLength(next);
      if (size>MAX_BYTES) throw new PresentationRefusal(`Nothing was changed: with this change your tool presentation file would be ${count(size)} bytes, ${count(size - MAX_BYTES)} over its limit of ${count(MAX_BYTES)} (256 KiB). `
        + (field === 'description' ? 'Use a shorter description, or make room by restoring descriptions you no longer need with "description": null.' : 'Make room by restoring descriptions you no longer need with set_tool_description and "description": null.')
        + ' Entries for tools no longer available to you can be removed only by whoever runs this host.');
      temp = this.config.path + '.' + randomUUID() + '.tmp';
      tempFd = openSync(temp,'wx',0o600);
      writeFileSync(tempFd,next);
      fchmodSync(tempFd,mode); // preserve permissions on the opened inode, never a replacement path
      if (this.read() !== before) throw new PresentationRefusal('Nothing was changed: your tool presentation file changed while this edit was being made. Call this again; it applies to the file as it is now.');
      const opened = fstatSync(tempFd), named = lstatSync(temp);
      if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino)
        throw new PresentationRefusal('Nothing was changed: the temporary copy this edit was writing was replaced while it was written. Call this again; if it fails the same way, ask whoever runs this host to check what else writes beside your tool presentation file.');
      renameSync(temp,this.config.path); temp=undefined;
      result = {success:true,data:{name,[field]:value[field],effective:'next newly compiled request',catalogue:this.config.cataloguePath}};
    } catch (error) { result = {success:false,isError:true,error:editFailure(error)}; }
    finally {
      // After the rename the edit's result must stand, so no cleanup step may throw.
      const tempFdToClose = tempFd, tempToRemove = temp, lockFd = fd;
      if (tempFdToClose !== undefined) tidy(() => closeSync(tempFdToClose));
      if (tempToRemove) tidy(() => unlinkSync(tempToRemove));
      if (lockFd !== undefined) {
        tidy(() => closeSync(lockFd));
        lockLeft = tidy(() => unlinkSync(lock));
        // A lock already gone was removed by something else, so none is left.
        if ((lockLeft?.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') lockLeft = undefined;
      }
    }
    if (!lockLeft) return result;
    return result.success
      ? {...result,data:{...(result.data as Record<string, unknown>),note:lockLeftBehind(lockLeft.error)}}
      : {...result,error:`${result.error} ${lockLeftBehind(lockLeft.error)}`};
  }
  /**
   * The name of the tool an edit is for, once the agent's arguments hold up;
   * otherwise a refusal naming every problem with them and the call to make.
   * The limits a file would refuse (a description's length, the tools that
   * can't be hidden) are checked here too, so they read as the agent's input
   * rather than as a problem with the file.
   */
  private editedName(tool: string, field: 'visible' | 'description', input: unknown, available: ToolDefinition[]): string {
    const usage = field === 'visible'
      ? `set_tool_visibility takes {"name": a tool's exact name, "visible": true or false}.`
      : `set_tool_description takes {"name": a tool's exact name, "description": the new text, or null to restore the default}.`;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PresentationRefusal(`Nothing was changed: the arguments were ${shown(input)}, not an object. ${usage}`);
    const args = input as Record<string, unknown>, problems: string[] = [];
    if (!Object.hasOwn(args, 'name')) problems.push('"name" is missing');
    else if (typeof args.name !== 'string') problems.push(`"name" is ${shown(args.name)}, not a string`);
    if (!Object.hasOwn(args, field)) problems.push(`"${field}" is missing`);
    else if (field === 'visible' ? typeof args.visible !== 'boolean' : args.description !== null && typeof args.description !== 'string')
      problems.push(`"${field}" is ${shown(args[field])}, not ${field === 'visible' ? 'true or false' : 'a string or null'}`);
    const extra = Object.keys(args).filter((key) => key !== 'name' && key !== field);
    if (extra.length) problems.push(`${quotedList(extra)} ${extra.length > 1 ? "aren't arguments" : "isn't an argument"} of ${tool}`);
    if (problems.length) throw new PresentationRefusal(`Nothing was changed: ${problems.join('; ')}. ${usage}`);
    const name = args.name as string;
    if (!available.some((t) => t.name === name)) {
      const near = closestNames(name, available.map((t) => t.name));
      throw new PresentationRefusal(`Nothing was changed: you have no tool named ${quoted(name)}, shown or hidden.${near.length ? ` Did you mean ${quotedList(near, 'or', JSON.stringify)}?` : ''}`
        + ` Copy the exact name from your tool catalogue's index, workspace--read {"path":${JSON.stringify(this.config.cataloguePath)},"limit":140}, reading on with "offset" if the index runs past that.`);
    }
    if (field === 'description' && typeof args.description === 'string' && characters(args.description) > MAX_DESCRIPTION_CHARS)
      throw new PresentationRefusal(`Nothing was changed: the description is ${count(characters(args.description))} characters, over the ${count(MAX_DESCRIPTION_CHARS)} allowed. Shorten it and call set_tool_description again.`);
    if (field === 'visible' && args.visible === false && protectedNames.has(name))
      throw new PresentationRefusal(`Nothing was changed: ${name} can't be hidden, since workspace--read, set_tool_visibility and set_tool_description are how you read the catalogue and undo these changes. Calling this again won't change that.`);
    return name;
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
  // One line each: a quoted parse error can hold the file's own line breaks.
  for (const diagnostic of snapshot.diagnostics) lines.push('Diagnostic: '+diagnostic.replace(/\r\n|\r|\n/g, '\\n'));
  // What the resident hid comes first, each with the description it would
  // show, so a read from the top answers "what did I hide?" without a read
  // per hidden tool or a pass through every visible tool's description.
  const hidden = snapshot.entries.filter(e => !e.visible);
  if (hidden.length) {
    lines.push(`## Hidden (${hidden.length})`, '');
    for (const entry of hidden) lines.push(`### ${entry.name} (${entry.source})`, '', ...entry.description.split('\n'), '');
  }
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
