// Per-dial credential resolution: `accessProvider` overrides `token` at URL
// build time (transport.open runs it on every dial), and error-path URLs are
// redacted so credentials never ride error strings into traces or the model.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebSocketUrl } from '../src/mcpl/transport.js';
import type { McplServerConfig } from '../src/mcpl/types.js';

const base: McplServerConfig = { id: 's', url: 'wss://example.test/mcpl' };

describe('mcpl per-dial credentials', () => {
  it('static token appends as ?token=', () => {
    assert.equal(
      buildWebSocketUrl({ ...base, token: 'static' }),
      'wss://example.test/mcpl?token=static',
    );
  });

  it('override wins over static token; null strips it (redaction path)', () => {
    assert.equal(
      buildWebSocketUrl({ ...base, token: 'static' }, 'fresh'),
      'wss://example.test/mcpl?token=fresh',
    );
    assert.equal(
      buildWebSocketUrl({ ...base, token: 'static' }, null),
      'wss://example.test/mcpl',
    );
  });

  it('existing query params are preserved', () => {
    assert.equal(
      buildWebSocketUrl({ ...base, url: 'wss://example.test/mcpl?x=1' }, 'fresh'),
      'wss://example.test/mcpl?x=1&token=fresh',
    );
  });
});
