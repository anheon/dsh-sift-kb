/**
 * Import jobs: what the panel confirmed, and the conversation that runs it.
 *
 * The panel never runs the courseware pipeline itself. It records the job,
 * then asks the Host to create a fresh session and prompt it: the agent that
 * answers is the one that loads `courseware-to-sift`, because only an agent
 * can make the judgement calls that skill requires.
 * @module lib/imports
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { discardJob, listStaged, newJobId } from './inbox.js';

const JOB_ID = /^[a-z0-9][a-z0-9-]{7,31}$/;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Six pipeline steps the user sees before confirming. */
export const IMPORT_STEPS = [
  { id: 'preflight', label: '预检技能与依赖（pptx / OCR / PDF / sift）' },
  { id: 'plan', label: '识别章节与页型，生成分节计划' },
  { id: 'extract', label: '抽取文字与图片，OCR 公式与表格' },
  { id: 'build', label: '生成带 front matter 的分节 Markdown' },
  { id: 'import', label: '导入集合并生成向量索引' },
  { id: 'verify', label: '检索验收（GATE）并汇报结果' },
];

/** The instruction the import conversation receives. */
export function buildPrompt(job) {
  const lines = job.files.map(file => `- ${file.name}（${formatBytes(file.bytes)}）${file.kind === 'local' && file.path ? ` 源文件 ${file.path}` : ''}`);
  return [
    `用户已确认把这些资料导入本地 sift 知识库（集合 \`${job.collection}\`）。请按 \`courseware-to-sift\` 技能执行，不要手工写 collection。`,
    '',
    `作业编号：${job.id}`,
    `暂存目录：${job.inboxDir}`,
    job.chapterTitle ? `章节标题提示：${job.chapterTitle}` : '',
    '资料：',
    ...lines,
    '',
    '执行要求：',
    '1. 先加载 courseware-to-sift 技能，按其步骤 preflight → plan --force-sections → extract → build → import → verify 执行；Python 用 `D:\\sift-venv\\Scripts\\python.exe`。',
    '2. 在独立工作目录里操作（建议 `D:\\sift-data\\_import\\' + job.id + '`），绝不修改或删除用户的原始课件与已有 md。',
    '3. import 成功判据：`docs=… chunks=… embedded=… keywords=ready` 且 `embedded >= chunks`；verify 以末行 `GATE: PASS` 为准。不要为了通过 GATE 修改 expect。',
    '4. 导入成功且验收通过后，删除暂存目录（`' + job.inboxDir + '`）；若失败则保留暂存，并在汇报里说明原因。',
    '5. 需要我确认章节映射或其它歧义时，直接在对话里问，不要猜。',
    '6. 完成后用中文汇报：文档数、chunks、embedded、GATE 结果、工作目录路径、以及任何 OCR 线性化损失。',
  ].filter(line => line !== '').join('\n');
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function assertJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new Error('invalid job id');
}

export class ImportService {
  #config;
  #ctx;
  #logger;

  constructor({ config, ctx, logger } = {}) {
    this.#config = config;
    this.#ctx = ctx;
    this.#logger = logger;
  }

  get enabled() {
    return typeof this.#ctx?.get?.('sessionController') === 'object';
  }

