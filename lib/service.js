/**
 * Lifecycle of the local `sift serve` process.
 *
 * The knowledge base is off by default and belongs to the user: this service
 * starts it on request, adopts a server it did not start, refuses to kill a
 * port that is not sift, and only stops what it owns when DSH goes away.
 * @module lib/service
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { childEnv } from './config.js';
import { ensureDir, openLogFd, rotateIfNeeded, tailFile } from './log.js';
import { McpHttpClient } from './mcp.js';
import { findListeningPid, killTree, looksLikeSiftServe, probePort, processCommandLine } from './probe.js';

const MODES = new Set(['stopped', 'starting', 'running', 'stopping', 'failed']);

export class SiftService {
  #config;
  #logger;
  #timer = null;
  #pendingStart = null;
  #disposed = false;

  child = null;
  mode = 'stopped';
  adopted = false;
  startedAt = null;
  lastError = null;
  attempts = 0;
  mcp;

  constructor({ config, logger } = {}) {
    this.#config = config;
    this.#logger = logger;
    this.mcp = new McpHttpClient({ url: config.mcpUrl ?? `http://${config.host}:${config.port}/mcp`, timeoutMs: config.mcpTimeoutMs, logger });
  }

  get config() {
    return this.#config;
  }

  get running() {
    return this.mode === 'running';
  }

  get mcpUrl() {
    return `http://${this.#config.host}:${this.#config.port}/mcp`;
  }

  get uiUrl() {
    return `http://${this.#config.host}:${this.#config.port}/ui/`;
  }

  /** Snapshot safe to hand to a client. */
  status(extra = {}) {
    const pid = this.child?.pid ?? extra.pid ?? null;
    return {
      mode: MODES.has(this.mode) ? this.mode : 'failed',
      running: this.mode === 'running',
      pid: pid ?? null,
      adopted: this.adopted,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
      url: this.uiUrl,
      mcpUrl: this.mcpUrl,
      port: this.#config.port,
      host: this.#config.host,
      logPath: this.#config.logPath,
      lastError: this.lastError,
      attempts: this.attempts,
      autoStartOnLaunch: this.#config.autoStartOnLaunch,
      supervise: this.#config.supervise,
      stopOnDshExit: this.#config.stopOnDshExit,
      allowStopExternal: this.#config.allowStopExternal,
    };
  }

  /** Called once when the plugin loads; returns the timer cleanup. */
  bind() {
    if (this.#config.autoStartOnLaunch) {
      queueMicrotask(() => {
        void this.ensureRunning().catch(error => this.#fail(error));
      });
    } else {
      void this.detect();
    }
    this.#timer = setInterval(() => void this.tick(), this.#config.checkIntervalMs);
    this.#timer.unref?.();
    return () => {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = null;
    };
  }

  /** Refresh `mode` from the port without changing anything. */
  async detect() {
    const alive = await probePort(this.#config.host, this.#config.port);
    if (alive) {
      if (this.mode !== 'running') {
        this.mode = 'running';
        this.adopted = this.child === null;
      }
    } else if (this.mode === 'running' && this.child === null) {
      this.mode = 'stopped';
      this.startedAt = null;
    }
    return this.status();
  }

  /** Periodic supervision: only runs when `supervise` is on. */
  async tick() {
    if (this.#disposed) return;
    try {
      const alive = await probePort(this.#config.host, this.#config.port);
      if (!alive) {
        if (this.mode === 'running') {
          this.mode = this.child ? 'failed' : 'stopped';
          if (!this.child) this.startedAt = null;
        }
        if (this.#config.supervise && this.attempts < this.#config.maxRestartAttempts && this.mode !== 'starting') {
          this.attempts += 1;
          this.#logger?.warn?.(`dsh-sift-kb: server is down, restart attempt ${this.attempts}`);
          await this.start();
        }
        return;
      }
      if (this.mode !== 'running') {
        this.mode = 'running';
        this.adopted = this.child === null;
        if (this.child) this.adopted = false;
      }
    } catch (error) {
      this.#logger?.warn?.(`dsh-sift-kb: supervision failed: ${error.message}`);
    }
  }

  /** Start the server unless something already answers on the port. */
  async ensureRunning() {
    if (await probePort(this.#config.host, this.#config.port)) return this.detect();
    return this.start();
  }

  start() {
    if (this.#pendingStart) return this.#pendingStart;
    this.#pendingStart = this.#start()
      .catch(error => this.#fail(error))
      .finally(() => {
        this.#pendingStart = null;
      });
    return this.#pendingStart;
  }

  async #start() {
    if (this.#disposed) throw new Error('dsh-sift-kb is unloading');
    if (this.mode === 'running') return this.status();
    if (await probePort(this.#config.host, this.#config.port)) return this.detect();
    if (!fs.existsSync(this.#config.exePath)) {
      throw new Error(`sift executable not found: ${this.#config.exePath}`);
    }

    this.mode = 'starting';
    this.lastError = null;
    this.adopted = false;
    const { logPath, logMaxBytes, logKeep } = this.#config;
    rotateIfNeeded(logPath, logMaxBytes, logKeep, this.#logger);

    let fd;
    try {
      fd = openLogFd(logPath);
    } catch (error) {
      throw new Error(`cannot open the sift log ${logPath}: ${error.message}`);
    }

    const child = spawn(this.#config.exePath, this.#config.args, {
      cwd: this.#config.cwd,
      env: childEnv(this.#config),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    try {
      fs.closeSync(fd);
    } catch {
      // The child owns the descriptor now.
    }

    this.child = child;
    this.startedAt = Date.now();
    this.#writeState();

    child.once('error', error => {
      this.#fail(new Error(`sift could not start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.mode === 'running' || this.mode === 'starting') {
        this.mode = 'failed';
        this.lastError = `sift exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`;
      }
      this.#logger?.warn?.(`dsh-sift-kb: ${this.lastError}`);
    });
    child.unref();

    const deadline = Date.now() + this.#config.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await probePort(this.#config.host, this.#config.port, 600)) {
        this.mode = 'running';
        this.attempts = 0;
        this.#writeState();
        this.#logger?.info?.(`dsh-sift-kb: sift is running on port ${this.#config.port} (pid ${child.pid})`);
        return this.status();
      }
      if (this.child === null) throw new Error(this.lastError ?? 'sift exited before it started listening');
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    await killTree(child.pid);
    this.child = null;
    throw new Error(`sift did not listen on port ${this.#config.port} within ${Math.round(this.#config.startupTimeoutMs / 1000)}s`);
  }

  /** Stop the server: ours directly, a foreign one only after verifying it is sift. */
  async stop() {
    const config = this.#config;
    this.mode = 'stopping';
    try {
      if (this.child) {
        const pid = this.child.pid;
        await killTree(pid);
        this.child = null;
      } else if (await probePort(config.host, config.port)) {
        const pid = await findListeningPid(config.port);
        if (!pid) throw new Error(`port ${config.port} is in use but its process could not be identified`);
        const commandLine = await processCommandLine(pid);
        if (!looksLikeSiftServe(commandLine)) {
          throw new Error(`port ${config.port} belongs to another program, not sift: ${commandLine ?? 'unknown command line'}`);
        }
        if (!config.allowStopExternal) throw new Error('this sift server was started outside DSH and the configuration forbids stopping it');
        await killTree(pid);
      }
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (!(await probePort(config.host, config.port, 600))) break;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      this.mcp.reset();
      this.mode = 'stopped';
      this.adopted = false;
      this.startedAt = null;
      this.lastError = null;
      this.attempts = 0;
      this.#removeState();
      return this.status();
    } catch (error) {
      this.mode = this.child ? 'running' : (await probePort(config.host, config.port)) ? 'running' : 'stopped';
      this.#fail(error);
      throw error;
    }
  }

  /** Tail of the sift server log. */
  logs(lines = 120) {
    return { path: this.#config.logPath, lines: tailFile(this.#config.logPath, lines) };
  }

  /** Collections reported by the running server. */
  async collections({ signal } = {}) {
    if (!(await probePort(this.#config.host, this.#config.port, 600))) {
      throw new Error('the knowledge base is not running');
    }
    const data = await this.mcp.call('status', {}, { signal });
    return data;
  }

  /** Hybrid/semantic/keyword search through the MCP server. */
  async search({ kind = 'query', query, collection, k = 8, path: scope, signal } = {}) {
    const text = typeof query === 'string' ? query.trim() : '';
    if (text === '') throw new Error('query is required');
    const tool = kind === 'search' || kind === 'vsearch' || kind === 'query' ? kind : 'query';
    const args = { query: text, k: Math.max(1, Math.min(50, Number(k) || 8)) };
    if (typeof collection === 'string' && collection.trim() !== '') args.collection = collection.trim();
    if (typeof scope === 'string' && scope.trim() !== '') args.path = scope.trim();
    const result = await this.mcp.call(tool, args, { signal });
    const hits = Array.isArray(result) ? result : [];
    return { kind: tool, query: text, count: hits.length, hits };
  }

  /** One document's text, by id. */
  async document({ id, lines, signal } = {}) {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('id is required');
    const args = { id: id.trim() };
    if (typeof lines === 'string' && lines.trim() !== '') args.lines = lines.trim();
    const text = await this.mcp.call('get', args, { signal });
    return { id: args.id, lines: args.lines ?? null, text: typeof text === 'string' ? text : JSON.stringify(text) };
  }

  /** Stop only the server this plugin started. */
  async dispose() {
    this.#disposed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#config.stopOnDshExit && this.child) {
      try {
        await killTree(this.child.pid);
      } catch (error) {
        this.#logger?.warn?.(`dsh-sift-kb: could not stop sift: ${error.message}`);
      }
      this.child = null;
    }
    this.#removeState();
    this.mode = 'stopped';
  }

  #fail(error) {
    this.mode = 'failed';
    this.lastError = error?.message ?? String(error);
    this.#logger?.warn?.(`dsh-sift-kb: ${this.lastError}`);
    return this.status();
  }

  #writeState() {
    try {
      const file = this.#config.statePath;
      ensureDir(path.dirname(file));
      const state = {
        pid: this.child?.pid ?? null,
        port: this.#config.port,
        exePath: this.#config.exePath,
        startedAt: this.startedAt,
      };
      fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      this.#logger?.warn?.(`dsh-sift-kb: could not write ${this.#config.statePath}: ${error.message}`);
    }
  }

  #removeState() {
    try {
      fs.rmSync(this.#config.statePath, { force: true });
    } catch {
      // Ignore: a stale state file is harmless.
    }
  }
}
