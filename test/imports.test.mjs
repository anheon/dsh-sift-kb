import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPrompt, ImportService, IMPORT_STEPS } from '../lib/imports.js';
import { newJobId, safeFileName, stageBytes } from '../lib/inbox.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-kb-test-'));
  const config = {
    inboxPath: path.join(root, 'inbox'),
    importsPath: path.join(root, 'imports'),
    maxDropBytes: 1024 * 1024,
    importFileTypes: ['pptx', 'pdf'],
  };
  const calls = { created: null, model: null, prompt: null, permission: null };
  const sessionController = {
    async create(options) { calls.created = options; return { sessionId: 'session-1' }; },
    async selectModel(options) { calls.model = options; },
    async prompt(options) { calls.prompt = options; return { accepted: true }; },
  };
  const ctx = {
    get(name) {
      if (name === 'sessionController') return sessionController;
      if (name === 'sessions') return { get: () => ({ id: 'session-1' }) };
      if (name === 'permissionPresets') return { set: (session, name) => { calls.permission = { session, name }; } };
      return undefined;
    },
  };
  const imports = new ImportService({ config, ctx, logger: { info() {} } });
  await imports.prune();
  return { root, config, imports, calls };
}

async function makeJob(config, imports) {
  const job = await imports.open();
  await stageBytes({
    root: config.inboxPath,
    jobId: job.id,
    name: '第二章 化学平衡.pptx',
    data: Buffer.from('fake pptx bytes'),
    maxBytes: config.maxDropBytes,
    fileTypes: config.importFileTypes,
  });
  const files = [{ name: '第二章 化学平衡.pptx', bytes: 16, kind: 'upload' }];
  const record = await imports.get(job.id);
  record.files = files;
  await imports.save(record);
  return job.id;
}

test('safeFileName keeps one flat, legal name', () => {
  assert.equal(safeFileName('..\\..\\etc/passwd'), 'passwd');
  assert.equal(safeFileName('a<b>c:d?.pptx'), 'a_b_c_d_.pptx');
  assert.equal(safeFileName('   '), 'material');
});

test('newJobId is a legal job id', () => {
  const id = newJobId(1_700_000_000_000, () => 0.5);
  assert.match(id, /^imp-[a-z0-9]+$/);
  assert.ok(id.length >= 8);
});

test('the import prompt names the job, the files and the staging directory', async () => {
  const { config, imports } = await fixture();
  const jobId = await makeJob(config, imports);
  await imports.plan({ jobId, collection: 'chemistry' });
  const job = await imports.get(jobId);
  const prompt = buildPrompt({ ...job, inboxDir: path.join(config.inboxPath, jobId) });
  assert.match(prompt, new RegExp(jobId));
  assert.match(prompt, /courseware-to-sift/);
  assert.match(prompt, /第二章 化学平衡\.pptx/);
  assert.match(prompt, /删除暂存目录/);
  assert.match(prompt, /chemistry/);
});

test('plan reports the six steps and a total size', async () => {
  const { config, imports } = await fixture();
  const jobId = await makeJob(config, imports);
  const planned = await imports.plan({ jobId, collection: 'chemistry', chapterTitle: '第二章' });
  assert.equal(planned.steps.length, IMPORT_STEPS.length);
  assert.equal(planned.job.collection, 'chemistry');
  assert.equal(planned.job.files.length, 1);
  assert.ok(planned.estimateMinutes >= 2);
});

test('confirm creates a session with preset, model and permission, then prompts it', async () => {
  const { config, imports, calls } = await fixture();
  const jobId = await makeJob(config, imports);
  await imports.plan({ jobId, collection: 'chemistry' });
  const confirmed = await imports.confirm({
    jobId,
    agentPreset: 'ptc',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    permission: 'auto',
  });
  assert.equal(confirmed.sessionId, 'session-1');
  assert.deepEqual(calls.created, { agentPreset: 'ptc' });
  assert.deepEqual(calls.model, { sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(calls.permission.name, 'auto');
  assert.equal(calls.prompt.sessionId, 'session-1');
  assert.equal(calls.prompt.mode, 'queue');
  assert.match(calls.prompt.content[0].text, new RegExp(jobId));
  const stored = await imports.get(jobId);
  assert.equal(stored.status, 'confirmed');
  assert.equal(stored.sessionId, 'session-1');
});

test('discard removes the record and the staged bytes', async () => {
  const { config, imports } = await fixture();
  const jobId = await makeJob(config, imports);
  await imports.discard(jobId);
  assert.equal(await imports.get(jobId), null);
  const left = await fs.readdir(path.join(config.inboxPath, jobId)).catch(() => []);
  assert.deepEqual(left, []);
});
