# dsh-sift-kb

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

把本机 [sift](https://pypi.org/project/sift-rag/) 知识库接进 DeepSeek Harness（DSH）的插件：左侧栏一个「知识库」面板，加上课件/PDF 导入流程和给 Agent 的检索通道。

- 平台：Windows 10/11（进程探测与结束依赖 netstat、PowerShell、taskkill）
- 兼容：DSH `>=0.2.0 <0.3.0`，Node 22+
- 本插件不包含 sift，也不复制你的资料；它负责进程、面板和导入入口

![面板示意图](docs/preview.svg)

## 功能

1. **默认关闭**：DSH 启动时不拉起服务；面板点「启动知识库」或 Agent 调 `sift_kb` 才启动。
2. **知识库面板**（侧栏 `sift-kb`）：
   - 检索：混合 / 关键词 / 语义三种模式，按集合过滤，命中词高亮，点开看全文和行号。
   - 阅读：Markdown 渲染（标题、列表、代码块、表格、行内代码），可限定行范围。
   - 添加资料：拖文件、选文件、选文件夹、粘贴本机路径；确认集合与章节后，选模式 / 模型 / 权限。
   - 状态：运行中 / 外部启动 / 启动中 / 失败 / 未运行，附启动、停止、打开浏览界面、看日志。
3. **导入流程**：确认后新建一个会话，把 `courseware-to-sift` 技能的六步任务交给 Agent；源文件只读，暂存文件在导入成功后删除。
4. **Agent 通道**：`sift_kb` 工具（`status` / `start` / `stop` / `logs`）；服务运行后可调用 `mcp__sift__*` 检索。
5. **生命周期**：只结束自己启动的实例；`supervise` 可选崩溃重启；`autoStartOnLaunch` 默认关。

## 安装前

### 1. sift

sift 是独立的 Python 工具（Python >= 3.11）。插件默认找 `D:\sift-venv\Scripts\sift.exe`，所以推荐这样装：

```bat
py -3.11 -m venv D:\sift-venv
D:\sift-venv\Scripts\pip install sift-rag
D:\sift-venv\Scripts\sift.exe --version
```

用 sift 自己的命令建好集合（例如 `sift add <资料目录>`），插件只负责检索和导入。sift 装在别处时，改下面的 `exePath` / `cwd` 即可。

### 2. 可选：注册 sift MCP

要让 Agent 直接使用 `mcp__sift__*`，在 DSH 的 MCP 管理器里加一个 HTTP 服务：

```yaml
- id: mcp-manager
  config:
    servers:
      sift:
        transport: streamable-http
        url: http://127.0.0.1:8765/mcp
```

> profile patch 的 `config` 是整体替换：如果 `mcp-manager` 里已有别的 server，请把它们一起写进 `servers`。

面板和 `sift_kb` 工具不依赖 MCP，只有 `mcp__sift__*` 需要。加完 MCP 配置后重启 DSH 或重载插件。

## 安装

### 从 GitHub 安装

1. 打开 DSH 侧栏「插件」页，点「添加插件」。
2. 粘贴本仓库的 Git 地址（GitHub 页面 **Code → HTTPS**，或 `git+https://` 开头的地址）。
3. 安装完成后点「立即启用」，按提示重载。

仓库里的 `index.js` 就是运行入口，不需要构建。

命令行等价写法（把 `<owner>` 换成仓库所有者）：

```bat
dsh plugin --profile desktop add github:<owner>/dsh-sift-kb
```

### 本地开发

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

## 配置

在 profile 的 `cordis.patch.yml` 里按 `id: sift-kb` 覆盖。只写要改的字段即可，其余回落到 `lib/config.js` 的 `DEFAULTS`：

```yaml
- id: sift-kb
  config:
    exePath: 'C:\sift\Scripts\sift.exe'
    cwd: 'C:\sift'
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | false 时插件行为关闭（bundle 仍加载） |
| `host` / `port` | `127.0.0.1` / `8765` | 服务地址与端口 |
| `exePath` | `D:\sift-venv\Scripts\sift.exe` | sift 可执行文件 |
| `cwd` | `D:\sift-venv` | 启动工作目录 |
| `siftHome` | `%USERPROFILE%\.sift` | `SIFT_HOME` |
| `logPath` | `%LOCALAPPDATA%\dsh-sift-kb\logs\sift-serve.log` | 服务日志（自动轮转） |
| `statePath` | `%LOCALAPPDATA%\dsh-sift-kb\state.json` | 自启实例的 PID 记录 |
| `args` | `['serve', '--host', host, '--port', port]` | 覆盖启动参数 |
| `autoStartOnLaunch` | `false` | DSH 启动时是否自动拉起 |
| `supervise` | `false` | 是否周期巡检并在崩溃后重启 |
| `stopOnDshExit` | `true` | DSH 退出/插件卸载时是否结束自启实例 |
| `allowStopExternal` | `true` | 面板「停止」是否允许停外部启动的实例 |
| `maxRestartAttempts` | `3` | 巡检重启的连续失败上限 |
| `startupTimeoutMs` | `180000` | 等待端口就绪上限 |
| `checkIntervalMs` | `15000` | 巡检间隔 |
| `logMaxBytes` / `logKeep` | `5 MiB` / `2` | 日志轮转 |
| `promptEnabled` / `promptText` | `true` / 内置中文指引 | 是否注入系统提示段 |
| `mcpTimeoutMs` | `20000` | MCP 请求超时 |
| `inboxPath` | `%LOCALAPPDATA%\dsh-sift-kb\inbox` | 暂存目录（导入成功后删除） |
| `importsPath` | `%LOCALAPPDATA%\dsh-sift-kb\imports` | 导入作业记录 |
| `maxDropBytes` | `200 MiB` | 单次上传上限 |
| `importFileTypes` | `pptx/pdf/png/jpg/jpeg` | 允许的资料类型 |

路径里的 `%VAR%`、`${VAR}`、`$VAR` 都会展开。

## HTTP 路由

同源校验后挂在 DSH Web 端口上：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/sift-kb/health` | 存活与模式 |
| GET | `/sift-kb/status` | 完整状态 |
| POST | `/sift-kb/start` / `/sift-kb/stop` | 启动 / 停止 |
| GET | `/sift-kb/logs?lines=` | 服务日志尾部 |
| GET | `/sift-kb/collections` | 集合、文档数、字段 |
| GET | `/sift-kb/search?kind=&q=&collection=&k=&path=` | 检索（kind 为 query / search / vsearch） |
| GET | `/sift-kb/doc?id=&lines=` | 文档全文 |
| POST | `/sift-kb/stage` | 原始字节暂存（头 `x-file-name`） |
| POST | `/sift-kb/stage-local` | 登记本机路径（不复制） |
| POST | `/sift-kb/stage/remove` | 从作业移除文件 |
| GET | `/sift-kb/imports` / `/sift-kb/import?jobId=` | 作业列表 / 详情 |
| POST | `/sift-kb/import/plan` | 生成导入计划 |
| POST | `/sift-kb/import/confirm` | 建会话并交给 Agent |
| POST | `/sift-kb/import/discard` | 丢弃作业与暂存 |
| GET | `/sift-kb/models` / `/sift-kb/presets` | 模型目录 / 模式与权限目录 |

## 限制

- 浏览器拖拽拿不到文件夹里的文件，整章目录请用「选择文件夹」。
- 服务首次加载向量模型约 10–30 秒，这段时间 `/ui/` 与 MCP 都不可用。
- 面板是原生 React，不嵌入 sift 的 `/ui/`；需要完整界面时用状态区的「浏览界面」。
- 导入依赖可用的 `courseware-to-sift` 技能；没有它时只能手工处理资料。
- 如果工具是会话中途才注册的，`auto` 权限下的自动审查可能因为「工具 schema 快照过期」拒绝调用；开一个新会话即可。
- 只负责守护与检索；集合的切分与索引质量由 sift / `courseware-to-sift` 决定。
- 只在 Windows 上测试。

## 开发

```bat
node --check index.js
node --check client.js
node --test test/config.test.mjs test/mcp.test.mjs test/routes.test.mjs test/imports.test.mjs
```

`npm test` 等价。测试需要 Node 22+。改完在插件页禁用再启用，Host 与 Client 会一起重载。

目录：

```text
index.js            Host 入口：配置、服务、路由、工具、系统提示
client.js           面板（React）
lib/config.js       默认值与校验
lib/service.js      sift 进程生命周期
lib/imports.js      导入作业与暂存
lib/routes.js       HTTP 路由
lib/tool.js         sift_kb 工具
cordis.patch.yml    bundle 的 patch 层
locale/             插件标题与描述
docs/               详细说明与示意图
```

## 隐私

- 只与本机 `127.0.0.1` 上的 sift 通信，不发送遥测。
- 导入时资料通过 DSH 会话处理，模型服务由你的 DSH 配置决定。
- 安装插件等于在本机运行它的代码；只从可信来源安装。

## License

[MIT](LICENSE)
