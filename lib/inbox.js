/**
 * Staging area for material the user wants to import.
 *
 * Two ways in: bytes dropped in the panel (written under the inbox) and a path
 * that already exists on this machine (referenced, never copied). Both end up
 * in one job directory so the import conversation has a single list to work
 * from, and the directory is deleted once the import finishes.
 * @module lib/inbox
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const JOB_ID = /^[a-z0-9][a-z0-9-]{7,31}$/;
const MAX_LOCAL_FILES = 64;
const MAX_LOCAL_DEPTH = 3;

/** Reject anything that tries to escape the inbox. */
function jobDirectory(root, jobId) {
  if (!JOB_ID.test(jobId)) throw new Error('invalid job id');
  const dir = path.resolve(root, jobId);
  const base = path.resolve(root);
  if (dir !== path.join(base, jobId)) throw new Error('invalid job id');
  return dir;
}

/** Turn arbitrary client text into one safe file name. */
export function safeFileName(name) {
  const base = String(name ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  const trimmed = base === '' ? 'material' : base.slice(0, 120);
  return trimmed;
}

export function extensionOf(name) {
  return path.extname(String(name ?? '')).replace(/^\./, '').toLowerCase();
}

export function isAllowedType(name, fileTypes) {
  return fileTypes.includes(extensionOf(name));
}

export function newJobId(now = Date.now(), random = Math.random) {
  const stamp = now.toString(36).slice(-6);
  const tail = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  return `imp-${stamp}${tail}`;
}

/**
 * Write an uploaded file into its job directory.
 * @param root - inbox root from config.
 * @param jobId - existing or freshly generated id.
 * @param name - client supplied name (never trusted as a path).
 * @param data - Buffer of the request body.
 * @param maxBytes - hard limit for one file.
 */
export async function stageBytes({ root, jobId, name, data, maxBytes, fileTypes }) {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('upload is empty');
  if (data.length > maxBytes) throw new Error(`file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (!isAllowedType(name, fileTypes)) throw new Error(`unsupported file type: ${extensionOf(name) || '(none)'}`);
  const dir = jobDirectory(root, jobId);
  await fs.mkdir(dir, { recursive: true });
  const safe = safeFileName(name);
  let stored = safe;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.writeFile(path.join(dir, stored), data, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 50) throw error;
      const ext = path.extname(safe);
      stored = `${path.basename(safe, ext)}-${attempt}${ext}`;
    }
  }
  const info = await fs.stat(path.join(dir, stored));
  return { jobId, file: { name: stored, originalName: safe, bytes: info.size, kind: 'upload' } };
}

async function walk(dir, depth, found, fileTypes) {
  if (depth > MAX_LOCAL_DEPTH || found.length >= MAX_LOCAL_FILES) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (found.length >= MAX_LOCAL_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      await walk(full, depth + 1, found, fileTypes);
    } else if (entry.isFile() && isAllowedType(entry.name, fileTypes)) {
      const info = await fs.stat(full);
      found.push({ name: entry.name, path: full, bytes: info.size, kind: 'local' });
    }
  }
}

/**
 * Validate a path the user typed or picked and turn it into job entries.
 * Directories are walked a couple of levels to find supported files.
 */
export async function stageLocal({ root, jobId, sourcePath, fileTypes }) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') throw new Error('path is required');
  const full = path.resolve(sourcePath.trim());
  const info = await fs.stat(full).catch(() => null);
  if (info === null) throw new Error('path does not exist');
  const dir = jobDirectory(root, jobId);
  await fs.mkdir(dir, { recursive: true });

  if (info.isFile()) {
    if (!isAllowedType(full, fileTypes)) throw new Error(`unsupported file type: ${extensionOf(full) || '(none)'}`);
    return { jobId, files: [{ name: path.basename(full), path: full, bytes: info.size, kind: 'local' }] };
  }
  if (!info.isDirectory()) throw new Error('path is neither a file nor a directory');
  const found = [];
  await walk(full, 0, found, fileTypes);
  if (found.length === 0) throw new Error('no supported files found in that folder');
  return { jobId, files: found };
}

/** Files already staged for this job; empty when the directory is gone. */
export async function listStaged(root, jobId) {
  const dir = jobDirectory(root, jobId);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const info = await fs.stat(path.join(dir, entry.name));
    files.push({ name: entry.name, bytes: info.size, kind: 'upload' });
  }
  return files;
}

/** Delete a job directory; missing is fine (the import conversation may win). */
export async function discardJob(root, jobId) {
  const dir = jobDirectory(root, jobId);
  await fs.rm(dir, { recursive: true, force: true });
}

/** Delete one staged upload; the record is updated by the caller. */
export async function removeStaged(root, jobId, name) {
  const dir = jobDirectory(root, jobId);
  const safe = safeFileName(name);
  await fs.rm(path.join(dir, safe), { force: true });
  return listStaged(root, jobId);
}
