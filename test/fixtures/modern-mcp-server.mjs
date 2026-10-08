// Stdio modern-MCP fixture: SDK 2.x serveStdio pinned to 2026-07-28 with
// legacy openings refused (the house services' posture).
// Usage: node modern-mcp-server.mjs [startLog] [eventsFile]
// startLog receives one line per process start, to count launches.
import { appendFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './modern-tools.mjs';

const [startLog, eventsFile] = process.argv.slice(2);
if (startLog) appendFileSync(startLog, `start ${process.pid}\n`);
process.stderr.write(`modern fixture ${process.pid} up\n`);

serveStdio(() => createServer({ eventsFile }), { legacy: 'reject' });
