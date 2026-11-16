import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const client = readFileSync(new URL('client.js', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

test('the client bundle registers under the package name', () => {
  // client-modules keys the boot graph by the resolved manifest name and looks
  // the factory up by that same id, so a bundle registered under anything else
  // (a profile dependency alias, for instance) fails at load time with
  // `loaded without registering "<name>" via __ModuleLoader__.load`.
  const match = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client);
  assert.ok(match, 'client.js registers a factory with a literal id');
  assert.equal(match[1], manifest.name);
});

test('the manifest keeps the client half wired to client.js', () => {
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.ok(manifest.files.includes('client.js'), 'the published package ships the bundle');
});