  /** Create (or return) the record for a job the panel is still filling. */
  async open({ jobId } = {}) {
    const id = typeof jobId === 'string' && jobId !== '' ? jobId : newJobId();
    assertJobId(id);
    const existing = await this.get(id);
    if (existing) return existing;
    const job = {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'staged',
      files: [],
      localFiles: [],
      collection: null,
      chapterTitle: '',
      inboxDir: path.join(this.#config.inboxPath, id),
    };
    await this.#write(job);
    return job;
  }

  /** Remember files the user pointed at instead of dropping. */
  async addLocal(jobId, files) {
    const job = await this.open({ jobId });
    const known = new Set((job.localFiles ?? []).map(file => file.path));
    const added = files.filter(file => !known.has(file.path));
    job.localFiles = [...(job.localFiles ?? []), ...added];
    job.updatedAt = Date.now();
    await this.#write(job);
    return job;
  }

  /** Where a job's records live; one file per job, JSON. */
  #recordPath(jobId) {
    assertJobId(jobId);
    return path.join(this.#config.importsPath, `${jobId}.json`);
  }

  async #ensureDirs() {
    await fs.mkdir(this.#config.importsPath, { recursive: true });
    await fs.mkdir(this.#config.inboxPath, { recursive: true });
  }

  async #write(job) {
    await this.#ensureDirs();
    const target = this.#recordPath(job.id);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(job, null, 2), 'utf8');
    await fs.rename(temp, target);
    return job;
  }

  /** Persist a record the routes assembled themselves. */
  async save(job) {
    return this.#write(job);
  }

  /** Load one job, or null. */
  async get(jobId) {
    try {
      const text = await fs.readFile(this.#recordPath(jobId), 'utf8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Every stored job, newest first. */
  async list() {
    const entries = await fs.readdir(this.#config.importsPath).catch(() => []);
    const jobs = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const job = await this.get(entry.slice(0, -5));
      if (job) jobs.push(job);
    }
    return jobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /** Best-effort cleanup of half-finished jobs from previous weeks. */
  async prune(now = Date.now()) {
    for (const job of await this.list()) {
      if (now - (job.createdAt ?? now) < STALE_MS) continue;
      if (job.status === 'confirmed') continue;
      await this.discard(job.id).catch(() => {});
    }
  }

  /**
   * Build the confirmation card: what will happen, without doing it yet.
   * @param request - `{ jobId, collection, chapterTitle? }`.
   */
  async plan({ jobId, collection, chapterTitle } = {}) {
    assertJobId(jobId);
    if (typeof collection !== 'string' || collection.trim() === '') throw new Error('collection is required');
    const previous = await this.get(jobId);
    if (!previous) throw new Error('unknown import job');
    const staged = await listStaged(this.#config.inboxPath, jobId);
    const files = [...(previous.localFiles ?? []), ...staged];
    if (files.length === 0) throw new Error('this job has no files left');
    const totalBytes = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    const job = {
      ...previous,
      collection: collection.trim(),
      chapterTitle: typeof chapterTitle === 'string' ? chapterTitle.trim() : '',
      files,
      totalBytes,
      inboxDir: path.join(this.#config.inboxPath, jobId),
      updatedAt: Date.now(),
    };
    await this.#write(job);
    return {
      job,
      steps: IMPORT_STEPS,
      estimateMinutes: Math.max(2, Math.round((totalBytes / 1024 / 1024) * 1.6 + 2)),
      notes: [
        '将新开一个对话，由 Agent 在其中执行整理与导入；进度在那个对话里可见。',
        '不会修改或删除你的原始课件；导入成功后删除暂存副本。',
        '建议在资料较少时先试一批，确认集合与章节组织符合预期。',
      ],
    };
  }

  /**
   * Create the import conversation with the chosen preset, model and permission,
   * then prompt it. Everything recorded here is also returned to the panel.
   */
  async confirm({ jobId, agentPreset, model, permission } = {}) {
    const sessionController = this.#ctx?.get?.('sessionController');
    if (!sessionController) throw new Error('session orchestration is unavailable in this profile');
    const job = await this.get(jobId);
    if (!job) throw new Error('unknown import job');
    if (Array.isArray(job.files) && job.files.length === 0) throw new Error('this job has no files left');

    const warnings = [];
    const created = await sessionController.create({
      ...(typeof agentPreset === 'string' && agentPreset !== '' ? { agentPreset } : {}),
    });
    const sessionId = created?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('the session controller returned no session id');

    if (model && typeof model.provider === 'string' && typeof model.model === 'string') {
      try {
        await sessionController.selectModel({ sessionId, provider: model.provider, model: model.model });
      } catch (error) {
        warnings.push(`model selection failed: ${error?.message ?? String(error)}`);
      }
    }

    if (typeof permission === 'string' && permission !== '') {
      try {
        const session = this.#ctx?.get?.('sessions')?.get?.(sessionId);
        const presets = this.#ctx?.get?.('permissionPresets');
        if (session && presets) presets.set(session, permission);
        else warnings.push('permission preset was not applied: session service missing');
      } catch (error) {
        warnings.push(`permission preset failed: ${error?.message ?? String(error)}`);
      }
    }

    const prompt = buildPrompt(job);
    await sessionController.prompt({
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    });

    const updated = {
      ...job,
      status: 'confirmed',
      confirmedAt: Date.now(),
      sessionId,
      agentPreset: agentPreset ?? created?.agentPreset ?? null,
      model: model ?? null,
      permission: permission ?? null,
      warnings,
      updatedAt: Date.now(),
    };
    await this.#write(updated);
    this.#logger?.info?.(`dsh-sift-kb: import ${job.id} handed to session ${sessionId}`);
    return { sessionId, job: updated, prompt, warnings };
  }

  /** Drop the job record and its staged bytes. */
  async discard(jobId) {
    assertJobId(jobId);
    await discardJob(this.#config.inboxPath, jobId).catch(() => {});
    await fs.rm(this.#recordPath(jobId), { force: true }).catch(() => {});
    return { jobId, discarded: true };
  }
}
