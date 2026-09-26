#!/usr/bin/env node
/**
 * thinking-fix-proxy
 * ------------------
 * A zero-dependency reverse proxy that sits in front of an Anthropic- or
 * OpenAI-compatible gateway (e.g. QuantumNous/new-api, AgentRouter) and works
 * around this error:
 *
 *   400 {"message":"The `content[].thinking` in the thinking mode must be
 *        passed back to the API. (request_id: ...)","type":"invalid_request_error"}
 *
 * Why it happens
 * --------------
 * When extended thinking / reasoning is enabled and the model uses a tool, the
 * upstream (Anthropic) requires every previous assistant turn containing a
 * tool_use / tool_call to also carry the thinking block(s) that produced it,
 * including the original signature. Gateways/translators often drop those
 * blocks from the conversation history, so the next call is rejected.
 *
 * What this proxy does
 * --------------------
 *   1. Forwards requests upstream unchanged (streaming too).
 *   2. Captures thinking blocks (Anthropic) / reasoning_content (OpenAI) seen
 *      in responses, keyed by tool_use / tool_call id.
 *   3. On the thinking error, retries with the missing blocks re-injected.
 *   4. If unrecoverable (e.g. proxy restarted), retries with thinking/
 *      reasoning disabled so the request still succeeds.
 *   5. Never gives up: on a thinking error, 5xx, or connect failure the
 *      attempt plan wraps around and retries forever. Only a definitive
 *      4xx that is not the thinking error is ever returned to the client.
 *
 * It speaks both dialects:
 *   - Anthropic Messages:  POST /v1/messages
 *   - OpenAI Chat:         POST /v1/chat/completions
 *
 * Config resolution order: env var > config.json > built-in default.
 * Default upstream is https://agentrouter.org (see config.json).
 */

import http from 'node:http';
import fs from 'node:fs';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadFileConfig() {
  const candidates = [
    process.env.CONFIG,
    new URL('./config.json', import.meta.url).pathname,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* try next */
    }
  }
  return {};
}
const fileConfig = loadFileConfig();

const pick = (envKey, fileKey, def) => {
  if (process.env[envKey] !== undefined && process.env[envKey] !== '') return process.env[envKey];
  if (fileConfig[fileKey] !== undefined) return fileConfig[fileKey];
  return def;
};
const asBool = (v) =>
  v === true || ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const PORT = parseInt(pick('PORT', 'port', '8787'), 10);
const HOST = pick('HOST', 'host', '127.0.0.1');
const UPSTREAM = String(pick('UPSTREAM', 'upstream', 'https://agentrouter.org')).replace(/\/+$/, '');
const UPSTREAM_API_KEY = pick('UPSTREAM_API_KEY', 'upstreamApiKey', '');
const FALLBACK_DISABLE_THINKING = asBool(pick('FALLBACK_DISABLE_THINKING', 'fallbackDisableThinking', true));
const DISABLE_THINKING = asBool(pick('DISABLE_THINKING', 'disableThinking', false));
const CACHE_SIZE = parseInt(pick('CACHE_SIZE', 'cacheSize', '5000'), 10);
const RETRY_ATTEMPTS = parseInt(pick('RETRY_ATTEMPTS', 'retryAttempts', '5'), 10);
const RETRY_DELAY_MS = parseInt(pick('RETRY_DELAY_MS', 'retryDelayMs', '400'), 10);
const LOG = asBool(pick('LOG', 'log', true));
const MAX_BODY = parseInt(pick('MAX_BODY', 'maxBody', String(64 * 1024 * 1024)), 10);

const log = (...args) => {
  if (LOG) console.log(new Date().toISOString(), ...args);
};

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ---------------------------------------------------------------------------
// Thinking cache: id -> array of thinking / redacted_thinking blocks (or
// { reasoning_content } for the OpenAI dialect). Small LRU.
// ---------------------------------------------------------------------------
class LRU {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }
  set(key, value) {
    if (!key) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
  get(key) {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  get size() {
    return this.map.size;
  }
}
const thinkingCache = new LRU(CACHE_SIZE);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const THINKING_ERROR_RE =
  /content\[\]\.thinking|thinking mode must be passed back|must be passed back to the api|reasoning_content.*must be passed back/i;

const isThinkingBlock = (b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking');

const OPENAI_REASONING_KEYS = ['reasoning_content', 'reasoning'];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function upstreamHeaders(req, bodyLength) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (
      ['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding', 'proxy-connection'].includes(key)
    )
      continue;
    headers[k] = v;
  }
  headers['accept-encoding'] = 'identity'; // uncompressed so we can inspect
  if (bodyLength != null) headers['content-length'] = String(bodyLength);
  if (UPSTREAM_API_KEY) {
    headers['x-api-key'] = UPSTREAM_API_KEY;
    headers['authorization'] = `Bearer ${UPSTREAM_API_KEY}`;
  }
  return headers;
}

