import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { McpHttpClient } from '../lib/mcp.js';
import { listeningPid, looksLikeSiftServe } from '../lib/probe.js';
import { registerRoutes } from '../lib/routes.js';
import { SiftService } from '../lib/service.js';

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  return { port, url: 'http://127.0.0.1:' + port + '/mcp' };
}

function mcpHandler(name, calls, collections = []) {
  return async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { id, method } = JSON.parse(body);
    calls.push(method);
    if (method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }
    const result = method === 'initialize'
      ? { serverInfo: { name }, protocolVersion: '2024-11-05', capabilities: { tools: {} } }
      : { structuredContent: { result: { collections } } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
}

test('rejects an unrelated MCP server before sending a tool call', async t => {
  const calls = [];
  const { url, port } = await serve(t, mcpHandler('another-service', calls));
  const mcp = new McpHttpClient({ url });
  await assert.rejects(mcp.call('query', { query: 'private request' }), /did not identify itself as sift/);
  const service = new SiftService({ config: resolveConfig({ port }) });
  assert.equal((await service.detect()).running, false);
  const status = await service.start();
  assert.equal(status.running, false);
  assert.match(status.lastError, /did not respond as a ready sift MCP server/);
  assert.deepEqual(calls, ['initialize', 'initialize', 'initialize']);
});

test('accepts a ready sift server but requires both external-stop permissions', async t => {
  const { port } = await serve(t, mcpHandler('sift', []));
  const defaults = resolveConfig({ port });
  assert.equal(defaults.allowStopExternal, false);
  const service = new SiftService({ config: defaults });
  const status = await service.start();
  assert.equal(status.running, true);
  assert.equal(status.adopted, true);
  await assert.rejects(service.stop({ allowExternal: true }), /requires enabling and confirming/);

  const optedIn = new SiftService({ config: resolveConfig({ port, allowStopExternal: true }) });
  await assert.rejects(optedIn.stop(), /requires enabling and confirming/);
  assert.equal((await optedIn.detect()).running, true);
});

test('does not report a sift handshake without a usable status as ready', async t => {
  const { port } = await serve(t, mcpHandler('sift', [], null));
  const service = new SiftService({ config: resolveConfig({ port }) });
  assert.equal((await service.detect()).running, false);
});

test('does not follow MCP redirects', async t => {
  let forwarded = 0;
  const target = await serve(t, (_request, response) => {
    forwarded += 1;
    response.writeHead(500).end();
  });
  const { url } = await serve(t, (_request, response) => {
    response.writeHead(307, { location: target.url }).end();
  });
  const mcp = new McpHttpClient({ url });
  await assert.rejects(mcp.call('status'), /fetch failed/);
  assert.equal(forwarded, 0);
});

test('matches only an unambiguous loopback listener and a sift serve entry point', () => {
  const rows = [
    ' TCP 192.0.2.4:8765 0.0.0.0:0 LISTENING 111',
    ' TCP 127.0.0.1:8765 0.0.0.0:0 LISTENING 222',
  ];
  assert.equal(listeningPid(rows.join('\n'), '127.0.0.1', 8765), 222);
  rows.push(' TCP 0.0.0.0:8765 0.0.0.0:0 LISTENING 333');
  assert.equal(listeningPid(rows.join('\n'), '127.0.0.1', 8765), null);
  assert.equal(looksLikeSiftServe('"C:\\Program Files\\sift.exe" serve --port 8765'), true);
  assert.equal(looksLikeSiftServe('C:\\venv\\python.exe -m sift serve'), true);
  assert.equal(looksLikeSiftServe('C:\\venv\\python.exe C:\\venv\\sift.exe serve'), true);
  assert.equal(looksLikeSiftServe('C:\\venv\\not-sift.exe serve'), false);
  assert.equal(looksLikeSiftServe('C:\\venv\\other.exe sift.exe serve'), false);
  assert.equal(looksLikeSiftServe('C:\\venv\\sift.exe search serve'), false);
});

async function route(handler, { method, headers = {}, body } = {}) {
  const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(request, { method, headers });
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(code, headers) {
      this.code = code;
      Object.assign(this.headers, headers);
    },
    end(text) { this.body = JSON.parse(text); },
  };
  await handler(request, response);
  return response;
}

test('state-changing routes require POST and block cross-site browser requests', async () => {
  const handlers = new Map();
  const stopCalls = [];
  registerRoutes({ register: ({ path, handler }) => handlers.set(path, handler) }, {
    service: { stop: options => { stopCalls.push(options); return { running: false }; } },
  });
  for (const name of ['start', 'stop', 'stage', 'stage-local', 'stage/remove', 'import/plan', 'import/confirm', 'import/discard']) {
    const response = await route(handlers.get('/sift-kb/' + name), { method: 'GET' });
    assert.equal(response.code, 405, name);
    assert.equal(response.headers.allow, 'POST');
  }
  const stop = handlers.get('/sift-kb/stop');
  assert.equal((await route(stop, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).code, 403);
  assert.deepEqual(stopCalls, []);
  assert.equal((await route(stop, { method: 'POST' })).code, 200);
  assert.equal((await route(stop, { method: 'POST', body: { allowExternal: true } })).code, 200);
  assert.deepEqual(stopCalls, [{ allowExternal: false }, { allowExternal: true }]);
});
