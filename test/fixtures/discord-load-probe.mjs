import { createRequire } from 'node:module';
import { sep } from 'node:path';

const cache = createRequire(import.meta.url).cache;
const marker = `${sep}node_modules${sep}discord.js${sep}`;
const discordLoaded = () => Object.keys(cache).some((path) => path.includes(marker));

const framework = await import(process.argv[2]);
const afterImport = discordLoaded();
const client = new framework.DiscordJsClient({ token: 'test-token' });
const afterConstruct = discordLoaded();
await client.disconnect();
console.log(JSON.stringify({ afterImport, afterConstruct }));
