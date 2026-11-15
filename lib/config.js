/**
 * Configuration for dsh-sift-kb.
 *
 * The plugin is distributed as a bundle, so its config arrives from
 * `cordis.patch.yml`. Everything here is optional: an empty `config: {}` row
 * has to work on a machine where sift lives in the documented location.
 * @module lib/config
 */

/** Defaults describe this machine, not a generic install. */
export const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 8765,
  exePath: 'D:\\sift-venv\\Scripts\\sift.exe',
  cwd: 'D:\\sift-venv',
  siftHome: '%USERPROFILE%\\.sift',
  logPath: '%LOCALAPPDATA%\\dsh-sift-kb\\logs\\sift-serve.log',
  statePath: '%LOCALAPPDATA%\\dsh-sift-kb\\state.json',
  /** Extra CLI arguments; the default is `serve --host <host> --port <port>`. */
  args: [],
  /** Never start on DSH launch: the knowledge base is opt-in. */
  autoStartOnLaunch: false,
  /** Do not resurrect a server this plugin did not start. */
  supervise: false,
  /** Kill the server we started when the plugin unloads or DSH exits. */
  stopOnDshExit: true,
  /** Let the UI stop a server the user started by hand (after a confirmation). */
  allowStopExternal: true,
  maxRestartAttempts: 3,
  startupTimeoutMs: 180000,
  checkIntervalMs: 15000,
  logMaxBytes: 5 * 1024 * 1024,
  logKeep: 2,
  promptEnabled: true,
  promptText: '',
  /** How long an MCP tool call may take before the UI proxy gives up. */
  mcpTimeoutMs: 20000,
  /** Where dropped files wait until the import conversation picks them up. */
  inboxPath: '%LOCALAPPDATA%/dsh-sift-kb/inbox',
  /** One JSON per import job, so a restart does not lose the hand-off. */
  importsPath: '%LOCALAPPDATA%/dsh-sift-kb/imports',
  /** A single dropped file larger than this is refused before it is written. */
  maxDropBytes: 200 * 1024 * 1024,
  /** Extensions the material screen accepts. */
  importFileTypes: ['pptx', 'pdf', 'png', 'jpg', 'jpeg'],
};

/** Expand `%VAR%` and `$VAR` forms without a shell. */
export function expandPath(value, env = process.env) {
  if (typeof value !== 'string' || value === '') return value;
  return value
    .replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole)
    .replace(/\$\{([^}]+)\}/g, (whole, name) => env[name] ?? whole)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => env[name] ?? whole);
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const positiveInt = (value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.floor(number);
  return rounded < min || rounded > max ? fallback : rounded;
};

/**
 * Validate and normalise the bundle row.
 *
 * A bad port is a typo worth failing on; a bad optional number falls back so a
 * half-edited row still loads with a log line instead of an unloadable bundle.
 * @param raw - the `config` object from `cordis.patch.yml`.
 * @param options - `{ env, warnings }` for tests.
 */
export function resolveConfig(raw = {}, options = {}) {
  const env = options.env ?? process.env;
  const warnings = options.warnings ?? [];
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};

  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (input[key] !== undefined) merged[key] = input[key];
  }
  // Older rows of this bundle used these names; keep them working.
  if (input.stopOnDispose !== undefined && input.stopOnDshExit === undefined) merged.stopOnDshExit = input.stopOnDispose;

  const port = positiveInt(merged.port, DEFAULTS.port, { min: 1, max: 65535 });
  if (port !== merged.port) warnings.push(`port ${JSON.stringify(merged.port)} is not a valid port, using ${port}`);

  const host = typeof merged.host === 'string' && merged.host.trim() !== '' ? merged.host.trim() : DEFAULTS.host;
  const args = Array.isArray(merged.args) && merged.args.length > 0 && merged.args.every(arg => typeof arg === 'string')
    ? [...merged.args]
    : ['serve', '--host', host, '--port', String(port)];

  return {
    enabled: bool(merged.enabled, true),
    host,
    port,
    exePath: expandPath(merged.exePath, env),
    cwd: expandPath(merged.cwd, env),
    siftHome: expandPath(merged.siftHome, env),
    logPath: expandPath(merged.logPath, env),
    statePath: expandPath(merged.statePath, env),
    args,
    autoStartOnLaunch: bool(merged.autoStartOnLaunch, false),
    supervise: bool(merged.supervise, false),
    stopOnDshExit: bool(merged.stopOnDshExit, true),
    allowStopExternal: bool(merged.allowStopExternal, true),
    maxRestartAttempts: positiveInt(merged.maxRestartAttempts, 3, { min: 0, max: 100 }),
    startupTimeoutMs: positiveInt(merged.startupTimeoutMs, 180000, { min: 1000, max: 1800000 }),
    checkIntervalMs: positiveInt(merged.checkIntervalMs, 15000, { min: 1000, max: 600000 }),
    logMaxBytes: positiveInt(merged.logMaxBytes, DEFAULTS.logMaxBytes, { min: 1024 }),
    logKeep: positiveInt(merged.logKeep, 2, { min: 0, max: 20 }),
    promptEnabled: bool(merged.promptEnabled, true),
    promptText: typeof merged.promptText === 'string' ? merged.promptText : '',
    mcpTimeoutMs: positiveInt(merged.mcpTimeoutMs, 20000, { min: 1000, max: 300000 }),
    inboxPath: expandPath(merged.inboxPath, env),
    importsPath: expandPath(merged.importsPath, env),
    maxDropBytes: positiveInt(merged.maxDropBytes, DEFAULTS.maxDropBytes, { min: 1024, max: 4 * 1024 * 1024 * 1024 }),
    importFileTypes: Array.isArray(merged.importFileTypes) && merged.importFileTypes.length > 0
      ? merged.importFileTypes.filter(type => typeof type === 'string').map(type => type.replace(/^\./, '').toLowerCase())
      : [...DEFAULTS.importFileTypes],
    warnings,
  };
}

/** Environment a child `sift serve` needs so it never reaches the network. */
export function childEnv(config, env = process.env) {
  return {
    ...env,
    SIFT_HOME: config.siftHome,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  };
}