function responseHeaders(upstream) {
  const out = {};
  for (const [k, v] of upstream.headers) {
    const key = k.toLowerCase();
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)) continue;
    out[key] = v;
  }
  return out;
}

function forwardBuffered(res, upstream, text) {
  const headers = responseHeaders(upstream);
  const buf = Buffer.from(text, 'utf8');
  headers['content-length'] = String(buf.length);
  res.writeHead(upstream.status, headers);
  res.end(buf);
}

// ---------------------------------------------------------------------------
// Dialect detection
// ---------------------------------------------------------------------------
function requestKind(path, body) {
  const p = String(path || '').split('?')[0];
  if (/\/chat\/completions\/?$/.test(p) || /\/completions\/?$/.test(p)) return 'openai';
  if (/\/messages\/?$/.test(p)) return 'anthropic';
  if (body && typeof body === 'object') {
    // Anthropic Messages requires max_tokens; OpenAI chat does not necessarily.
    const looksAnthropic =
      typeof body.max_tokens === 'number' &&
      (body.anthropic_version !== undefined ||
        Array.isArray(body.system) ||
        body.thinking !== undefined ||
        !('tools' in body));
    if (looksAnthropic && Array.isArray(body.messages)) return 'anthropic';
    if (Array.isArray(body.messages)) return 'openai';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Caching from responses
// ---------------------------------------------------------------------------
function cacheFromAnthropicContent(content) {
  if (!Array.isArray(content)) return;
  const thinkingBlocks = content.filter(isThinkingBlock);
  if (!thinkingBlocks.length) return;
  for (const block of content) {
    if (block && block.type === 'tool_use' && block.id) {
      thinkingCache.set(block.id, structuredClone(thinkingBlocks));
    }
  }
}

function cacheFromOpenAIMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const reasoning =
    typeof msg.reasoning_content === 'string'
      ? msg.reasoning_content
      : typeof msg.reasoning === 'string'
        ? msg.reasoning
        : '';
  if (!reasoning) return;
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const tc of toolCalls) {
    if (tc && tc.id) thinkingCache.set('openai:' + tc.id, [{ reasoning_content: reasoning }]);
  }
}

function cacheFromJsonResponse(obj) {
  if (!obj || typeof obj !== 'object') return;
  // Anthropic Messages response
  if (Array.isArray(obj.content)) cacheFromAnthropicContent(obj.content);
  // OpenAI Chat response
  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) if (choice) cacheFromOpenAIMessage(choice.message);
  }
}

// ---------------------------------------------------------------------------
// Combined SSE collector (Anthropic + OpenAI dialects)
// ---------------------------------------------------------------------------
class StreamCollector {
  constructor() {
    this.buf = '';
    this.blocks = new Map(); // Anthropic content blocks by index
    this.reasoning = ''; // OpenAI reasoning text
    this.toolCalls = new Map(); // OpenAI tool calls by index/id
  }
  feed(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.handleEvent(raw);
    }
  }
  handleEvent(raw) {
    let event = '';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const joined = dataLines.join('\n');
    if (joined === '[DONE]') return;
    let data;
    try {
      data = JSON.parse(joined);
    } catch {
      return;
    }
    this.anthropicEvent(data, event);
    this.openaiEvent(data);
  }
  anthropicEvent(data, event) {
    const type = data.type || event;
    if (type === 'content_block_start') {
      const b = data.content_block || {};
      this.blocks.set(data.index, {
        type: b.type,
        id: b.id,
        thinking: b.thinking || '',
        signature: b.signature || '',
        data: b.data || '',
      });
    } else if (type === 'content_block_delta') {
      const b = this.blocks.get(data.index);
      if (!b) return;
      const d = data.delta || {};
      if (d.type === 'thinking_delta') b.thinking += d.thinking || '';
      else if (d.type === 'signature_delta') b.signature += d.signature || '';
    }
  }
  openaiEvent(data) {
    if (!Array.isArray(data.choices)) return;
    for (const choice of data.choices) {
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === 'string') this.reasoning += delta.reasoning_content;
      if (typeof delta.reasoning === 'string') this.reasoning += delta.reasoning;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? tc.id ?? this.toolCalls.size;
          const cur = this.toolCalls.get(idx) || { id: '', name: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.name = tc.function.name;
          this.toolCalls.set(idx, cur);
        }
      }
      const msg = choice.message;
      if (msg) {
        if (typeof msg.reasoning_content === 'string') this.reasoning += msg.reasoning_content;
        if (typeof msg.reasoning === 'string') this.reasoning += msg.reasoning;
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (tc && tc.id) this.toolCalls.set(tc.id, { id: tc.id, name: tc.function?.name || '' });
          }
        }
      }
    }
  }
  anthropicContent() {
    return [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }
  commit() {
    cacheFromAnthropicContent(this.anthropicContent());
    if (this.reasoning) {
      for (const [, tc] of this.toolCalls) {
        if (tc && tc.id) thinkingCache.set('openai:' + tc.id, [{ reasoning_content: this.reasoning }]);
      }
    }
  }
}

