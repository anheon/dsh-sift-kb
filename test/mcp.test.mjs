import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSse, unwrapToolResult } from '../lib/mcp.js';

test('SSE frames are decoded, including multi-line data', () => {
  const body = [
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":2,',
    'data: "result":{"ok":false}}',
    '',
  ].join('\n');
  const messages = parseSse(body);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].result, { ok: true });
  assert.deepEqual(messages[1].result, { ok: false });
});

test('non-JSON data lines are ignored rather than thrown', () => {
  assert.deepEqual(parseSse('data: not-json\n\n'), []);
});

test('structuredContent.result wins over the text block', () => {
  const value = unwrapToolResult({
    content: [{ type: 'text', text: '{"other":1}' }],
    structuredContent: { result: [{ id: 'a.md', score: 2 }] },
  });
  assert.deepEqual(value, [{ id: 'a.md', score: 2 }]);
});

test('a JSON text block is parsed when there is no structured content', () => {
  assert.deepEqual(unwrapToolResult({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
});

test('plain text is returned as-is', () => {
  assert.equal(unwrapToolResult({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
});

test('an errored tool result is thrown with its message', () => {
  assert.throws(
    () => unwrapToolResult({ isError: true, content: [{ type: 'text', text: 'collection missing' }] }),
    /collection missing/,
  );
});
