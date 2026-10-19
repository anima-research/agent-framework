import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestNames, isNearMiss } from '../src/closest-names.js';

// What a refusal suggests when a name matches nothing (closestNames), and
// when one name counts as a slip for another (isNearMiss).
const tools = ['workspace--read', 'workspace--ls', 'workspace--write', 'history--read', 'read_image',
  'set_tool_visibility', 'set_tool_description', 'think'];

test('closestNames ranks a whole segment, then a prefix, then a substring, then a few edits, ignoring case', () => {
  assert.deepEqual(closestNames('WORKSPACE--READ', tools), ['workspace--read']);
  assert.deepEqual(closestNames('ls', tools), ['workspace--ls'], 'a module tool named without its module');
  assert.deepEqual(closestNames('read', tools, 3), ['history--read', 'workspace--read', 'read_image'], 'segments before a prefix');
  assert.deepEqual(closestNames('set_tool', tools), ['set_tool_visibility', 'set_tool_description']);
  assert.deepEqual(closestNames('image', tools), ['read_image']);
  assert.deepEqual(closestNames('thnik', tools), ['think'], 'a transposition is one edit');
  assert.deepEqual(closestNames('workspace--raed', tools), ['workspace--read'], 'a typo within a namespace finds its name, not its neighbours');
  assert.deepEqual(closestNames('think', ['thing', 'rethink', 'think_more', 'agent--think'], 4),
    ['agent--think', 'think_more', 'rethink', 'thing'], 'each tier ranks ahead of the next, even where the next is fewer edits away');
  assert.deepEqual(closestNames('thinking', ['hinkin', 'think']), ['think', 'hinkin'],
    'a candidate the name starts with ranks ahead of one it holds, even one fewer edits away');
  assert.deepEqual(closestNames('rethinking', ['think']), ['think'], 'a candidate the name holds, however many edits away');
  assert.deepEqual(closestNames('read', ['b--read', 'a--read']), ['b--read', 'a--read'], 'a tie keeps the order given');
  assert.deepEqual(closestNames('think', ['think', 'think']), ['think'], 'a candidate given twice is named once');
  assert.deepEqual(closestNames('refilIntervalM', ['refillIntervalMs']), ['refillIntervalMs'],
    'two edits are within the limit for a long name, past the prefix it shares');
});

test('closestNames gives nothing for a name close to nothing, or for a fragment found in every name', () => {
  assert.deepEqual(closestNames('deploy', tools), []);
  assert.deepEqual(closestNames('re', tools), [], 'two letters are no prefix or substring match');
  assert.deepEqual(closestNames('read', tools, 1), ['history--read'], 'max bounds the answer');
});

test('isNearMiss: the same ignoring case, or a few edits; past that, a different name', () => {
  for (const [slip, field] of [['keyby', 'keyBy'], ['pasthrough', 'passthrough'], ['polices', 'policies'], ['tagsAyn', 'tagsAny'],
    ['refilIntervalM', 'refillIntervalMs'], ['channels', 'channel']]) {
    assert.equal(isNearMiss(slip, field), true, `${slip} for ${field}`);
  }
  for (const [other, field] of [['comment', 'content'], ['type', 'text'], ['scope', 'match']]) {
    assert.equal(isNearMiss(other, field), false, `${other} is not ${field}`);
  }
  assert.equal(isNearMiss('workspace--read', 'workspace--write'), false,
    'a shared prefix is a namespace, so neighbours in it are counted by what follows it');
});

test('isNearMiss: a part of a name, of three characters or more, is a slip for it; a name holding another, more edits from it than a slip allows, is not', () => {
  for (const [part, field] of [['interval', 'intervalSeconds'], ['mode', 'deliveryMode'], ['channel', 'targetChannelId'], ['EVERY', 'everySeconds'], ['key', 'keyBy']]) {
    assert.equal(isNearMiss(part, field), true, `${part} for ${field}`);
  }
  for (const [extra, field] of [['channel_note', 'channel'], ['pausedReason', 'paused']]) {
    assert.equal(isNearMiss(extra, field), false, `${extra} is an extra beside ${field}`);
  }
  assert.equal(isNearMiss('id', 'channelId'), false, 'two characters are no part of a name');
});

test('closestNames answers a long name that holds every candidate without an edit table for each (a hang guard)', () => {
  // A name an agent might paste by mistake, such as a catalogue holding every
  // tool name: one name holds the other, so the length difference is their
  // distance. An edit table for each would take over a minute here.
  const names = Array.from({ length: 100 }, (_, i) => `server${i % 10}--a_tool_whose_name_runs_long_to_cost_the_edit_table_${i}`);
  let text = '';
  while (text.length < 1_000_000) text += names.map((name) => `- ${name}: a line of its catalogue entry.`).join('\n') + '\n';
  const started = performance.now();
  assert.deepEqual(closestNames(text, names), [names[10], names[11]], 'the longest names are the closest, in the order given');
  assert.ok(performance.now() - started < 5_000, `took ${Math.round(performance.now() - started)} ms`);
});