async function streamAndCapture(upstream, res) {
  const headers = responseHeaders(upstream);
  res.writeHead(upstream.status, headers);

  const body = upstream.body;
  if (!body) {
    res.end();
    return;
  }

  let clientStream = body;
  let parseStream = null;
  if (typeof body.tee === 'function') {
    [clientStream, parseStream] = body.tee();
  }

  const nodeStream = Readable.fromWeb(clientStream);
  nodeStream.on('error', () => res.destroy());
  res.on('close', () => {
    try {
      nodeStream.destroy();
    } catch {
      /* ignore */
    }
  });
  nodeStream.pipe(res);

  if (parseStream) {
    const collector = new StreamCollector();
    const decoder = new TextDecoder();
    try {
      for await (const chunk of parseStream) collector.feed(decoder.decode(chunk, { stream: true }));
    } catch {
      /* stream aborted */
    }
    collector.commit();
  }
}

// ---------------------------------------------------------------------------
// Anthropic request repairs
// ---------------------------------------------------------------------------
function repairAnthropicRequest(body) {
  const out = structuredClone(body);
  let changed = false;

  for (const msg of out.messages) {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const toolIds = msg.content.filter((b) => b && b.type === 'tool_use' && b.id).map((b) => b.id);
    const thinkingBlocks = msg.content.filter(isThinkingBlock);

    if (thinkingBlocks.length) {
      for (const id of toolIds) thinkingCache.set(id, structuredClone(thinkingBlocks));
    }
    if (thinkingBlocks.length || !toolIds.length) continue;

    for (const id of toolIds) {
      const cached = thinkingCache.get(id);
      if (cached && cached.length) {
        const blocks = cached.filter((b) => b.reasoning_content === undefined);
        if (blocks.length) {
          msg.content = [...structuredClone(blocks), ...msg.content];
          changed = true;
          break;
        }
      }
    }
  }
  return { obj: out, changed };
}

/**
 * Force the request out of "thinking mode".
 *
 * Deleting the `thinking` field is NOT enough. Models such as claude-opus-5
 * think by default, so a request without `thinking` is still in thinking mode
 * and the upstream keeps demanding the historical thinking blocks. Sending an
 * explicit `thinking: { type: "disabled" }` is what actually turns it off and
 * drops that requirement.
 */
function stripThinking(body) {
  const out = structuredClone(body);
  let changed = false;
  if (out.thinking === undefined || out.thinking.type !== 'disabled') {
    out.thinking = { type: 'disabled' };
    changed = true;
  }
  if (Array.isArray(out.messages)) {
    for (const msg of out.messages) {
      if (!msg || !Array.isArray(msg.content)) continue;
      const filtered = msg.content.filter((b) => !isThinkingBlock(b));
      if (filtered.length !== msg.content.length) {
        msg.content = filtered;
        changed = true;
      }
    }
  }
  return { obj: out, changed };
}

// ---------------------------------------------------------------------------
// OpenAI request repairs
// ---------------------------------------------------------------------------
function repairOpenAIRequest(body) {
  const out = structuredClone(body);
  let changed = false;

  if (Array.isArray(out.messages)) {
    for (const msg of out.messages) {
      if (!msg || msg.role !== 'assistant') continue;
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

      const existing = OPENAI_REASONING_KEYS.map((k) => (typeof msg[k] === 'string' ? msg[k] : '')).find(Boolean);
      if (existing) {
        for (const tc of toolCalls) {
          if (tc && tc.id) thinkingCache.set('openai:' + tc.id, [{ reasoning_content: existing }]);
        }
        continue;
      }
      if (!toolCalls.length) continue;

      for (const tc of toolCalls) {
        if (!tc || !tc.id) continue;
        const cached = thinkingCache.get('openai:' + tc.id);
        if (cached && cached[0] && cached[0].reasoning_content) {
          msg.reasoning_content = cached[0].reasoning_content;
          changed = true;
          break;
        }
      }
    }
  }
  return { obj: out, changed };
}

