/**
 * Process and port probing for the local sift server.
 *
 * A listening port is not proof that sift owns it, and a PID is not proof that
 * the process is still ours: both facts are checked before anything is killed.
 * @module lib/probe
 */
import net from 'node:net';
import path from 'node:path';
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
 * Resolve a single local listener for the configured address and port.
 * Fail closed if both an exact and a wildcard address could match different PIDs.
 */
export async function findListeningPid(host, port) {
  const output = await run('netstat', ['-ano', '-p', 'tcp']);
  return listeningPid(output, host, port);
}

export function listeningPid(output, host, port) {
  if (typeof output !== 'string') return null;
  const name = host.toLowerCase();
  const addresses = new Set();
  if (name === 'localhost' || name === '127.0.0.1') {
    addresses.add('127.0.0.1').add('0.0.0.0');
  }
  if (name === 'localhost' || name === '::1') {
    addresses.add('[::1]').add('[::]');
  }
  const pids = new Set();
  const suffix = `:${port}`;
  for (const line of output.split(/\r?\n/)) {
    const [, local, , state, pid] = line.trim().split(/\s+/);
    if (state !== 'LISTENING' || !local?.endsWith(suffix)) continue;
    if (!addresses.has(local.slice(0, -suffix.length))) continue;
    const number = Number(pid);
    if (Number.isInteger(number) && number > 0) pids.add(number);
  }
  return pids.size === 1 ? pids.values().next().value : null;
}

/** Read a process command line on Windows; null when unavailable. */
export async function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;
  const output = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 8000 });
  const text = output?.trim() ?? '';
  return text === '' ? null : text;
}

/** Match sift entry points, including the Windows Python virtualenv launcher. */
export function looksLikeSiftServe(commandLine) {
  if (typeof commandLine !== 'string') return false;
  const args = (commandLine.match(/"[^"]*"|[^\s"]+/g) ?? []).map(arg => arg.replace(/^"|"$/g, ''));
  const executable = path.win32.basename(args.shift() ?? '').toLowerCase();
  if (/^sift(?:\.exe)?$/.test(executable)) return args[0] === 'serve';
  if (!/^python(?:w|[\d.]*)?\.exe$/.test(executable)) return false;
  if (args[0] === '-m') return args[1] === 'sift' && args[2] === 'serve';
  const script = path.win32.basename(args[0] ?? '').toLowerCase();
  return /^sift(?:\.exe|-script\.py)?$/.test(script) && args[1] === 'serve';
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
