/**
 * Process and port probing for the local sift server.
 *
 * A listening port is not proof that sift owns it, and a PID is not proof that
 * the process is still ours: both facts are checked before anything is killed.
 * @module lib/probe
 */
import net from 'node:net';
import { execFile } from 'node:child_process';

/** Resolve true when something accepts TCP connections on host:port. */
export function probePort(host, port, timeoutMs = 1200) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

const run = (file, args, { timeoutMs = 5000 } = {}) => new Promise(resolve => {
  execFile(file, args, { windowsHide: true, timeout: timeoutMs, windowsVerbatimArguments: false }, (error, stdout) => {
    resolve(error ? null : String(stdout));
  });
});

/**
 * Find the PID listening on `port`, using `netstat -ano -p tcp`.
 * Returns null when the port is not listening or the output is unreadable.
 */
export async function findListeningPid(port) {
  const output = await run('netstat', ['-ano', '-p', 'tcp']);
  if (!output) return null;
  const suffix = `:${port}`;
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    const [, local, , state, pid] = columns;
    if (state !== 'LISTENING' || !local.endsWith(suffix)) continue;
    const number = Number(pid);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

/** Read a process command line on Windows; null when unavailable. */
export async function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;
  const output = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 8000 });
  const text = output?.trim() ?? '';
  return text === '' ? null : text;
}

/** True when a command line plausibly runs `sift serve`. */
export function looksLikeSiftServe(commandLine) {
  if (typeof commandLine !== 'string') return false;
  return /sift(?:\.exe)?(?=["\s]|$)/i.test(commandLine) && /\bserve\b/i.test(commandLine);
}

/** Kill a process tree on Windows; resolves true when the process is gone. */
export async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const output = await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 });
  if (output !== null) return true;
  // taskkill fails when the process already exited; that still counts as gone.
  return !(await isAlive(pid));
}

/** Whether a PID still exists. */
export async function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
