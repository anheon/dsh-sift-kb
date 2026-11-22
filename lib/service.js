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
  #pendingStop = null;
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
      void this.detect().catch(error => this.#fail(error));
    }
    this.#timer = setInterval(() => void this.tick(), this.#config.checkIntervalMs);
    this.#timer.unref?.();
    return () => {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = null;
    };
  }

  /** Refresh readiness without starting or stopping a process. */
  async detect() {
    if (this.#disposed || this.#pendingStart || this.#pendingStop) return this.status();
    const { host, port } = this.#config;
    const listening = await probePort(host, port);
    const ready = listening && await this.#isSiftReady();
    if (this.#disposed || this.#pendingStart || this.#pendingStop) return this.status();
    if (ready) return this.#markRunning();
    this.adopted = false;
    if (!this.child) this.startedAt = null;
    if (listening) return this.#fail(this.#unverifiedListener());
    if (this.mode === 'running') this.mode = this.child ? 'failed' : 'stopped';
    return this.status();
  }

  async #isSiftReady() {
    try {
      const data = await this.mcp.call('status', {}, { signal: AbortSignal.timeout(2500) });
      return Array.isArray(data?.collections);
    } catch {
      return false;
    }
  }

  #unverifiedListener() {
    const { host, port } = this.#config;
    return new Error(`a listener at ${host}:${port} did not respond as a ready sift MCP server`);
  }

  #markRunning() {
    this.mode = 'running';
    this.adopted = this.child === null;
    this.lastError = null;
    this.attempts = 0;
    return this.status();
  }

  /** Recheck readiness and optionally restart. */
  async tick() {
    if (this.#disposed || this.#pendingStart || this.#pendingStop) return;
    try {
      await this.detect();
      if (this.#disposed || this.#pendingStart || this.#pendingStop || this.running || this.child) return;
      if (this.#config.supervise && this.attempts < this.#config.maxRestartAttempts) {
        this.attempts += 1;
        this.#logger?.warn?.(`dsh-sift-kb: server is down, restart attempt ${this.attempts}`);
        await this.start();
      }
    } catch (error) {
      this.#logger?.warn?.(`dsh-sift-kb: supervision failed: ${error.message}`);
    }
  }

  ensureRunning() {
    return this.start();
  }

  start() {
    if (this.#pendingStart) return this.#pendingStart;
    if (this.#pendingStop) return this.#pendingStop.then(() => this.start());
    this.#pendingStart = this.#start()
      .catch(error => this.#fail(error))
      .finally(() => {
        this.#pendingStart = null;
      });
    return this.#pendingStart;
  }

  async #start() {
    if (this.#disposed) throw new Error('dsh-sift-kb is unloading');
    const listening = await probePort(this.#config.host, this.#config.port);
    if (listening) {
      if (!(await this.#isSiftReady())) throw this.#unverifiedListener();
      if (this.#disposed) throw new Error('dsh-sift-kb is unloading');
      return this.#markRunning();
    }
    if (this.#disposed) throw new Error('dsh-sift-kb is unloading');
    if (this.child) throw new Error('the owned sift process is still running without a ready server');
    this.mcp.reset();
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
      if (this.child !== child) return;
      this.child = null;
      this.#removeState();
      this.#fail(new Error(`sift could not start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.mcp.reset();
      this.#removeState();
      if (this.mode === 'running' || this.mode === 'starting') {
        this.mode = 'failed';
        this.lastError = `sift exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`;
        this.#logger?.warn?.(`dsh-sift-kb: ${this.lastError}`);
      }
    });
    child.unref();

    const deadline = Date.now() + this.#config.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child !== child || this.#disposed) {
        throw new Error(this.lastError ?? 'sift exited before it became ready');
      }
      if (await probePort(this.#config.host, this.#config.port, 600) && await this.#isSiftReady()) {
        if (this.child !== child || this.#disposed) {
          throw new Error(this.lastError ?? 'sift exited before it became ready');
        }
        this.#logger?.info?.(`dsh-sift-kb: sift is running on port ${this.#config.port} (pid ${child.pid})`);
        return this.#markRunning();
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (this.child === child) {
      if (!(await killTree(child.pid))) throw new Error('sift never became ready and its process could not be stopped');
      this.child = null;
      this.#removeState();
    }
    throw new Error(`sift did not become ready on port ${this.#config.port} within ${Math.round(this.#config.startupTimeoutMs / 1000)}s`);
  }

  /** External stopping requires configuration and explicit confirmation. */
  stop({ allowExternal = false } = {}) {
    if (this.#pendingStop) return this.#pendingStop;
    if (this.#pendingStart) throw new Error('wait for sift to finish starting before stopping it');
    this.#pendingStop = this.#stop(allowExternal).finally(() => {
      this.#pendingStop = null;
    });
    return this.#pendingStop;
  }

  async #stop(allowExternal) {
    if (this.#disposed) throw new Error('dsh-sift-kb is unloading');
    const config = this.#config;
    const previousMode = this.mode;
    this.mode = 'stopping';
    try {
      const child = this.child;
      if (child) {
        if (!(await killTree(child.pid))) throw new Error('the owned sift process could not be stopped');
        this.child = null;
      } else if (await probePort(config.host, config.port)) {
        if (!config.allowStopExternal || !allowExternal) {
          throw new Error('stopping an external sift instance requires enabling and confirming it in the panel');
        }
        if (!(await this.#isSiftReady())) throw this.#unverifiedListener();
        const pid = await findListeningPid(config.host, config.port);
        if (!pid) throw new Error('the sift listener could not be uniquely identified on this machine');
        if (!looksLikeSiftServe(await processCommandLine(pid)) || pid !== await findListeningPid(config.host, config.port)) {
          throw new Error('the listener is not a verified sift serve process');
        }
        if (!(await killTree(pid))) throw new Error('the external sift process could not be stopped');
      }
      const deadline = Date.now() + 15000;
      while (await probePort(config.host, config.port, 600)) {
        if (Date.now() >= deadline) throw new Error('the sift port is still occupied after stopping');
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
      this.mode = previousMode;
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
