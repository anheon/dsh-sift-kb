/**
 * Same-origin HTTP routes used by the knowledge-base panel.
 *
 * The client half cannot call Host services directly (its builtins expose no
 * `remote`), so it talks to these routes with `fetch`. Every route checks the
 * Origin of a browser request; a missing Origin means a non-browser caller.
 * @module lib/routes
 */
import { stageBytes, stageLocal, listStaged, removeStaged } from './inbox.js';

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** Reject a cross-site browser request; allow tools and tests without Origin. */
export function sameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    request.on('error', reject);
  });
}

function readRaw(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`file is larger than ${Math.round(limit / 1024 / 1024)} MB`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const wrap = (fn) => async (request, response) => {
  try {
    if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin request rejected' });
    const url = new URL(request.url ?? '/', 'http://localhost');
    const body = request.method === 'POST' ? await readBody(request) : null;
    const value = await fn({ url, body, request });
    return sendJson(response, 200, value);
  } catch (error) {
    return sendJson(response, 400, { error: error?.message ?? String(error) });
  }
};

const intParam = (url, name, fallback) => {
  const value = Number(url.searchParams.get(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const textParam = (url, name) => {
  const value = url.searchParams.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

/**
 * Register every route and return one disposer.
 * @param webServer - the Host `webServer` service.
 * @param context - services this half needs.
 */
export function registerRoutes(webServer, { service, imports, config, ctx }) {
  const disposers = [];
  const add = route => {
    const dispose = webServer.register(route);
    disposers.push(typeof dispose === 'function' ? dispose : () => {});
  };

  add({
    kind: 'exact',
    path: '/sift-kb/health',
    handler: wrap(async () => ({ ok: true, plugin: 'dsh-sift-kb', mode: service.mode })),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/status',
    handler: wrap(async () => service.status()),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/start',
    handler: wrap(async () => service.ensureRunning()),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/stop',
    handler: wrap(async () => service.stop()),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/logs',
    handler: wrap(async ({ url }) => service.logs(intParam(url, 'lines', 120))),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/collections',
    handler: wrap(async () => {
      const data = await service.collections();
      const collections = Array.isArray(data?.collections) ? data.collections : [];
      return { index: data?.index ?? null, model: data?.model ?? null, collections };
    }),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/search',
    handler: wrap(async ({ url }) => {
      const kind = textParam(url, 'kind') ?? 'query';
      const query = textParam(url, 'q') ?? '';
      return service.search({
        kind,
        query,
        collection: textParam(url, 'collection'),
        k: intParam(url, 'k', 8),
        path: textParam(url, 'path'),
      });
    }),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/doc',
    handler: wrap(async ({ url }) => {
      const id = textParam(url, 'id');
      if (!id) throw new Error('id is required');
      return service.document({ id, lines: textParam(url, 'lines') });
    }),
  });

  // ---- material import ---------------------------------------------------

  add({
    kind: 'exact',
    path: '/sift-kb/stage',
    handler: async (request, response) => {
      try {
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin request rejected' });
        const url = new URL(request.url ?? '/', 'http://localhost');
        const name = textParam(url, 'name') ?? decodeURIComponent(String(request.headers['x-file-name'] ?? ''));
        const job = await imports.open({ jobId: textParam(url, 'job') });
        const data = await readRaw(request, config.maxDropBytes);
        const staged = await stageBytes({
          root: config.inboxPath,
          jobId: job.id,
          name,
          data,
          maxBytes: config.maxDropBytes,
          fileTypes: config.importFileTypes,
        });
        const files = await listStaged(config.inboxPath, job.id);
        const record = await imports.get(job.id);
        if (record) {
          record.files = files;
          await imports.save(record);
        }
        return sendJson(response, 200, { jobId: job.id, file: staged.file, files });
      } catch (error) {
        return sendJson(response, 400, { error: error?.message ?? String(error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/sift-kb/stage-local',
    handler: wrap(async ({ body }) => {
      const job = await imports.open({ jobId: body?.jobId });
      const staged = await stageLocal({
        root: config.inboxPath,
        jobId: job.id,
        sourcePath: body?.path,
        fileTypes: config.importFileTypes,
      });
      const record = await imports.addLocal(job.id, staged.files);
      const uploads = await listStaged(config.inboxPath, job.id);
      record.files = [...(record.localFiles ?? []), ...uploads];
      await imports.save(record);
      return { jobId: job.id, files: record.files };
    }),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/stage/remove',
    handler: wrap(async ({ body }) => {
      const job = await imports.get(body?.jobId);
      if (!job) throw new Error('unknown import job');
      let uploads = await listStaged(config.inboxPath, job.id);
      if (typeof body?.name === 'string' && body.name !== '') {
        uploads = await removeStaged(config.inboxPath, job.id, body.name);
      }
      if (typeof body?.path === 'string' && body.path !== '') {
        job.localFiles = (job.localFiles ?? []).filter(file => file.path !== body.path);
      }
      job.files = [...(job.localFiles ?? []), ...uploads];
      job.updatedAt = Date.now();
      await imports.save(job);
      return { jobId: job.id, files: job.files };
    }),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/imports',
    handler: wrap(async () => ({ jobs: await imports.list() })),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/import',
    handler: wrap(async ({ url }) => {
      const jobId = textParam(url, 'jobId');
      if (!jobId) throw new Error('jobId is required');
      const job = await imports.get(jobId);
      if (!job) throw new Error('unknown import job');
      const staged = await listStaged(config.inboxPath, jobId);
      return { job: { ...job, files: [...(job.localFiles ?? []), ...staged] }, staged };
    }),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/import/plan',
    handler: wrap(async ({ body }) => imports.plan(body ?? {})),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/import/confirm',
    handler: wrap(async ({ body }) => imports.confirm(body ?? {})),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/import/discard',
    handler: wrap(async ({ body }) => imports.discard(body?.jobId)),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/models',
    handler: wrap(async () => {
      const controller = ctx?.get?.('sessionController');
      if (!controller?.modelCatalog) throw new Error('model catalog is unavailable');
      return controller.modelCatalog();
    }),
  });

  add({
    kind: 'exact',
    path: '/sift-kb/presets',
    handler: wrap(async () => {
      const agentPresets = ctx?.get?.('agentPresets');
      const permissionPresets = ctx?.get?.('permissionPresets');
      let modes = [];
      if (agentPresets?.list) modes = await agentPresets.list();
      else if (agentPresets?.remoteExportList) modes = (await agentPresets.remoteExportList())?.presets ?? [];
      const permissions = permissionPresets?.catalog ? await permissionPresets.catalog() : null;
      return { modes, permissions };
    }),
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Unloading must not fail because one route was already gone.
      }
    }
  };
}
