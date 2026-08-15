// ProseStreamRouter: streamed routing must agree with the delivery path's
// grammar (prose-grammar.parseProsePrefix + the envelope splitter) regardless
// of how the token stream is chopped. The last test is the property that
// matters most: char-by-char feeding ≡ one-shot feeding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProseStreamRouter, type RoutedDelta } from '../src/mcpl/prose-stream-router.js';

const RESOLVE: Record<string, string> = {
  '#general': 'discord:g:100',
  '#ops': 'discord:g:200',
  '@sol': 'discord:dm:300',
};

function explicit(): ProseStreamRouter {
  return new ProseStreamRouter({
    mode: 'explicit',
    initialTarget: null,
    resolve: (spec) => RESOLVE[spec] ?? null,
  });
}

function run(r: ProseStreamRouter, text: string, chunk = text.length): RoutedDelta[] {
  const out: RoutedDelta[] = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...r.feed(text.slice(i, i + chunk)));
  out.push(...r.finish());
  return out;
}

function textFor(deltas: RoutedDelta[], ch: string): string {
  return deltas.filter((d) => d.channelId === ch).map((d) => d.delta).join('');
}

test('locus mode: pure passthrough, >> lines are plain text', () => {
  const r = new ProseStreamRouter({ mode: 'locus', initialTarget: 'discord:g:100', resolve: () => null });
  const out = run(r, 'hello\n>>#ops not a prefix here\nbye');
  assert.equal(textFor(out, 'discord:g:100'), 'hello\n>>#ops not a prefix here\nbye');
});

test('explicit: unprefixed leading text is suppressed (delivery would bounce it)', () => {
  const out = run(explicit(), 'no destination yet\n>>#general now routed');
  assert.equal(textFor(out, 'discord:g:100'), 'now routed');
  assert.equal(out.every((d) => !d.delta.includes('no destination')), true);
});

test('explicit: multi-envelope switching, prefixes swallowed', () => {
  const out = run(explicit(), '>>#general hello there\nstill general\n>>#ops aside for ops\n>>@sol dm line');
  assert.equal(textFor(out, 'discord:g:100'), 'hello there\nstill general\n');
  assert.equal(textFor(out, 'discord:g:200'), 'aside for ops\n');
  assert.equal(textFor(out, 'discord:dm:300'), 'dm line');
});

test('quoted `>> arrow` and lone `>` stay body text', () => {
  const out = run(explicit(), '>>#general look:\n>> quoted arrow\n> markdown quote\ndone');
  assert.equal(textFor(out, 'discord:g:100'), 'look:\n>> quoted arrow\n> markdown quote\ndone');
});

test('skip_reply suppresses; later envelope resumes', () => {
  const out = run(explicit(), '>>skip_reply private thought\n>>#ops public line');
  assert.equal(out.every((d) => !d.delta.includes('private')), true);
  assert.equal(textFor(out, 'discord:g:200'), 'public line');
});

test('unresolvable target suppresses that envelope only', () => {
  const out = run(explicit(), '>>#nonexistent to nowhere\n>>#general to somewhere');
  assert.equal(out.every((d) => !d.delta.includes('nowhere')), true);
  assert.equal(textFor(out, 'discord:g:100'), 'to somewhere');
});

test('` !` continuation modifier is swallowed; `!` as body survives', () => {
  const out = run(explicit(), '>>#general ! next turn continues\n>>#ops !bang body');
  assert.equal(textFor(out, 'discord:g:100'), 'next turn continues\n');
  // grammar: `([ \t]+!)?` — the first ! after whitespace is the modifier,
  // remainder is body (matches parseProsePrefix on ">>#ops !bang body").
  assert.equal(textFor(out, 'discord:g:200'), 'bang body');
});

test('prefix on its own line routes the following lines', () => {
  const out = run(explicit(), '>>#general\nbody on next line\nand more');
  assert.equal(textFor(out, 'discord:g:100'), 'body on next line\nand more');
});

test('byChannel accumulates exactly the emitted text', () => {
  const r = explicit();
  run(r, '>>#general one\n>>#ops two');
  assert.equal(r.byChannel().get('discord:g:100'), 'one\n');
  assert.equal(r.byChannel().get('discord:g:200'), 'two');
});

test('PROPERTY: char-by-char ≡ one-shot, across every chunk size', () => {
  const text = 'lead-in ignored\n>>#general alpha\nbeta > gamma\n>> not a prefix\n>>#ops ! delta\n>>skip_reply hidden\n>>#general {{unsent}} tail';
  const oneShot = run(explicit(), text);
  for (const size of [1, 2, 3, 5, 7, 11]) {
    const chunked = run(explicit(), text, size);
    for (const ch of Object.values(RESOLVE)) {
      assert.equal(textFor(chunked, ch), textFor(oneShot, ch));
    }
  }
});

function hybrid(): ProseStreamRouter {
  return new ProseStreamRouter({
    mode: 'hybrid',
    initialTarget: 'world:commons',
    resolve: (spec) => RESOLVE[spec] ?? (spec === 'world:commons' ? 'world:commons' : null),
  });
}

test('hybrid: unprefixed prose stays on the frozen locus', () => {
  const out = run(hybrid(), 'ordinary world speech');
  assert.equal(textFor(out, 'world:commons'), 'ordinary world speech');
});

test('hybrid: triple-arrow target switches publication and consumes the envelope', () => {
  const out = run(hybrid(), '>>>#general cafe body');
  assert.equal(textFor(out, 'discord:g:100'), 'cafe body');
  assert.equal(out.every(d => !d.delta.includes('>>>')), true);
  assert.equal(textFor(out, 'world:commons'), '');
});

test('hybrid: permissive whitespace and cross-surface canonical ids', () => {
  const out = run(hybrid(), '  >>>   #ops spaced\n\t>>> world:commons home');
  assert.equal(textFor(out, 'discord:g:200'), 'spaced\n');
  assert.equal(textFor(out, 'world:commons'), 'home');
});

test('hybrid: double arrows and mid-line triple arrows remain ordinary locus prose', () => {
  const text = '>>#ops old syntax is prose\nlook >>>#ops quoted';
  const out = run(hybrid(), text);
  assert.equal(textFor(out, 'world:commons'), text);
  assert.equal(textFor(out, 'discord:g:200'), '');
});

test('hybrid: missing target suppresses that envelope; a later valid envelope resumes', () => {
  const out = run(hybrid(), '>>>#missing nowhere\nplain remains on failed target\n>>>world:commons restored');
  assert.equal(out.every(d => !d.delta.includes('nowhere') && !d.delta.includes('plain remains')), true);
  assert.equal(textFor(out, 'world:commons'), 'restored');
});

test('hybrid PROPERTY: char-by-char equals one-shot', () => {
  const text = 'locus first\n>>>#general alpha\nbeta\n>>> #ops delta\n>>>world:commons home';
  const one = run(hybrid(), text);
  for (const size of [1, 2, 3, 4, 7, 11]) {
    const chunked = run(hybrid(), text, size);
    for (const ch of ['world:commons', ...Object.values(RESOLVE)]) {
      assert.equal(textFor(chunked, ch), textFor(one, ch));
    }
  }
});
