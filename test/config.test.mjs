import assert from 'node:assert/strict';
import test from 'node:test';
import { expandPath, resolveConfig } from '../lib/config.js';

const env = { USERPROFILE: 'C:\\Users\\tester', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };

test('an empty row resolves to the documented machine defaults', () => {
  const config = resolveConfig({}, { env });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8765);
  assert.deepEqual(config.args, ['serve', '--host', '127.0.0.1', '--port', '8765']);
  assert.equal(config.autoStartOnLaunch, false, 'the knowledge base is opt-in');
  assert.equal(config.stopOnDshExit, true);
  assert.equal(config.supervise, false);
  assert.equal(config.siftHome, 'C:\\Users\\tester\\.sift');
  assert.equal(config.logPath, 'C:\\Users\\tester\\AppData\\Local\\dsh-sift-kb\\logs\\sift-serve.log');
});

test('environment placeholders expand without a shell', () => {
  assert.equal(expandPath('%USERPROFILE%\\x', env), 'C:\\Users\\tester\\x');
  assert.equal(expandPath('${LOCALAPPDATA}\\y', env), 'C:\\Users\\tester\\AppData\\Local\\y');
  assert.equal(expandPath('%MISSING%', env), '%MISSING%');
});

test('the old stopOnDispose name still works', () => {
  const config = resolveConfig({ stopOnDispose: false }, { env });
  assert.equal(config.stopOnDshExit, false);
});

test('a port outside 1..65535 falls back and reports a warning', () => {
  const warnings = [];
  const config = resolveConfig({ port: 70000 }, { env, warnings });
  assert.equal(config.port, 8765);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /70000/);
});

test('explicit args win over the generated serve command', () => {
  const config = resolveConfig({ args: ['serve', '--port', '9000'] }, { env });
  assert.deepEqual(config.args, ['serve', '--port', '9000']);
});

test('non-boolean flags fall back instead of coercing', () => {
  const config = resolveConfig({ autoStartOnLaunch: 'yes', promptEnabled: 0 }, { env });
  assert.equal(config.autoStartOnLaunch, false);
  assert.equal(config.promptEnabled, true, 'a non-boolean value falls back to the default');
});
