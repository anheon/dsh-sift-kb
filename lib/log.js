/**
 * Log helpers for the sift child process.
 *
 * The child writes straight to a file descriptor owned by the plugin, so there
 * is no stream to pipe; rotation therefore happens before a start, when no
 * writer holds the file.
 * @module lib/log
 */
import fs from 'node:fs';
import path from 'node:path';

/** Create a directory and its parents, ignoring an existing one. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Size of a file in bytes, or 0 when it is missing. */
export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Shift `path` to `path.1` … `path.<keep>` when it exceeds `maxBytes`.
 * Best-effort: a locked file is left alone and reported.
 */
export function rotateIfNeeded(file, maxBytes, keep, logger) {
  try {
    if (fileSize(file) <= maxBytes) return false;
    if (keep <= 0) {
      fs.rmSync(file, { force: true });
      return true;
    }
    for (let index = keep; index > 1; index -= 1) {
      const from = `${file}.${index - 1}`;
      const to = `${file}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch (error) {
    logger?.warn?.(`dsh-sift-kb: could not rotate ${file}: ${error.message}`);
    return false;
  }
}

/**
 * Return the last `lines` lines of a text file, reading at most the tail of a
 * large file. Missing files read as an empty list.
 */
export function tailFile(file, lines = 100) {
  const wanted = Math.max(1, Math.floor(Number(lines) || 100));
  try {
    const size = fileSize(file);
    if (size === 0) return [];
    const window = Math.min(size, Math.max(8192, wanted * 400));
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(window);
      fs.readSync(handle, buffer, 0, window, size - window);
      const text = buffer.toString('utf8');
      const all = text.split(/\r?\n/);
      return all.slice(Math.max(0, all.length - wanted));
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return [];
  }
}

/** Open `file` for appending as the child's stdout/stderr, ensuring its directory. */
export function openLogFd(file) {
  ensureDir(path.dirname(file));
  return fs.openSync(file, 'a');
}
