// Tools for the modern-MCP fixture servers (SDK 2.x McpServer), shared by the
// stdio fixture (modern-mcp-server.mjs) and the in-process HTTP test server.
import { appendFileSync } from 'node:fs';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';

const obj = (properties = {}) => fromJsonSchema({ type: 'object', properties });

/**
 * @param {{ log?: (line: string) => void, eventsFile?: string }} [opts]
 * `eventsFile` (optional) receives one line per notable server-side event
 * (`slow-start`, `slow-aborted`, `slow-finished`) so a test can observe what
 * the server saw, independently of what the client reports.
 */
export function createServer(opts = {}) {
  const note = (line) => {
    opts.log?.(line);
    if (opts.eventsFile) appendFileSync(opts.eventsFile, `${line}\n`);
  };
  const server = new McpServer(
    { name: 'modern-fixture', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.registerTool('echo', { description: 'Echo text back', inputSchema: obj({ text: { type: 'string' } }) },
    async (args) => ({ content: [{ type: 'text', text: `echo:${args.text}` }] }));
  server.registerTool('structured_only', { description: 'Only structured content', inputSchema: obj() },
    async () => ({ content: [], structuredContent: { answer: 42, ok: false, nothing: null } }));
  server.registerTool('structured_and_text', { description: 'Summary text plus structured data', inputSchema: obj() },
    async () => ({ content: [{ type: 'text', text: 'Found 2 rows.' }], structuredContent: { rows: [{ id: 1 }, { id: 2 }] } }));
  server.registerTool('structured_zero', { description: 'Falsy structured value', inputSchema: obj() },
    async () => ({ content: [], structuredContent: 0 }));
  server.registerTool('media', { description: 'Mixed standard content', inputSchema: obj() },
    async () => ({
      content: [
        { type: 'text', text: 'before' },
        { type: 'resource_link', uri: 'file:///srv/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' },
        { type: 'resource', resource: { uri: 'memo://note', mimeType: 'text/plain', text: 'embedded note text' } },
        { type: 'resource', resource: { uri: 'memo://bin', mimeType: 'application/octet-stream', blob: Buffer.from('binary!').toString('base64') } },
        { type: 'audio', data: Buffer.from('RIFF0000WAVEfmt ').toString('base64'), mimeType: 'audio/wav' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
    }));
  server.registerTool('fail', { description: 'Reports a tool error', inputSchema: obj() },
    async () => ({ content: [{ type: 'text', text: 'the tool failed on purpose' }], isError: true }));
  server.registerTool('slow', { description: 'Sleeps, then answers', inputSchema: obj({ ms: { type: 'number' } }) },
    async (args, ctx) => {
      const ms = Number(args.ms ?? 1000);
      const signal = ctx?.mcpReq?.signal;
      note('slow-start');
      signal?.addEventListener('abort', () => note('slow-aborted'));
      await new Promise((resolve) => setTimeout(resolve, ms));
      note('slow-finished');
      return { content: [{ type: 'text', text: `slept ${ms}` }] };
    });
  server.registerTool('env', { description: 'Reports selected environment variables', inputSchema: obj() },
    async () => ({ content: [{ type: 'text', text: JSON.stringify({
      declared: process.env.FIXTURE_DECLARED ?? null,
      hostOnly: process.env.FIXTURE_HOST_ONLY ?? null,
      path: Boolean(process.env.PATH),
    }) }] }));
  let added = 0;
  server.registerTool('add_tool', { description: 'Registers another tool (list change)', inputSchema: obj() },
    async () => {
      const name = `added_${++added}`;
      server.registerTool(name, { description: 'added at runtime', inputSchema: obj() },
        async () => ({ content: [{ type: 'text', text: name }] }));
      return { content: [{ type: 'text', text: `registered ${name}` }] };
    });
  server.registerTool('shout', { description: 'Writes a line to stderr', inputSchema: obj({ text: { type: 'string' } }) },
    async (args) => { process.stderr.write(`shout: ${args.text}\n`); return { content: [{ type: 'text', text: 'shouted' }] }; });
  server.registerTool('die', { description: 'Exits the server process', inputSchema: obj() },
    async () => { setTimeout(() => process.exit(7), 10); return { content: [{ type: 'text', text: 'bye' }] }; });
  return server;
}
