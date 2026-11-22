/**
 * The `sift_kb` lifecycle tool.
 *
 * Retrieval itself stays on the `mcp__sift__*` tools that dsh-mcp-manager
 * already registers; this tool only manages a process the user cannot see
 * from the conversation.
 * @module lib/tool
 */

const text = value => [{ type: 'text', text: value }];

const ACTIONS = ['status', 'start', 'stop', 'logs'];

const formatStatus = status => {
  if (status.running) {
    const adopted = status.adopted ? '（由你或外部启动）' : '';
    return `知识库正在运行${adopted}：${status.url} ，MCP 端口 ${status.port}。`;
  }
  if (status.mode === 'starting') return '知识库正在启动，模型加载通常需要 10–30 秒。';
  const reason = status.lastError ? ` 上次错误：${status.lastError}` : '';
  return `知识库当前未运行。${reason}`.trim();
};

/**
 * Build the tool definition; the definition is registered as its own effect so
 * unloading the plugin withdraws it.
 */
export function createLifecycleTool({ service }) {
  return {
    name: 'sift_kb',
    description: 'Manage the local sift knowledge base process (start, stop an instance started by this plugin, status, logs). '
      + 'The knowledge base is off by default. Call status first; when the user asks to search the knowledge base '
      + 'and it is not running, call start, then tell the user the knowledge base was started before searching. '
      + 'Searching itself uses the mcp__sift__* tools.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'status | start | stop | logs' },
        lines: { type: 'integer', description: 'For logs: how many trailing lines to return (default 80).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 210000,
    isConcurrencySafe: args => args?.action === 'status' || args?.action === 'logs',
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          running: { type: 'boolean' },
          mode: { type: 'string' },
          pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          url: { type: 'string' },
          message: { type: 'string' },
          logTail: { type: 'array', items: { type: 'string' } },
        },
        required: ['action', 'running', 'mode', 'url', 'message'],
        additionalProperties: true,
      },
      render: (_args, value) => {
        const lines = [value.message];
        if (Array.isArray(value.logTail) && value.logTail.length > 0) lines.push('', ...value.logTail);
        return text(lines.join('\n'));
      },
    },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'status';
      if (!ACTIONS.includes(action)) throw new Error(`sift_kb: unknown action ${JSON.stringify(action)}`);

      if (action === 'status') {
        const status = await service.detect();
        return {
          action,
          running: status.running,
          mode: status.mode,
          pid: status.pid ?? null,
          url: status.url,
          message: formatStatus(status),
        };
      }

      if (action === 'start') {
        const before = await service.detect();
        const status = before.running ? before : await service.start();
        return {
          action,
          running: status.running,
          mode: status.mode,
          pid: status.pid ?? null,
          url: status.url,
          message: status.running
            ? `本地知识库已启动：${status.url} （已可检索）`
            : `知识库启动失败：${status.lastError ?? '未知错误'}`,
        };
      }

      if (action === 'stop') {
        const status = await service.stop();
        return {
          action,
          running: status.running,
          mode: status.mode,
          pid: null,
          url: status.url,
          message: '知识库已停止。',
        };
      }

      const lines = Math.max(1, Math.min(500, Number(args?.lines) || 80));
      const { lines: tail } = service.logs(lines);
      const status = await service.detect();
      return {
        action,
        running: status.running,
        mode: status.mode,
        pid: status.pid ?? null,
        url: status.url,
        message: `${status.logPath}（最后 ${tail.length} 行）`,
        logTail: tail,
      };
    },
  };
}