/**
 * Force the request out of "thinking mode" for the OpenAI dialect.
 *
 * Removing `reasoning_effort` / `reasoning_content` does NOT disable thinking
 * on gateways (new-api, one-api, LiteLLM) that translate an OpenAI chat
 * request into Anthropic Messages: their Claude models think by default, and
 * they only disable it when the client explicitly asks for
 * `reasoning_effort: "none"`. Worse, those gateways expose upstream thinking
 * to OpenAI clients as `reasoning_content`, but never translate it back into
 * a signed `thinking` block on the way in, so replaying it cannot satisfy the
 * upstream. Turning thinking off is therefore the only reliable fallback.
 */
function stripOpenAIReasoning(body) {
  const out = structuredClone(body);
  let changed = false;

  // Explicit off switch. Gateways map this to `thinking: {type:"disabled"}`.
  if (out.reasoning_effort !== 'none') {
    out.reasoning_effort = 'none';
    changed = true;
  }

  // Non-standard reasoning controls some gateways honour (zai / OpenRouter).
  if (out.thinking !== undefined) {
    delete out.thinking;
    changed = true;
  }
  if (out.reasoning !== undefined) {
    delete out.reasoning;
    changed = true;
  }
  if (out.enable_thinking !== undefined) {
    out.enable_thinking = false;
    changed = true;
  }

  if (Array.isArray(out.messages)) {
    for (const msg of out.messages) {
      if (!msg || msg.role !== 'assistant') continue;
      for (const k of OPENAI_REASONING_KEYS) {
        if (msg[k] !== undefined) {
          delete msg[k];
          changed = true;
        }
      }
    }
  }

  // A model-name alias such as `claude-opus-5-thinking` re-enables thinking on
  // gateways (new-api) after the request fields are read, overriding the
  // explicit "none". Drop the alias so the disable actually wins. The base
  // model id is left untouched, so this is safe for the common case.
  if (typeof out.model === 'string') {
    const base = out.model.replace(/-thinking(?:-\d+)?$/, '');
    if (base && base !== out.model) {
      out.model = base;
      changed = true;
    }
  }

  return { obj: out, changed };
}

// ---------------------------------------------------------------------------
// Attempt planning
// ---------------------------------------------------------------------------
function buildAttempts(rawBody, json, path) {
  if (!json) {
    return [{ label: rawBody.length ? 'raw' : 'empty', body: null }];
  }
  const kind = requestKind(path, json);

  if (DISABLE_THINKING) {
    const stripped = kind === 'anthropic' ? stripThinking(json) : stripOpenAIReasoning(json);
    if (stripped.changed) return [{ label: 'force-strip', body: stripped.obj }];
  }

  const attempts = [{ label: 'original', body: json }];

  if (kind === 'anthropic') {
    const repaired = repairAnthropicRequest(json);
    if (repaired.changed) attempts.push({ label: 'repair-thinking', body: repaired.obj });
    if (FALLBACK_DISABLE_THINKING) {
      const stripped = stripThinking(json);
      if (stripped.changed) attempts.push({ label: 'strip-thinking', body: stripped.obj });
    }
  } else {
    const repaired = repairOpenAIRequest(json);
    if (repaired.changed) attempts.push({ label: 'repair-reasoning', body: repaired.obj });
    if (FALLBACK_DISABLE_THINKING) {
      const stripped = stripOpenAIReasoning(json);
      if (stripped.changed) attempts.push({ label: 'strip-reasoning', body: stripped.obj });
    }
  }
  return attempts;
}

const serialize = (attempt, rawBody) =>
  attempt.body === null || attempt.body === undefined ? rawBody : Buffer.from(JSON.stringify(attempt.body), 'utf8');

/**
 * Gateways such as AgentRouter load-balance across several upstream channels
 * with different behaviour: the *same* request can randomly come back 200, with
 * the thinking error, or with a 5xx. A single retry is therefore not enough.
 *
 * The plan is the normal attempt sequence (original -> repair -> strip) with the
 * most-degraded attempt (usually "strip") repeated at the end, so a transient
 * failure just advances to the next plan item and retries.
 *
 * The plan itself is finite, but the caller cycles it indefinitely: when the
 * last item fails on a retryable error the plan starts over (labels get a
 * `+cycleN` suffix), so a request never hard-fails on a transient error.
 */
