/**
 * dsh-sift-kb: wires the user's local sift knowledge base into DeepSeek
 * Harness.
 *
 * The knowledge base is a Python process the user owns: it is off by default,
 * starts only on request, and stops with DSH when this plugin started it. The
 * panel talks to this half over same-origin HTTP routes; the agent talks to it
 * through the `sift_kb` tool and the `mcp__sift__*` tools.
 * @module dsh-sift-kb
 */
import { resolveConfig } from './lib/config.js';
import { diag } from './lib/diag.js';
import { ImportService } from './lib/imports.js';
import { registerRoutes } from './lib/routes.js';
import { SiftService } from './lib/service.js';
import { createLifecycleTool } from './lib/tool.js';

export const name = 'dsh-sift-kb';

/**
 * Guidance injected next to the other tool instructions. It stays deliberately
 * short: retrieval endpoints and schemas live in the MCP tool descriptions, and
 * collection names change as the user imports more material.
 */
export const DEFAULT_PROMPT = `## 本地知识库 sift

用户在本机运行 sift 知识库（MCP 端点 http://127.0.0.1:8765/mcp，浏览界面 http://127.0.0.1:8765/ui/），内容以课件与资料为主；集合名称与字段会随导入变化，先查再引用。

- 知识库默认关闭。检索前先调用 \`sift_kb\`（action: status）；未运行而用户需要检索时，用 action: start 启动，并在回答里明确告诉用户「本地知识库已启动」。
- 运行后使用 \`mcp__sift__*\`：\`status\` 列集合与字段；\`query\` 混合检索（最常用）；\`search\` 精确关键词；\`vsearch\` 语义检索；\`get\` 读文档全文（可限定行范围）；\`similar\`/\`links\`/\`mentions\` 看关联。
- 引用检索结果时给出文档 id（形如 \`collection/目录/文件.md\`）与行范围，不改写、不臆造未命中的内容。
- 若服务已在运行但 \`mcp__sift__\` 工具暂时不可用，等几秒重试一次；仍失败就如实报告，不要假装检索过。
- 用户要把新课件或 PDF 加入知识库时，走 \`courseware-to-sift\` 技能（preflight → plan → extract → build → import → verify），不要绕过它手工写 collection。`;

/**
 * Apply the plugin.
 * @param ctx - Cordis context.
 * @param raw - the bundle row's `config` object; empty is valid.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw);
  for (const warning of config.warnings) ctx.logger?.warn?.(`dsh-sift-kb: ${warning}`);
  if (!config.enabled) {
    ctx.logger?.info?.('dsh-sift-kb: disabled by configuration');
    return;
  }

  const service = new SiftService({ config, logger: ctx.logger });
  const imports = new ImportService({ config, ctx, logger: ctx.logger });
  void imports.prune().catch(() => {});

  // The timer and the child process are resources: both are released with the
  // plugin, and the child only when this plugin started it.
  ctx.effect(() => service.bind(), 'dsh-sift-kb: supervision');
  ctx.effect(() => () => service.dispose(), 'dsh-sift-kb: stop the owned sift server');

  ctx.inject(['webServer'], scoped => {
    scoped.effect(
      () => registerRoutes(scoped.webServer, { service, imports, config, ctx: scoped }),
      'dsh-sift-kb: panel routes',
    );
  });

  ctx.inject(['tools'], scoped => {
    scoped.effect(() => {
      try {
        const dispose = scoped.tools.register(createLifecycleTool({ service }));
        diag(config, 'tool sift_kb registered');
        return () => {
          diag(config, 'tool sift_kb withdrawn');
          if (typeof dispose === 'function') dispose();
        };
      } catch (error) {
        diag(config, `tool sift_kb registration failed: ${error?.message ?? String(error)}`);
        throw error;
      }
    }, 'dsh-sift-kb: sift_kb tool');
  });

  // Some profiles mount no system prompt service. Injecting keeps this quiet
  // instead of registering nothing and losing the guidance on cold start.
  ctx.inject(['systemPrompt'], scoped => {
    if (!config.promptEnabled) return;
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'sift-knowledge-base',
      order: 3050,
      text: config.promptText.trim() !== '' ? config.promptText : DEFAULT_PROMPT,
    }), 'dsh-sift-kb: knowledge-base guidance');
  });

  ctx.logger?.info?.('dsh-sift-kb: ready (knowledge base is off until started)');
}
