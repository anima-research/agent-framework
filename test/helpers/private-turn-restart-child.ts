/**
 * Child process for turn-trigger-provenance's restart test: a later run of the
 * process, with its own turn-id counter. It opens the store the parent left
 * quiesced with a script's wake message deferred, resumes, which stores the
 * message, and prints one JSON line: whether it booted quiesced, whether the
 * message landed, and whether the agent's next start is marked to read
 * private input (privateInputStored).
 *
 * argv[2] = store path.
 */
import { AgentFramework } from '../../src/index.js';
import { MockMembrane } from './mock-membrane.js';

const [storePath] = process.argv.slice(2);
if (!storePath) {
  console.error('usage: private-turn-restart-child <storePath>');
  process.exit(2);
}
setTimeout(() => { console.error('private-turn-restart-child: never finished'); process.exit(4); }, 30_000);

const framework = await AgentFramework.create({
  storePath,
  membrane: new MockMembrane().asMembrane(),
  agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }],
  modules: [],
});
const bootedQuiesced = framework.getHostModeStatus().quiesced;
if (bootedQuiesced) await framework.resume();
const landed = framework.getAgent('scout')!.getContextManager().getAllMessages()
  .some((m) => (m.content[0] as { text?: string }).text === 'the build finished');
const privateInput = (framework as unknown as { privateInputStored: Set<string> }).privateInputStored.has('scout');
await framework.stop();
console.log(JSON.stringify({ bootedQuiesced, landed, privateInput }));
process.exit(0);