function buildRetryPlan(attempts, retryAttempts) {
  const plan = attempts.slice();
  const final = plan[plan.length - 1];
  if (final && retryAttempts > 0) {
    for (let i = 1; i <= retryAttempts; i++) {
      plan.push({ label: `${final.label}+retry${i}`, body: final.body });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Upstream call
// ---------------------------------------------------------------------------
async function callUpstream(req, bodyBuffer) {
  const url = UPSTREAM + req.url;
  const headers = upstreamHeaders(req, bodyBuffer ? bodyBuffer.length : 0);
  const init = { method: req.method, headers, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD' && bodyBuffer?.length) init.body = bodyBuffer;
  return fetch(url, init);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const started = Date.now();

  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cache: thinkingCache.size, upstream: UPSTREAM }));
    return;
  }

  let rawBody = Buffer.alloc(0);
  try {
    rawBody = await readBody(req);
  } catch (err) {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
    return;
  }

  let json = null;
  if (rawBody.length && String(req.headers['content-type'] || '').includes('application/json')) {
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      json = null;
    }
  }

  const attempts = buildAttempts(rawBody, json, req.url);
  const plan = buildRetryPlan(attempts, RETRY_ATTEMPTS);

  // Retry forever: when the plan is exhausted it wraps around and starts
  // over (labels get a `+cycleN` suffix). Only a definitive client error —
  // a 4xx that is *not* the thinking error — is ever returned to the client.
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  const labelAt = (idx) => {
    const cycle = Math.floor(idx / plan.length);
    const base = plan[idx % plan.length].label;
    return cycle > 0 ? `${base}+cycle${cycle}` : base;
  };

  for (let i = 0; !clientGone; i++) {
    const attempt = plan[i % plan.length];
    const label = labelAt(i);
    let upstream;
    try {
      upstream = await callUpstream(req, serialize(attempt, rawBody));
    } catch (err) {
      log(
        `[${req.method} ${req.url}] attempt "${label}" upstream error:`,
        err.message,
        `; retrying as "${labelAt(i + 1)}"`,
      );
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const ct = String(upstream.headers.get('content-type') || '');
    const isJson = ct.includes('application/json') || ct.includes('text/json');

    if (upstream.status >= 400) {
      const text = await upstream.text();
      // Gateways return this error as JSON, but for a streaming request
      // (`stream: true`, as pi sends) AgentRouter emits it as a text/event-stream
      // body. Match the message regardless of content-type, or the retry never
      // fires on the exact path the user hits.
      const thinkingError = THINKING_ERROR_RE.test(text);
      // 5xx and the thinking error are both channel-dependent and transient on
      // these gateways, so keep retrying — the plan cycles forever. A non-JSON
      // 5xx (e.g. an HTML error page) is retried too.
      const retryable = upstream.status >= 500 || thinkingError;
      if (retryable) {
        const why = thinkingError ? 'thinking error' : `HTTP ${upstream.status}`;
        log(`[${req.method} ${req.url}] attempt "${label}" -> ${why}; retrying as "${labelAt(i + 1)}"`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      log(`[${req.method} ${req.url}] attempt "${label}" -> ${upstream.status} (${Date.now() - started}ms)`);
      forwardBuffered(res, upstream, text);
      return;
    }

    if (isJson) {
      const text = await upstream.text();
      try {
        cacheFromJsonResponse(JSON.parse(text));
      } catch {
        /* ignore */
      }
      log(`[${req.method} ${req.url}] attempt "${label}" -> ${upstream.status} (${Date.now() - started}ms)`);
      forwardBuffered(res, upstream, text);
      return;
    }

    log(`[${req.method} ${req.url}] attempt "${label}" -> ${upstream.status} stream (${Date.now() - started}ms)`);
    await streamAndCapture(upstream, res);
    return;
  }

  // Only reachable if the client disconnected mid-retry: stop cleanly.
  if (!res.writableEnded) res.destroy();
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  console.log(`thinking-fix-proxy listening on http://${HOST}:${actualPort}`);
  console.log(`  upstream : ${UPSTREAM}`);
  console.log(`  fallback : ${FALLBACK_DISABLE_THINKING ? 'disable thinking on failure' : 'off'}`);
  console.log(`  retries  : unlimited (delay ${RETRY_DELAY_MS}ms; plan cycles forever on thinking error / 5xx / connect failure)`);
  console.log(`  dialects : anthropic /v1/messages + openai /v1/chat/completions`);
  if (DISABLE_THINKING) console.log('  mode     : DISABLE_THINKING always on');
});

// Graceful shutdown: close the listener, stop accepting, then exit. A force
// exit guards against long-lived keep-alive connections holding us open.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(0), 2000);
    force.unref();
    server.close(() => process.exit(0));
  });
}
