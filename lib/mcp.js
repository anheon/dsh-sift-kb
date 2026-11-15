/**
 * A minimal MCP client for the streamable-HTTP transport used by `sift serve`.
 *
 * dsh-mcp-manager exposes no way to call an already-registered server, so the
 * UI proxy speaks the protocol itself: initialize once, keep the session id the
 * server returns, then issue `tools/call` requests.
 * @module lib/mcp
 */

/** Collect JSON payloads out of an SSE response body. */
export function parseSse(text) {
  const messages = [];
  let data = [];
  const flush = () => {
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    try {
      messages.push(JSON.parse(payload));
    } catch {
      // A non-JSON data line is not part of the JSON-RPC conversation.
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') {
      flush();
      continue;
    }
    if (raw.startsWith('data:')) data.push(raw.slice(5).replace(/^ /, ''));
  }
  flush();
  return messages;
}

/** Text of a tool result's content blocks. */
export function resultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.filter(block => block && block.type === 'text').map(block => block.text).join('\n');
}

/**
 * Reduce a `tools/call` result to its useful payload.
 *
 * sift returns both a text block and `structuredContent`; the structured form
 * is already JSON, so parsing the text is only a fallback.
 */
export function unwrapToolResult(result) {
  if (result?.isError) throw new Error(resultText(result) || 'sift tool failed');
  if (result?.structuredContent && 'result' in result.structuredContent) return result.structuredContent.result;
  const text = resultText(result);
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const isJsonRpcError = message => message && typeof message === 'object' && 'error' in message && message.error;

export class McpHttpClient {
  #sessionId = null;
  #initialized = false;
  #nextId = 1;

  constructor({ url, timeoutMs = 20000, logger } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  get connected() {
    return this.#initialized;
  }

  #headers(sessionId, extra) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extra,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    return headers;
  }

  async #post(payload, { sessionId, timeoutMs, signal } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.#headers(sessionId),
      body: JSON.stringify(payload),
      signal: combined,
    });
    const text = await response.text();
    return {
      status: response.status,
      sessionId: response.headers.get('mcp-session-id'),
      contentType: response.headers.get('content-type') ?? '',
      text,
    };
  }

  #message(payload, response) {
    if (response.text.trim() === '') return null;
    if (response.contentType.includes('text/event-stream')) {
      const messages = parseSse(response.text);
      return messages.find(message => message && message.id === payload.id) ?? messages.at(-1) ?? null;
    }
    try {
      return JSON.parse(response.text);
    } catch {
      throw new Error(`sift returned a non-JSON body (HTTP ${response.status})`);
    }
  }

  /** Open a session and send the required initialized notification. */
  async ensure({ signal, timeoutMs } = {}) {
    if (this.#initialized) return;
    const payload = {
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-sift-kb', version: '1.1.0' },
      },
    };
    const response = await this.#post(payload, { signal, timeoutMs });
    if (response.status !== 200) throw new Error(`sift initialize failed with HTTP ${response.status}`);
    const message = this.#message(payload, response);
    if (isJsonRpcError(message)) throw new Error(message.error.message || 'sift initialize failed');
    this.#sessionId = response.sessionId ?? this.#sessionId;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { sessionId: this.#sessionId, signal, timeoutMs });
    this.#initialized = true;
  }

  /** Reset the session so the next call performs a fresh handshake. */
  reset() {
    this.#sessionId = null;
    this.#initialized = false;
  }

  /** Call one sift tool and return its unwrapped payload. */
  async call(name, args = {}, { signal, timeoutMs } = {}) {
    const run = async () => {
      await this.ensure({ signal, timeoutMs });
      const payload = {
        jsonrpc: '2.0',
        id: this.#nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      };
      const response = await this.#post(payload, { sessionId: this.#sessionId, signal, timeoutMs });
      if (response.status >= 400) throw new Error(`sift tool ${name} failed with HTTP ${response.status}`);
      const message = this.#message(payload, response);
      if (isJsonRpcError(message)) throw new Error(message.error.message || `sift tool ${name} failed`);
      return unwrapToolResult(message?.result);
    };
    try {
      return await run();
    } catch (error) {
      // A stale session id is the one retryable failure: it often means the
      // server restarted underneath us.
      const message = String(error?.message ?? error);
      if (!/HTTP 400|HTTP 404|session|ECONNREFUSED|fetch failed/i.test(message)) throw error;
      this.reset();
      return await run();
    }
  }
}
