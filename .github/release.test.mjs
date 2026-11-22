import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseNeedsRecovery, waitForRegistry } from './release.mjs';

const publication = {
  name: 'dsh-sift-kb',
  version: '1.3.7',
  integrity: 'sha512-expected',
  commit: 'expected-commit',
};
const published = () => Response.json({
  dist: { integrity: publication.integrity },
  dshReleaseCommit: publication.commit,
});
const missing = () => new Response(null, { status: 404 });

function clockAndRegistry(...responses) {
  let elapsed = 0;
  let count = 0;
  const delays = [];
  return {
    delays,
    get requests() { return count; },
    options: {
      now: () => elapsed,
      delay: async ms => { elapsed += ms; delays.push(ms); },
      request: async () => responses[count++](),
    },
  };
}

test('the pre-publish check returns immediately for an absent version', async () => {
  const registry = clockAndRegistry(missing);
  assert.equal(await waitForRegistry(publication, { timeoutMs: 45_000, ...registry.options }), false);
  assert.equal(registry.requests, 1);
  assert.deepEqual(registry.delays, []);
});

test('confirmation succeeds when npm takes longer than one minute to expose the package', async () => {
  const registry = clockAndRegistry(...Array(17).fill(missing), published);
  assert.equal(await waitForRegistry(publication, {
    waitForMissing: true, timeoutMs: 300_000, ...registry.options,
  }), true);
  assert.equal(registry.requests, 18);
  assert.equal(registry.delays.reduce((total, delay) => total + delay, 0), 85_000);
});

test('transient registry errors retry before a version is accepted', async () => {
  const registry = clockAndRegistry(
    () => { throw new DOMException('timeout', 'TimeoutError'); },
    () => new Response(null, { status: 429, headers: { 'Retry-After': '12' } }),
    () => new Response(null, { status: 503 }),
    published,
  );
  assert.equal(await waitForRegistry(publication, { timeoutMs: 45_000, ...registry.options }), true);
  assert.deepEqual(registry.delays, [5_000, 12_000, 5_000]);
});

test('a version with a conflicting digest or commit fails immediately', async () => {
  for (const manifest of [
    { dist: { integrity: 'sha512-different' }, dshReleaseCommit: publication.commit },
    { dist: { integrity: publication.integrity }, dshReleaseCommit: 'different-commit' },
  ]) {
    const registry = clockAndRegistry(() => Response.json(manifest));
    await assert.rejects(waitForRegistry(publication, {
      waitForMissing: true, timeoutMs: 300_000, ...registry.options,
    }), /conflicts with the verified archive/);
    assert.equal(registry.requests, 1);
    assert.deepEqual(registry.delays, []);
  }
});

test('polling stops at its deadline without mistaking registry failures for absence', async () => {
  const absent = clockAndRegistry(missing, missing);
  assert.equal(await waitForRegistry(publication, {
    waitForMissing: true, timeoutMs: 8_000, ...absent.options,
  }), false);
  assert.deepEqual(absent.delays, [5_000, 3_000]);

  const unavailable = clockAndRegistry(() => new Response(null, { status: 503 }));
  await assert.rejects(waitForRegistry(publication, { timeoutMs: 1_000, ...unavailable.options }), error => {
    assert.equal(error.message, 'npm registry could not confirm the package version');
    assert.equal(error.cause.message, 'npm registry returned HTTP 503');
    return true;
  });
});

test('an absent, draft, or incomplete GitHub Release triggers recovery', () => {
  const expected = 'dsh-sift-kb-1.3.7.tgz';
  const expectedAsset = { name: expected };
  assert.equal(releaseNeedsRecovery(null, expected), true);
  assert.equal(releaseNeedsRecovery({ draft: true, assets: [expectedAsset] }, expected), true);
  assert.equal(releaseNeedsRecovery({ draft: false, assets: [{ name: 'other-file.tgz' }] }, expected), true);
  assert.equal(releaseNeedsRecovery({ draft: false, assets: [expectedAsset] }, expected), false);
});
