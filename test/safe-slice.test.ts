import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeSlice } from '../src/safe-slice.js';

// One code point, two UTF-16 units: a high surrogate, then a low one.
const grin = '\u{1F600}';
const [high, low] = [grin[0]!, grin[1]!];

describe('safeSlice: no half of a surrogate pair faces a cut', () => {
  it('a start on the second half of a pair moves forward past it', () => {
    assert.equal(safeSlice(`a${grin}b`, 2, 4), 'b');
  });

  it('a start on any other unit stays where it is', () => {
    assert.equal(safeSlice(`ab${grin}c`, 1, 5), `b${grin}c`);
    assert.equal(safeSlice(`a${grin}b`, 1, 4), `${grin}b`);
  });

  it("a start of 0 cuts nothing, so the string's own first unit stays, a lone low surrogate included", () => {
    assert.equal(safeSlice(`${low}ab`, 0, 3), `${low}ab`);
  });

  it('an end inside a pair moves back before it', () => {
    assert.equal(safeSlice(`a${grin}b`, 0, 2), 'a');
  });

  it('an end just after a whole pair stays where it is', () => {
    assert.equal(safeSlice(`a${grin}b`, 0, 3), `a${grin}`);
  });

  it("an end at or past the length cuts nothing, so the string's own last unit stays, a lone high surrogate included", () => {
    assert.equal(safeSlice(`a${grin}`, 0, 3), `a${grin}`);
    assert.equal(safeSlice(`a${high}`, 0, 10), `a${high}`);
  });
});
