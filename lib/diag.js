/**
 * A tiny append-only journal next to the plugin's state file.
 *
 * DSH Desktop keeps no runtime log, so a bundle that fails inside an effect
 * would otherwise fail silently. Lines are timestamped and the file is capped
 * so a long-lived session cannot grow without bound.
 * @module lib/diag
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_BYTES = 256 * 1024;

/**
 * Write one diagnostic line.
 * @param config - resolved plugin config (uses `statePath`).
 * @param message - text to record; errors should be stringified by the caller.
 */
export function diag(config, message) {
  try {
    const file = join(dirname(config.statePath), 'plugin.log');
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Diagnostics must never break the feature they describe.
  }
}
