/**
 * The `tune_out` tool's text names the reader a host configured, by the name
 * it runs under (the audit of #291's mind-neutrality, M1). It said "Divert a
 * channel to your subconscious … judging whether mentions merit
 * interrupting" whatever the configuration: the name ignored
 * `subconscious.name`, and a reader fork on another model was "your
 * subconscious" too. The
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
import * as readerWords from '../src/tune-out/tools.js';
import { SUBCONSCIOUS_TOOLS, tuneOutHeldWords } from '../src/tune-out/tools.js';

const descriptionOf = (tool: ReturnType<typeof tuneOutTool>) => tool.description;
const backlogCapOf = (tool: ReturnType<typeof tuneOutTool>) =>
  (tool.inputSchema as unknown as { properties: { backlogCap: { description: string } } }).properties.backlogCap.description;

describe('the tune_out tool text', () => {
  it('names a persistent reader by the name it runs under, and says what it does, not what it judges', () => {
    const tool = tuneOutTool({ kind: 'persistent', name: 'Muse' });
    assert.equal(descriptionOf(tool),
      'Hold a channel for a while: its traffic stops entering your context and stops waking you. ' +
      'Muse, the reader configured here, reads it instead. It runs on a cadence and when a message there that your ' +
      'wake rules let through mentions you or is from an author they privilege, and can report to you in its own ' +
      'words and cancel the tune-out. ' +
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

  it('names reader forks as forks of the resident\'s context, and no variant says "subconscious" or "judging"', () => {
    const forks = descriptionOf(tuneOutTool({ kind: 'forks' }));
    assert.ok(forks.includes('A reader reads it instead: a fork of your context, run on a cadence and when a message there that '
      + 'your wake rules let through mentions you or is from an author they privilege. It can report to you in its own words '
      + 'and cancel the tune-out. '), forks);
    assert.ok(!/subconscious|judg/i.test(JSON.stringify(tuneOutTool({ kind: 'forks' }))));
    assert.ok(!/subconscious|judg/i.test(JSON.stringify(tuneOutTool({ kind: 'persistent', name: 'Muse' }))));
  });

  it("is built from the framework's reader: the persistent subconscious's name, or reader forks", () => {
    const framework = Object.create(AgentFramework.prototype) as { subconsciousAgentName: string | null; readerForks: boolean; subconsciousConfig: { enabled: boolean; name?: string } | null; tuneOutToolDefinition(): ReturnType<typeof tuneOutTool> };
    framework.subconsciousAgentName = 'Muse';
    framework.readerForks = false;
    assert.deepEqual(framework.tuneOutToolDefinition(), tuneOutTool({ kind: 'persistent', name: 'Muse' }));
    framework.subconsciousAgentName = null;
    framework.readerForks = true;
    assert.deepEqual(framework.tuneOutToolDefinition(), tuneOutTool({ kind: 'forks' }));
    // A persistent reader that ended (tune_out stays listed while a hold its
    // failed release left is on record): named as configured.
    framework.readerForks = false;
    framework.subconsciousConfig = { enabled: true, name: 'Muse' };
    assert.deepEqual(framework.tuneOutToolDefinition(), tuneOutTool({ kind: 'persistent', name: 'Muse' }));
    // AF #844 review 2, #45: none runs then, which what its messages are says.
    assert.deepEqual((framework as unknown as { tuneOutReader(): unknown }).tuneOutReader(), { kind: 'persistent', name: 'Muse', running: false });
    // A name the host supplied is marked where it would read as a notice's opening.
    framework.subconsciousAgentName = '[Tune-out: Muse';
    assert.ok(framework.tuneOutToolDefinition().description.startsWith('Hold a channel for a while: its traffic stops entering your context and stops waking you. \\[Tune-out: Muse, the reader'));
  });
});

describe('what a held channel\'s messages are, said to the resident (AF #844 review 2, #45)', () => {
  it('names the reader that reads them, and says none does where none runs: a hold whose release failed after its reader ended', () => {
    assert.equal(tuneOutHeldWords({ kind: 'persistent', name: 'Muse' }), 'are held from you and read by Muse');
    assert.equal(tuneOutHeldWords({ kind: 'forks' }), 'are held from you and read by forks of your context');
    const none = { kind: 'persistent', name: 'Muse', running: false } as never;
    assert.equal(tuneOutHeldWords(none),
      "are held from you, with no reader running here to read them, until the tune-out's release, which failed, is tried again");
    const traffic = (readerWords as unknown as { tunedOutTrafficWords?: (r: unknown) => string }).tunedOutTrafficWords;
    assert.equal(typeof traffic, 'function', "the [tuned out] send note's words come from the same place");
    assert.equal(traffic!({ kind: 'persistent', name: 'Muse' }), 'is still held from you, and read by Muse, until the tune-out ends.');
    assert.equal(traffic!({ kind: 'forks' }), 'is still held from you, and read by forks of your context, until the tune-out ends.');
    assert.equal(traffic!(none),
      "is still held from you, with no reader running here to read it, until the tune-out's release, which failed, is tried again.");
    // The tool's own text names the reader as configured: a new tune_out is refused then anyway.
    assert.deepEqual(tuneOutTool(none), tuneOutTool({ kind: 'persistent', name: 'Muse' }));
  });

  it("says none reads them in tune_out's transport answers too, where none runs, in a sentence of its own (AF #844 review 3, #94; review 4, #37)", () => {
    const words = readerWords as unknown as {
      tuneOutReachWords: (r: unknown, form: string) => string;
      tuneOutNoReaderAnswer?: (r: unknown) => string | undefined;
    };
    // The words a transport answer puts after "its messages": a predicate, which the answer's own clause follows.
    assert.equal(words.tuneOutReachWords({ kind: 'persistent', name: 'Muse' }, 'reach'), 'reach Muse');
    assert.equal(words.tuneOutReachWords({ kind: 'forks' }, 'may not reach'), 'may not reach the reader');
    assert.equal(words.tuneOutReachWords({ kind: 'persistent', name: 'Muse' }, "don't reach"), "don't reach Muse");
    // Where none runs, the answer is a sentence of its own, given in place of those answers: it names no reader.
    assert.equal(typeof words.tuneOutNoReaderAnswer, 'function');
    assert.equal(words.tuneOutNoReaderAnswer!({ kind: 'persistent', name: 'Muse', running: false }),
      "The tune-out is recorded, but its messages are held, with no reader running here to read them, until the tune-out's "
      + "release, which failed, is tried again; opening its channel doesn't change that.");
    assert.equal(words.tuneOutNoReaderAnswer!({ kind: 'persistent', name: 'Muse' }), undefined, 'a reader runs: the transport answers say where the messages go');
    assert.equal(words.tuneOutNoReaderAnswer!({ kind: 'forks' }), undefined);
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
      'Deliver a summary into the resident\'s context: `text` arrives there verbatim (leading and trailing whitespace ' +
      'trimmed), under your own name.');
    assert.equal(described('cancel_tuneout'),
      'End the tune-out on a channel. The diverted backlog is delivered to the resident (capped), and the ' +
      'channel\'s traffic reaches them as it did before the tune-out, unless the all-except hold holds it too. A note ' +
      'in `text` arrives alongside the backlog, verbatim (leading and trailing whitespace trimmed), under your own name. ' +
      'Where the cancel has to wait (an operator\'s change to the store, say), its answer says so, and whether your ' +
      'note waits with it. If you were started to read one hold, you can end only that hold.');
    assert.equal(described('note_disposition'),
      'Record a standing disposition: a durable note, kept under `key` across invocations and shown to the reader ' +
      'each time it runs (e.g. key "<sender>", text "<a note on their messages>"). Replaces any previous note under ' +
      'the same key.');
    assert.equal(described('speak_in_channel'),
      'Post `text` into a tuned-out channel, as written (leading and trailing whitespace trimmed). It goes out ' +
      'through the resident\'s publish path, so the ' +
      'channel sees it under the resident\'s account; nothing in the post names you. If you were started to read one ' +
      'hold, you can post only into a channel that hold still holds, and a post made once it has ended is refused; ' +
      'your report can say it instead. Disabled unless the resident\'s configuration allows it.');
  });

  it('carry no usage policy, motive or real name anywhere in the block', () => {
    const all = JSON.stringify(SUBCONSCIOUS_TOOLS);
    assert.ok(!/\buse (when|at|sparingly)|sparingly|always allowed|merits|needs the|full attention|normal attention|antra|release-bot|second person|subconscious/i.test(all), all);
  });
});
