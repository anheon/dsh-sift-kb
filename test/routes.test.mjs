import assert from 'node:assert/strict';
import test from 'node:test';
import { sameOrigin } from '../lib/routes.js';

test('a non-browser request without Origin is allowed', () => {
  assert.equal(sameOrigin({ headers: {} }), true);
});

test('a same-origin browser request is allowed', () => {
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:59536', host: '127.0.0.1:59536' } }), true);
});

test('a cross-site browser request is rejected', () => {
  assert.equal(sameOrigin({ headers: { origin: 'http://evil.test', host: '127.0.0.1:59536' } }), false);
});

test('a malformed Origin is rejected', () => {
  assert.equal(sameOrigin({ headers: { origin: 'null', host: '127.0.0.1:59536' } }), false);
});
