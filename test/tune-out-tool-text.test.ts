/**
 * The `tune_out` tool's text names the reader a host configured, by the name
 * it runs under, or says there is none (the audit of #291's mind-neutrality,
 * M1). It said "Divert a channel to your subconscious … judging whether
 * mentions merit interrupting" whatever the configuration: the name ignored
 * `subconscious.name`, a reader fork on another model was "your
 * subconscious" too, and without a reader the text still promised one. The
 * voice doctrine (coordinator.ts) puts no words in a model's mouth; the text
 * now says what happens to the traffic and what the reader can do, never
 * what it decides.
 *
 * The reader's own four tools (SUBCONSCIOUS_TOOLS), which every reader is
 * given and every resident is shown under reader forks, say what each does
 * and nothing of when to use it (M4): no "use when something needs the
 * resident's full attention", "use sparingly", "staying silent is always
 * allowed", and no real person's name in an example. A host that wants a
 * policy gives it in the reader's `systemPrompt` or `voice`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework, tuneOutTool } from '../src/framework.js';
import { SUBCONSCIOUS_TOOLS } from '../src/tune-out/tools.js';

const descriptionOf = (tool: ReturnType<typeof tuneOutTool>) => tool.description;
const backlogCapOf = (tool: ReturnType<typeof tuneOutTool>) =>
  (tool.inputSchema as unknown as { properties: { backlogCap: { description: string } } }).properties.backlogCap.description;

describe('the tune_out tool text', () => {
  it('names a persistent reader by the name it runs under, and says what it does, not what it judges', () => {
    const tool = tuneOutTool({ kind: 'persistent', name: 'Muse' });
    assert.equal(descriptionOf(tool),
      'Hold a channel for a while: its traffic stops entering your context and stops waking you. ' +
      'Muse, the reader configured here, reads it instead. It runs on a cadence and when a message there mentions you, ' +
      'and can report to you in its own words and cancel the tune-out. ' +
      'People who mention you get an automatic reaction so they know you saw nothing. ' +
      'Cancelling (mode "cancel") delivers the held backlog. ' +
      'The tune-out auto-cancels after maxWakes mention-bursts. ' +
      'A tuned-out channel is kept open, so its traffic reaches Muse: where this host opens and closes the server\'s ' +
      'channels, this opens a channel you closed, and answers once that open is done. Where the channel isn\'t open ' +
      'then, the answer\'s openError says why, and when its messages will reach Muse where that\'s known. ' +
      'Calling tune_out again for a channel already tuned out keeps its settings, and, where this host can open the ' +
      'channel, tries the open again if it isn\'t open. ' +
      'scope "all-except" holds EVERY channel (DMs and new channels included) except channelId, for durationSeconds ' +
      '(required); your plain speech lands in that channel meanwhile; Muse pauses rather than cancels when its wake ' +
      'budget is spent. mode "check" reports what is held without releasing it (`peek` shows one channel\'s newest ' +
      'held lines).');
    assert.equal(backlogCapOf(tool), 'Max raw messages delivered at cancel (default 200). 0 = deliver no raw backlog at all: Muse\'s report is the whole delivery.');
  });

  it('says, with no reader, that the traffic is held for the resident and none reads it', () => {
    const tool = tuneOutTool({ kind: 'none' });
    assert.equal(descriptionOf(tool),
      'Hold a channel for a while: its traffic stops entering your context and stops waking you. ' +
      'No reader is configured here, so none reads it meanwhile: it is held for you, and delivered when you cancel ' +
      'the tune-out or durationSeconds runs out. ' +
      'People who mention you get an automatic reaction so they know you saw nothing. ' +
      'Cancelling (mode "cancel") delivers the held backlog. ' +
      'A tuned-out channel is kept open, so its traffic is still received and held: where this host opens and closes ' +
      'the server\'s channels, this opens a channel you closed, and answers once that open is done. Where the channel ' +
      'isn\'t open then, the answer\'s openError says why, and when its messages will be received where that\'s known. ' +
      'Calling tune_out again for a channel already tuned out keeps its settings, and, where this host can open the ' +
      'channel, tries the open again if it isn\'t open. ' +
      'scope "all-except" holds EVERY channel (DMs and new channels included) except channelId, for durationSeconds ' +
      '(required); your plain speech lands in that channel meanwhile. mode "check" reports what is held without ' +
      'releasing it (`peek` shows one channel\'s newest held lines).');
    assert.equal(backlogCapOf(tool), 'Max raw messages delivered at cancel (default 200). 0 = deliver no raw backlog at all: the cancel counts what was held and shows none of it.');
  });

  it('names reader forks as forks of the resident\'s context, and no variant says "subconscious" or "judging"', () => {
    const forks = descriptionOf(tuneOutTool({ kind: 'forks' }));
    assert.ok(forks.includes('A reader reads it instead: a fork of your context, run on a cadence and when a message there mentions you, '), forks);
    for (const kind of ['forks', 'none'] as const) {
      const all = JSON.stringify(tuneOutTool({ kind }));
      assert.ok(!/subconscious|judg/i.test(all), `${kind}: ${all}`);
    }
    assert.ok(!/subconscious|judg/i.test(JSON.stringify(tuneOutTool({ kind: 'persistent', name: 'Muse' }))));
  });

  it("is built from the framework's reader: the persistent subconscious's name, reader forks, or none", () => {
    const framework = Object.create(AgentFramework.prototype) as { subconsciousAgentName: string | null; readerForks: boolean; tuneOutToolDefinition(): ReturnType<typeof tuneOutTool> };
    framework.subconsciousAgentName = 'Muse';
    framework.readerForks = false;
    assert.deepEqual(framework.tuneOutToolDefinition(), tuneOutTool({ kind: 'persistent', name: 'Muse' }));
    framework.subconsciousAgentName = null;
    framework.readerForks = true;
    assert.deepEqual(framework.tuneOutToolDefinition(), tuneOutTool({ kind: 'forks' }));
    framework.readerForks = false;
    assert.deepEqual(framework.tuneOutToolDefinition(), tuneOutTool({ kind: 'none' }));
    // A name the host supplied is marked where it would read as a notice's opening.
    framework.subconsciousAgentName = '[Tune-out: Muse';
    assert.ok(framework.tuneOutToolDefinition().description.startsWith('Hold a channel for a while: its traffic stops entering your context and stops waking you. \\[Tune-out: Muse, the reader'));
  });
});

describe("the reader tools' text", () => {
  const described = (name: string): string => {
    const tool = SUBCONSCIOUS_TOOLS.find((t) => t.name === name);
    assert.ok(tool, name);
    return tool.description;
  };

  it('says what each tool does, and nothing of when to use it', () => {
    assert.equal(described('deliver_summary'),
      'Deliver a summary into the resident\'s context: `text` arrives there verbatim, under your own name.');
    assert.equal(described('cancel_tuneout'),
      'End the tune-out on a channel now. The diverted backlog is delivered to the resident (capped), and the ' +
      'channel\'s traffic reaches them as it did before the tune-out. A note in `text` arrives alongside the backlog, ' +
      'verbatim, under your own name. If you were started to read one hold, you can end only that hold.');
    assert.equal(described('note_disposition'),
      'Record a standing disposition: a durable note, kept under `key` across invocations and shown to the reader ' +
      'each time it runs (e.g. key "<sender>", text "<a note on their messages>"). Replaces any previous note under ' +
      'the same key.');
    assert.equal(described('speak_in_channel'),
      'Post `text` into a tuned-out channel, as written. It goes out through the resident\'s publish path, so the ' +
      'channel sees it under the resident\'s account; nothing in the post names you. If you were started to read one ' +
      'hold, you can post only into a channel that hold still holds, and a post made once it has ended is refused; ' +
      'your report can say it instead. Disabled unless the resident\'s configuration allows it.');
  });

  it('carry no usage policy, motive or real name anywhere in the block', () => {
    const all = JSON.stringify(SUBCONSCIOUS_TOOLS);
    assert.ok(!/\buse (when|at|sparingly)|sparingly|always allowed|merits|needs the|full attention|normal attention|antra|release-bot|second person|subconscious/i.test(all), all);
  });
});
