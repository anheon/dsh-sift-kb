/**
 * Client half of the sift knowledge-base plugin.
 *
 * A global sidebar entry (`sidebar.panellist` id `sift-kb`) whose `main` panel
 * is a native React surface: server status, search over the collections, a
 * Markdown reader, and the material screen that hands an import to a fresh
 * conversation. All data comes from the same-origin `/sift-kb/*` routes.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sift-kb',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'sift-kb';
    const POLL_MS = 5000;

    const api = path => new URL(path.replace(/^\/+/, ''), document.baseURI).pathname;

    async function request(path, init) {
      const response = await fetch(api(path), {
        ...init,
        headers: { accept: 'application/json', ...(init?.headers ?? {}) },
      });
      const text = await response.text();
      const body = text ? safeJson(text) : null;
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      return body;
    }

    function safeJson(text) {
      try { return JSON.parse(text); } catch { return { error: text }; }
    }

    const statusText = status => {
      if (!status) return { label: '状态未知', tone: 'muted' };
      if (status.mode === 'starting') return { label: '启动中…', tone: 'warn' };
      if (status.running) return { label: status.adopted ? '运行中（外部启动）' : '运行中', tone: 'ok' };
      if (status.mode === 'failed') return { label: '启动失败', tone: 'error' };
      return { label: '未运行', tone: 'muted' };
    };

    const toneColor = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      muted: 'var(--dsw-alias-label-tertiary)',
    };

    const styles = {
      root: {
        display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 24px 32px',
        height: '100%', overflow: 'auto', color: 'var(--dsw-alias-label-primary)',
      },
      header: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
      title: { fontSize: 18, fontWeight: 600, margin: 0 },
      badge: { fontSize: 12, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)' },
      spacer: { flex: 1 },
      button: {
        fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      primary: { borderColor: 'transparent', background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary-foreground)' },
      ghost: { background: 'transparent' },
      linkButton: {
        border: 'none', background: 'transparent', padding: 0, fontSize: 12, cursor: 'pointer',
        color: 'var(--dsw-alias-brand-primary)', textDecoration: 'underline', textUnderlineOffset: 2,
      },
      tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      tab: { fontSize: 13, padding: '8px 14px', cursor: 'pointer', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', color: 'var(--dsw-alias-label-secondary)' },
      tabActive: { color: 'var(--dsw-alias-label-primary)', borderBottomColor: 'var(--dsw-alias-brand-primary)' },
      form: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      input: {
        flex: '1 1 260px', minWidth: 220, fontSize: 13, padding: '7px 10px', borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      select: { fontSize: 13, padding: '7px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      result: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer' },
      resultTitle: { fontSize: 14, fontWeight: 600 },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'ui-monospace, Consolas, monospace' },
      excerpt: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap' },
      doc: { fontSize: 13, lineHeight: 1.75, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '16px 18px' },
      error: { fontSize: 12.5, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' },
      empty: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
      drop: { border: '1.5px dashed var(--dsw-alias-border-l3)', borderRadius: 12, padding: '26px 20px', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
      dropActive: { borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
      fileRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', fontSize: 12.5 },
      overlay: { position: 'fixed', inset: 0, background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 35%, transparent)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '32px 16px', zIndex: 1000 },
      card: { width: 'min(640px, 100%)', maxHeight: 'calc(100vh - 64px)', overflow: 'auto', outline: 'none', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 14, padding: 20, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 24px 60px color-mix(in srgb, var(--dsw-alias-label-primary) 25%, transparent)' },
      label: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      list: { margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' },
      highlight: { background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary-foreground)', borderRadius: 3, padding: '0 1px' },
    };

    function BookIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, 'data-dsh-panel-entry': PANEL_ID,
        style: { display: 'block' },
      },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z' }),
        h('path', { d: 'M4 5.5V21' }),
        h('path', { d: 'M8 7.5h7M8 11h7' }),
      );
    }

    const formatBytes = bytes => {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    };

    const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function highlight(text, terms) {
      const words = terms.map(term => term.trim()).filter(term => term.length > 1);
      if (words.length === 0) return text;
      const lower = new Set(words.map(word => word.toLowerCase()));
      const pattern = new RegExp(`(${words.map(escapeRegex).join('|')})`, 'gi');
      return String(text).split(pattern).map((part, index) => (
        lower.has(part.toLowerCase())
          ? h('mark', { key: index, style: styles.highlight }, part)
          : part
      ));
    }

    function excerptOf(text, terms, max = 320) {
      const source = String(text ?? '');
      if (source.length <= max) return source;
      const lower = source.toLowerCase();
      let at = -1;
      for (const term of terms) {
        const word = term.trim().toLowerCase();
        if (word.length < 2) continue;
        const found = lower.indexOf(word);
        if (found >= 0 && (at < 0 || found < at)) at = found;
      }
      const start = at < 0 ? 0 : Math.max(0, at - Math.floor(max / 3));
      return `${start > 0 ? '…' : ''}${source.slice(start, start + max)}${start + max < source.length ? '…' : ''}`;
    }

    /** Minimal Markdown: headings, lists, fences, quotes, tables, inline code. */
    function MarkdownView({ text }) {
      const blocks = [];
      const lines = String(text ?? '').split('\n');
      let index = 0;
      const inline = value => String(value).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, key) => {
        if (part.startsWith('**') && part.endsWith('**')) return h('strong', { key }, part.slice(2, -2));
        if (part.startsWith('`') && part.endsWith('`')) return h('code', { key, style: { fontFamily: 'ui-monospace, Consolas, monospace', background: 'var(--dsw-alias-bg-layer-2)', padding: '0 4px', borderRadius: 4 } }, part.slice(1, -1));
        return part;
      });

      while (index < lines.length) {
        const line = lines[index];
        if (line.startsWith('```')) {
          const code = [];
          index += 1;
          while (index < lines.length && !lines[index].startsWith('```')) { code.push(lines[index]); index += 1; }
          index += 1;
          blocks.push(h('pre', { key: blocks.length, style: { fontSize: 12, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, padding: 12, overflow: 'auto' } }, code.join('\n')));
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = heading[1].length;
          blocks.push(h(`h${Math.min(level + 1, 6)}`, { key: blocks.length, style: { fontSize: level === 1 ? 18 : level === 2 ? 16 : 14, margin: '14px 0 6px' } }, inline(heading[2])));
          index += 1;
          continue;
        }
        if (/^[-*+]\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^[-*+]\s+/.test(lines[index])) { items.push(lines[index].replace(/^[-*+]\s+/, '')); index += 1; }
          blocks.push(h('ul', { key: blocks.length, style: { margin: '4px 0', paddingLeft: 20, lineHeight: 1.8 } }, items.map((item, key) => h('li', { key }, inline(item)))));
          continue;
        }
        if (/^\|/.test(line)) {
          const rows = [];
          while (index < lines.length && /^\|/.test(lines[index])) { rows.push(lines[index]); index += 1; }
          blocks.push(h('pre', { key: blocks.length, style: { fontSize: 12, fontFamily: 'ui-monospace, Consolas, monospace', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, padding: 10, overflow: 'auto' } }, rows.join('\n')));
          continue;
        }
        if (line.trim() === '') { index += 1; continue; }
        const paragraph = [];
        while (index < lines.length && lines[index].trim() !== '' && !/^(#{1,6}\s|[-*+]\s|```|\|)/.test(lines[index])) {
          paragraph.push(lines[index]); index += 1;
        }
        blocks.push(h('p', { key: blocks.length, style: { margin: '6px 0', lineHeight: 1.8 } }, inline(paragraph.join('\n'))));
      }
      return h('div', { style: styles.doc }, blocks);
    }

    function useStatus() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState(null);
      const signature = React.useRef('');
      const refresh = React.useCallback(async () => {
        try {
          const next = await request('/sift-kb/status');
          const current = JSON.stringify([next?.mode, next?.running, next?.pid, next?.adopted, next?.lastError, next?.attempts]);
          if (current !== signature.current) {
            signature.current = current;
            setStatus(next);
          }
          setError(null);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      }, []);
      React.useEffect(() => {
        let alive = true;
        const tick = () => { if (alive && document.visibilityState !== 'hidden') void refresh(); };
        void refresh();
        const timer = setInterval(tick, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [refresh]);
      return { status, error, refresh };
    }

    function StatusBar({ status, error, busy, onStart, onStop, onLogs }) {
      const tone = statusText(status);
      return h('div', { style: styles.header },
        h('h2', { style: styles.title }, '本地知识库'),
        h('span', { style: { ...styles.badge, color: toneColor[tone.tone], borderColor: toneColor[tone.tone] } }, tone.label),
        h('div', { style: styles.spacer }),
        status ? h('button', { type: 'button', style: styles.button, onClick: onLogs }, '日志') : null,
        status && status.running ? h('a', {
          style: { ...styles.button, textDecoration: 'none' },
          href: status.url ?? `http://127.0.0.1:${status.port}/ui/`, target: '_blank', rel: 'noreferrer',
        }, '浏览界面') : null,
        status && !status.running && !status.pid && !['starting', 'stopping'].includes(status.mode)
          ? h('button', { type: 'button', style: { ...styles.button, ...styles.primary, opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: onStart }, busy ? '启动中…' : '启动知识库')
          : null,
        status?.mode !== 'stopping' && (status?.pid || (status?.running && status.allowStopExternal))
          ? h('button', { type: 'button', style: { ...styles.button, opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: onStop }, busy ? '停止中…' : '停止')
          : null,
        error ? h('div', { style: { ...styles.error, flexBasis: '100%' } }, error) : null,
        status?.lastError ? h('div', { style: { ...styles.error, flexBasis: '100%' } }, `上次错误：${status.lastError}`) : null,
      );
    }

    function SearchTab({ collections, disabled }) {
      const [query, setQuery] = React.useState('');
      const [kind, setKind] = React.useState('query');
      const [collection, setCollection] = React.useState('');
      const [result, setResult] = React.useState(null);
      const [doc, setDoc] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const submit = async event => {
        event.preventDefault();
        if (!query.trim() || disabled) return;
        setBusy(true);
        setError(null);
        setDoc(null);
        try {
          const params = new URLSearchParams({ kind, q: query.trim(), k: '8' });
          if (collection) params.set('collection', collection);
          setResult(await request(`/sift-kb/search?${params}`));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      };

      const open = async hit => {
        setBusy(true);
        setError(null);
        try {
          setDoc(await request(`/sift-kb/doc?id=${encodeURIComponent(hit.id)}${hit.lines ? `&lines=${encodeURIComponent(hit.lines)}` : ''}`));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      };

      if (doc) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: styles.form },
            h('button', { type: 'button', style: styles.button, onClick: () => setDoc(null) }, '← 返回结果'),
            h('span', { style: styles.meta }, `${doc.id}${doc.lines ? ` · 行 ${doc.lines}` : ''}`)),
          h(MarkdownView, { text: doc.text }),
        );
      }

      const terms = query.trim().split(/\s+/);

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('form', { style: styles.form, onSubmit: submit },
          h('input', {
            style: styles.input, value: query, placeholder: '检索课件与资料，例如：化学平衡 移动',
            onChange: event => setQuery(event.target.value),
          }),
          h('select', { style: styles.select, value: kind, onChange: event => setKind(event.target.value) },
            h('option', { value: 'query' }, '混合检索'),
            h('option', { value: 'search' }, '关键词'),
            h('option', { value: 'vsearch' }, '语义'),
          ),
          h('select', { style: styles.select, value: collection, onChange: event => setCollection(event.target.value) },
            h('option', { value: '' }, '全部集合'),
            collections.map(item => h('option', { key: item, value: item }, item)),
          ),
          h('button', { type: 'submit', style: { ...styles.button, ...styles.primary, opacity: busy || disabled ? 0.6 : 1 }, disabled: busy || disabled }, busy ? '检索中…' : '检索'),
        ),
        disabled ? h('div', { style: styles.empty }, '知识库未运行，启动后即可检索。') : null,
        error ? h('div', { style: styles.error }, error) : null,
        result
          ? (result.hits.length === 0
            ? h('div', { style: styles.empty }, '没有命中。换个说法、改用语义检索，或确认集合。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', { style: styles.meta }, `${result.kind} · ${result.count} 条结果`),
              result.hits.map(hit => h('div', {
                key: `${hit.id}#${hit.lines}`, style: styles.result, onClick: () => void open(hit),
              },
                h('div', { style: styles.resultTitle }, hit.title || hit.id),
                h('div', { style: styles.meta }, `${hit.id}${hit.lines ? ` · 行 ${hit.lines}` : ''} · ${Number(hit.score).toFixed(3)}`),
                h('div', { style: styles.excerpt }, highlight(excerptOf(hit.text ?? '', terms), terms)),
              )),
            ))
          : h('div', { style: styles.empty }, '输入问题或关键词开始检索；结果来自本地 sift 索引。'),
      );
    }

    function OptionSelect({ label, value, options, onChange, disabled }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160 } },
        h('span', { style: styles.label }, label),
        h('select', { style: styles.select, value: value ?? '', disabled, onChange: event => onChange(event.target.value) },
          options.length === 0 ? h('option', { value: '' }, '（不可用）') : null,
          options.map(option => h('option', { key: option.value, value: option.value, title: option.description ?? '' }, option.label)),
        ),
      );
    }

    function ConfirmCard({ plan, presets, models, collections, collection, chapterTitle, onCollection, onChapter, onCancel, onConfirm, busy, error, catalogWarning }) {
      const modeOptions = (presets?.modes ?? []).map(mode => ({
        value: mode.id ?? mode.name ?? mode.preset ?? String(mode),
        label: `${mode.name ?? mode.id ?? mode.preset ?? String(mode)}${mode.default ? '（默认）' : ''}`,
        description: mode.description,
      }));
      const modelGroups = models?.groups ?? [];
      const modelOptions = modelGroups.flatMap(group => group.models.map(model => ({
        value: `${group.id}::${model.id}`,
        label: `${group.name} / ${model.name}${models?.default?.provider === group.id && models?.default?.model === model.id ? '（默认）' : ''}`,
      })));
      const permissionOptions = (presets?.permissions?.options ?? []).map(option => ({
        value: option.name ?? option.id ?? option.preset ?? String(option),
        label: option.title ?? option.name ?? option.id ?? String(option),
        description: option.description,
      }));

      const [mode, setMode] = React.useState('');
      const [model, setModel] = React.useState('');
      const [permission, setPermission] = React.useState('');

      React.useEffect(() => {
        const fallbackMode = modeOptions.some(option => option.value === 'ptc') ? 'ptc' : (modeOptions[0]?.value ?? '');
        const defaultModel = models?.default ? `${models.default.provider}::${models.default.model}` : (modelOptions[0]?.value ?? '');
        const preferredPermission = permissionOptions.some(option => option.value === 'auto') ? 'auto' : (presets?.permissions?.defaultPreset ?? permissionOptions[0]?.value ?? '');
        setMode(fallbackMode);
        setModel(defaultModel);
        setPermission(preferredPermission);
      }, []);

      const cardRef = React.useRef(null);
      React.useEffect(() => {
        cardRef.current?.focus?.();
        const onKey = event => {
          if (event.key === 'Escape' && !busy) onCancel();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [busy, onCancel]);

      const submit = () => {
        const [provider, modelId] = model.split('::');
        void onConfirm({
          agentPreset: mode || undefined,
          model: provider && modelId ? { provider, model: modelId } : undefined,
          permission: permission || undefined,
          collection,
          chapterTitle,
        });
      };

      return h('div', { style: styles.overlay },
        h('div', {
          style: styles.card, ref: cardRef, tabIndex: -1,
          role: 'dialog', 'aria-modal': true, 'aria-label': '确认导入',
        },
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, '确认导入'),
          h('div', { style: styles.meta }, `作业 ${plan.job.id} · 共 ${plan.job.files.length} 个文件（${formatBytes(plan.job.totalBytes)}）`),
          h('div', { style: { ...styles.list, maxHeight: 160, overflow: 'auto' } },
            plan.job.files.map(file => h('div', { key: (file.path ?? '') + file.name, style: styles.fileRow },
              h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.name),
              h('span', { style: styles.meta }, file.kind === 'local' ? '本机文件' : '已暂存'),
              h('span', { style: styles.meta }, formatBytes(file.bytes)),
            ))),
          h('div', null,
            h('div', { style: styles.label }, '将在新对话中执行'),
            h('ol', { style: styles.list }, plan.steps.map(step => h('li', { key: step.id }, step.label))),
          ),
          h('div', { style: { ...styles.form, gap: 8 } },
            h('span', { style: styles.meta }, '集合'),
            h('select', { style: { ...styles.select, padding: '4px 6px' }, value: collection, disabled: busy, onChange: event => onCollection(event.target.value) },
              collections.length === 0 ? h('option', { value: collection }, collection) : null,
              collections.map(name => h('option', { key: name, value: name }, name)),
            ),
            h('span', { style: styles.meta }, '章节'),
            h('input', {
              style: { ...styles.input, flex: '1 1 140px', minWidth: 110, padding: '4px 8px' },
              value: chapterTitle, placeholder: '可选，例如 第二章 化学平衡',
              onChange: event => onChapter(event.target.value),
            }),
          ),
          h('div', { style: styles.meta }, `预计 ${plan.estimateMinutes} 分钟；不会修改或删除原始课件，导入成功后删除暂存副本。`),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(OptionSelect, { label: 'DSH 模式', value: mode, options: modeOptions, onChange: setMode, disabled: busy }),
            h(OptionSelect, { label: 'AI 模型', value: model, options: modelOptions, onChange: setModel, disabled: busy }),
            h(OptionSelect, { label: '权限程度', value: permission, options: permissionOptions, onChange: setPermission, disabled: busy }),
          ),
          permission === 'auto' || permission === 'danger-full-access'
            ? h('div', { style: { ...styles.meta, color: 'var(--dsw-alias-state-warn-primary)' } }, '该权限允许 Agent 自行修改文件；导入流程只会写新目录并在成功后删除暂存副本。')
            : null,
          catalogWarning ? h('div', { style: styles.meta }, catalogWarning) : null,
          error ? h('div', { style: styles.error }, error) : null,
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h('button', { type: 'button', style: styles.button, onClick: onCancel, disabled: busy }, '取消'),
            h('button', { type: 'button', style: { ...styles.button, ...styles.primary, opacity: busy ? 0.6 : 1 }, onClick: submit, disabled: busy }, busy ? '正在新开对话…' : '开始导入'),
          ),
        ),
      );
    }

    function ImportTab({ onOpenSession, onPickDirectory }) {
      const [jobId, setJobId] = React.useState(null);
      const [files, setFiles] = React.useState([]);
      const [collection, setCollection] = React.useState('');
      const [chapterTitle, setChapterTitle] = React.useState('');
      const [collections, setCollections] = React.useState([]);
      const [presets, setPresets] = React.useState(null);
      const [models, setModels] = React.useState(null);
      const [catalogWarning, setCatalogWarning] = React.useState(null);
      const [plan, setPlan] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [dragActive, setDragActive] = React.useState(false);
      const [result, setResult] = React.useState(null);
      const fileInput = React.useRef(null);
      const dragDepth = React.useRef(0);

      React.useEffect(() => {
        void request('/sift-kb/collections').then(body => {
          const names = (body?.collections ?? []).map(item => item.name).filter(Boolean);
          setCollections(names);
          setCollection(current => (names.includes(current) ? current : (names[0] ?? '')));
        }).catch(() => {});
      }, []);

      const upload = async list => {
        setBusy(true);
        setError(null);
        let currentJob = jobId;
        try {
          for (const file of list) {
            const url = new URL(api('/sift-kb/stage'), window.location.origin);
            if (currentJob) url.searchParams.set('job', currentJob);
            const response = await fetch(url.pathname + url.search, {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
              body: file,
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
            currentJob = body.jobId;
            setJobId(currentJob);
            setFiles(body.files ?? []);
          }
        } catch (cause) {
          if (currentJob) setJobId(currentJob);
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      };

      const addLocal = async path => {
        if (!path) return;
        setBusy(true);
        setError(null);
        try {
          const body = await request('/sift-kb/stage-local', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId, path }),
          });
          setJobId(body.jobId);
          setFiles(body.files ?? []);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      };

      const pickDirectory = async () => {
        try {
          const picked = await onPickDirectory?.();
          if (picked) await addLocal(picked);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      };

      const remove = async file => {
        setBusy(true);
        try {
          const body = await request('/sift-kb/stage/remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId, name: file.kind === 'upload' ? file.name : undefined, path: file.kind === 'local' ? file.path : undefined }),
          });
          setFiles(body.files ?? []);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      };

      const openPlan = async () => {
        setBusy(true);
        setError(null);
        try {
          const [planned, presetBody, modelBody] = await Promise.all([
            request('/sift-kb/import/plan', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jobId, collection, chapterTitle }),
            }),
            request('/sift-kb/presets').catch(() => null),
            request('/sift-kb/models').catch(() => null),
          ]);
          setPresets(presetBody);
          setModels(modelBody);
          setCatalogWarning(presetBody && modelBody ? null : '模式/模型目录暂不可用，将使用服务端默认值。');
          setPlan(planned);
          setFiles(planned.job.files ?? files);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      };

      const confirm = async choice => {
        setBusy(true);
        setError(null);
        try {
          const changed = plan && (choice.collection !== plan.job.collection || (choice.chapterTitle ?? '') !== (plan.job.chapterTitle ?? ''));
          if (changed) {
            await request('/sift-kb/import/plan', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jobId, collection: choice.collection, chapterTitle: choice.chapterTitle }),
            });
          }
          const body = await request('/sift-kb/import/confirm', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId, ...choice }),
          });
          setPlan(null);
          setResult({ sessionId: body.sessionId, warnings: body.warnings ?? [] });
          setFiles([]);
          setJobId(null);
          onOpenSession?.(body.sessionId);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, position: 'relative' } },
        h('div', {
          style: { ...styles.drop, ...(dragActive ? styles.dropActive : {}) },
          onDragEnter: event => { event.preventDefault(); dragDepth.current += 1; setDragActive(true); },
          onDragOver: event => { event.preventDefault(); },
          onDragLeave: () => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragActive(false);
          },
          onDrop: event => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragActive(false);
            const dropped = event.dataTransfer?.files ? [...event.dataTransfer.files] : [];
            if (dropped.length) void upload(dropped);
            else setError('没有识别到文件；整个文件夹请用「选择文件夹」。');
          },
        },
          h('div', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '把文件拖到这里'),
          h('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, '支持 pptx / pdf / png / jpg；整章目录用「选择文件夹」。'),
          h('div', { style: { display: 'flex', gap: 16, marginTop: 10, justifyContent: 'center', flexWrap: 'wrap' } },
            h('button', { type: 'button', style: styles.linkButton, onClick: () => fileInput.current?.click() }, '选择文件'),
            h('button', { type: 'button', style: styles.linkButton, onClick: () => void pickDirectory() }, '选择文件夹'),
            h('input', {
              ref: fileInput, type: 'file', multiple: true, style: { display: 'none' },
              accept: '.pptx,.pdf,.png,.jpg,.jpeg',
              onChange: event => { if (event.target.files?.length) void upload([...event.target.files]); event.target.value = ''; },
            }),
          ),
          h('form', {
            style: { ...styles.form, marginTop: 10 },
            onSubmit: event => { event.preventDefault(); void addLocal(event.target.elements.path.value); },
          },
            h('input', { name: 'path', style: { ...styles.input, padding: '5px 9px', minWidth: 180 }, placeholder: '粘贴资料路径，例如 D:\\courseware\\chapter2.pdf 或目录' }),
            h('button', { type: 'submit', style: { ...styles.button, padding: '5px 10px' } }, '添加'),
          ),
        ),
        files.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('div', { style: styles.label }, `待导入 ${files.length} 个文件`),
              h('span', { style: styles.spacer }),
              h('button', {
                type: 'button',
                style: { ...styles.button, ...styles.primary, padding: '5px 10px', opacity: busy || !collection ? 0.6 : 1 },
                disabled: busy || !collection,
                onClick: () => void openPlan(),
              }, busy ? '准备中…' : '添加到知识库'),
            ),
            !collection ? h('div', { style: styles.meta }, '集合还没加载完成，稍等一下再试。') : null,
            files.map(file => h('div', { key: (file.path ?? '') + file.name, style: styles.fileRow },
              h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.name),
              h('span', { style: styles.meta }, file.kind === 'local' ? file.path : formatBytes(file.bytes)),
              h('button', { type: 'button', style: { ...styles.button, ...styles.ghost, padding: '2px 8px', opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: () => void remove(file) }, '移除'),
            )),
          )
          : null,
        error ? h('div', { style: styles.error }, error) : null,
        result
          ? h('div', { style: { ...styles.fileRow, borderColor: 'var(--dsw-alias-state-success-primary)' } },
            h('span', { style: { flex: 1 } }, `已在新对话中开始导入（会话 ${result.sessionId.slice(0, 8)}…）。切换到该对话可查看进度。`))
          : null,
        plan ? h(ConfirmCard, {
          plan, presets, models, collections, collection, chapterTitle,
          onCollection: setCollection,
          onChapter: setChapterTitle,
          onCancel: () => setPlan(null),
          onConfirm: choice => void confirm(choice),
          busy, error, catalogWarning,
        }) : null,
      );
    }

    function Panel({ services }) {
      const { status, error, refresh } = useStatus();
      const [tab, setTab] = React.useState('search');
      const [collections, setCollections] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [actionError, setActionError] = React.useState(null);
      const [logs, setLogs] = React.useState(null);

      const running = Boolean(status?.running);

      React.useEffect(() => {
        if (!running) return undefined;
        let alive = true;
        void request('/sift-kb/collections').then(body => {
          if (!alive) return;
          setCollections((body?.collections ?? []).map(item => item.name).filter(Boolean));
        }).catch(() => {});
        return () => { alive = false; };
      }, [running]);

      const transition = async action => {
        const allowExternal = action === 'stop' && status?.adopted === true;
        if (allowExternal && (!status.allowStopExternal || !window.confirm('停止由外部启动的 sift 服务？'))) return;
        setBusy(true);
        setActionError(null);
        try {
          await request(`/sift-kb/${action}`, {
            method: 'POST',
            ...(allowExternal ? { body: JSON.stringify({ allowExternal }) } : {}),
          });
          await refresh();
        } catch (cause) {
          setActionError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      };

      const openSession = sessionId => {
        try {
          services.uiWorkspace?.openSession?.(sessionId);
          services.layout?.selectPanel?.(null);
        } catch (cause) {
          setActionError(String(cause?.message ?? cause));
        }
      };

      const toggleLogs = async () => {
        if (logs) { setLogs(null); return; }
        try {
          const body = await request('/sift-kb/logs?lines=40');
          setLogs(body?.lines ?? []);
        } catch (cause) {
          setActionError(String(cause?.message ?? cause));
        }
      };

      const tabStyle = active => ({ ...styles.tab, ...(active ? styles.tabActive : {}) });

      return h('div', { style: styles.root },
        h(StatusBar, {
          status, error: actionError ?? error, busy,
          onStart: () => void transition('start'),
          onStop: () => void transition('stop'),
          onLogs: () => void toggleLogs(),
        }),
        logs
          ? h('pre', {
            style: {
              margin: 0, fontSize: 11.5, lineHeight: 1.6, maxHeight: 200, overflow: 'auto',
              background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 10, padding: '10px 12px', whiteSpace: 'pre-wrap',
              fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--dsw-alias-label-secondary)',
            },
          }, logs.length ? logs.map((line, index) => h('div', { key: index }, line)) : '（日志为空）')
          : null,
        h('div', { style: styles.tabs },
          h('button', { type: 'button', style: tabStyle(tab === 'search'), onClick: () => setTab('search') }, '检索'),
          h('button', { type: 'button', style: tabStyle(tab === 'import'), onClick: () => setTab('import') }, '资料添加'),
        ),
        h('div', { style: { display: tab === 'search' ? 'flex' : 'none', flexDirection: 'column', gap: 12 } },
          h(SearchTab, { collections, disabled: !running }),
        ),
        h('div', { style: { display: tab === 'import' ? 'flex' : 'none', flexDirection: 'column' } },
          h(ImportTab, { onOpenSession: openSession, onPickDirectory: () => services.uiWorkspace?.pickDirectory?.() }),
        ),
      );
    }

    function EntryIcon({ size, active }) {
      return h('span', { style: { display: 'inline-flex', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' } }, h(BookIcon, { size: size ?? 16 }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const services = {
          get uiWorkspace() { try { return ctx.get('uiWorkspace'); } catch { return null; } },
          get layout() { try { return ctx.get('layout'); } catch { return null; } },
        };
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => '知识库',
        }, EntryIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, () => h(Panel, { services })));
      },
    };
  },
});
