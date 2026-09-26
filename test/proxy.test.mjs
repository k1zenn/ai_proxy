/**
 * End-to-end test for thinking-fix-proxy.
 *
 * Spins up a mock gateway that reproduces the exact
 * "content[].thinking must be passed back" 400 on BOTH the Anthropic
 * (/v1/messages) and OpenAI (/v1/chat/completions) dialects, then runs the
 * proxy in front of it and verifies transparent repair. A second mock gateway
 * models AgentRouter's channel-dependent 500/thinking/200 flakiness to verify
 * the retry plan.
 *
 *   node test/proxy.test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.mjs');

const THINKING_ERROR =
  'The `content[].thinking` in the thinking mode must be passed back to the API. (request_id: test)';

const SIGNATURE = 'sig_abc123';
const THINKING_TEXT = 'Let me check the weather using the tool.';
const REASONING_TEXT = 'I should call the weather tool.';

// ---------------------------------------------------------------------------
// Mock gateway
// ---------------------------------------------------------------------------
function anthropicMissingThinking(body) {
  if (!body || !Array.isArray(body.messages)) return false;
  // A model that thinks by default is still "in thinking mode" when the field
  // is absent; only an explicit disabled tells it to stop requiring blocks.
  const thinking = body.thinking;
  const enabled = thinking === undefined ? false : thinking.type !== 'disabled';
  if (!enabled) return false;
  return body.messages.some((m) => {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return false;
    const hasToolUse = m.content.some((b) => b && b.type === 'tool_use');
    const hasThinking = m.content.some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'));
    return hasToolUse && !hasThinking;
  });
}

/**
 * Mirrors new-api: an OpenAI chat request mapped to Anthropic Messages.
 * `strict` reproduces the real gateway, which ignores reasoning_content on the
 * request path and only stops requiring thinking when the client explicitly
 * asks for reasoning_effort: "none".
 */
function openaiMissingReasoning(body, strict) {
  if (!body || !Array.isArray(body.messages)) return false;
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined;
  const thinking = body.thinking;
  const reasoning = body.reasoning;
  const off =
    effort === 'none' ||
    (thinking && thinking.type === 'disabled') ||
    (reasoning && reasoning.enabled === false);
  // Claude models think by default (new-api's `defaultThinking`), even when the
  // client sends no reasoning field at all. That is the user's exact case.
  const defaultThinking = typeof body.model === 'string' && /claude|opus|sonnet|haiku/i.test(body.model);
  const reasoningOn =
    !off && (effort !== undefined || thinking !== undefined || reasoning !== undefined || defaultThinking);
  if (!reasoningOn) return false;
  return body.messages.some((m) => {
    if (!m || m.role !== 'assistant') return false;
    const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    if (!hasTools) return false;
    if (strict) return true; // reasoning_content is dropped by the translator
    const hasReasoning = typeof m.reasoning_content === 'string' || typeof m.reasoning === 'string';
    return !hasReasoning;
  });
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  res.end();
}

function startMockUpstream() {
  const observed = { anthropic: [], openai: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const isOpenAI = /\/chat\/completions/.test(req.url);
      const strict = req.headers['x-mock-strict'] === '1';
      (isOpenAI ? observed.openai : observed.anthropic).push(body);

      // ---- OpenAI dialect ----
      if (isOpenAI) {
        if (openaiMissingReasoning(body, strict)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: THINKING_ERROR } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  reasoning_content: REASONING_TEXT,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
        );
        return;
      }

      // ---- Anthropic dialect ----
      if (anthropicMissingThinking(body)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'invalid_request_error',
            message: THINKING_ERROR,
            param: '',
            code: null,
          }),
        );
        return;
      }

      sse(res, [
        { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', role: 'assistant' } } },
        {
          event: 'content_block_start',
          data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        },
        {
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_TEXT } },
        },
        {
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_test_1', name: 'get_weather', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, observed }),
    );
  });
}

/**
 * A gateway that returns a scripted sequence of transient failures before
 * succeeding, reproducing AgentRouter's channel-dependent 500s / thinking 400s.
 */
function startFlakyUpstream(sequence) {
  let i = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      seen.push(body);
      const step = sequence[Math.min(i, sequence.length - 1)];
      i++;
      if (step === '500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Service temporarily unavailable', type: 'api_error' }));
        return;
      }
      if (step === 'thinking') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: THINKING_ERROR } }));
        return;
      }
      if (step === 'thinking-sse') {
        // The real streaming path: a 400 whose body is framed as text/event-stream.
        res.writeHead(400, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(`event: error\ndata: ${JSON.stringify({ error: { type: 'invalid_request_error', message: THINKING_ERROR } })}\n\n`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-flaky',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

function startProxy(upstreamPort, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      HOST: '127.0.0.1',
      PORT: '0',
      LOG: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (chunk) => {
      out += chunk.toString();
      const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({ child, port: parseInt(m[1], 10) });
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('proxy did not start: ' + out)), 5000);
  });
}

async function post(port, urlPath, body, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'client-key', ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------------------
// Scenario data
// ---------------------------------------------------------------------------
function anthropicFollowUp(toolUseId) {
  return {
    model: 'claude-opus-5',
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'weather in Paris?' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'get_weather', input: { city: 'Paris' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '22C and sunny' }] },
    ],
  };
}

function openaiFollowUp(toolCallId, reasoningContent) {
  const assistant = {
    role: 'assistant',
    tool_calls: [
      { id: toolCallId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ],
  };
  if (reasoningContent !== undefined) assistant.reasoning_content = reasoningContent;
  return {
    model: 'claude-opus-5',
    reasoning_effort: 'medium',
    messages: [
      { role: 'user', content: 'weather in Paris?' },
      assistant,
      { role: 'tool', tool_call_id: toolCallId, content: '22C and sunny' },
    ],
  };
}

/** pi replays reasoning_content but sends no reasoning_effort (model.reasoning=false). */
function openaiReplayFollowUp(toolCallId) {
  const body = openaiFollowUp(toolCallId, REASONING_TEXT);
  delete body.reasoning_effort;
  return body;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
async function main() {
  const { server, port: upstreamPort, observed } = await startMockUpstream();
  const { child, port: proxyPort } = await startProxy(upstreamPort);

  try {
    // ================= Anthropic dialect =================
    const a1 = await post(proxyPort, '/v1/messages', {
      model: 'claude-opus-5',
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'weather in Paris?' }] }],
    });
    assert.equal(a1.status, 200, 'anthropic first turn -> 200');
    assert.match(a1.text, /thinking_delta/);
    assert.match(a1.text, /toolu_test_1/);

    const a2 = await post(proxyPort, '/v1/messages', anthropicFollowUp('toolu_test_1'));
    assert.equal(a2.status, 200, 'anthropic repaired continuation -> 200');
    const aBody = observed.anthropic.at(-1);
    const injected = aBody.messages.find((m) => m.role === 'assistant').content.find((b) => b.type === 'thinking');
    assert.ok(injected, 'thinking re-injected');
    assert.equal(injected.signature, SIGNATURE, 'signature preserved');
    assert.equal(injected.thinking, THINKING_TEXT, 'thinking text preserved');

    const a3 = await post(proxyPort, '/v1/messages', anthropicFollowUp('toolu_never_seen'));
    assert.equal(a3.status, 200, 'anthropic fallback strip -> 200');
    assert.equal(observed.anthropic.at(-1).thinking.type, 'disabled', 'thinking explicitly disabled');

    // ================= OpenAI dialect =================
    const o1 = await post(proxyPort, '/v1/chat/completions', {
      model: 'claude-opus-5',
      reasoning_effort: 'medium',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
    });
    assert.equal(o1.status, 200, 'openai first turn -> 200');
    assert.match(o1.text, /reasoning_content/, 'openai response has reasoning');

    const o2 = await post(proxyPort, '/v1/chat/completions', openaiFollowUp('call_1'));
    assert.equal(o2.status, 200, 'openai repaired continuation -> 200');
    const oBody = observed.openai.at(-1);
    const oAssistant = oBody.messages.find((m) => m.role === 'assistant');
    assert.equal(oAssistant.reasoning_content, REASONING_TEXT, 'reasoning_content re-injected');

    const o3 = await post(proxyPort, '/v1/chat/completions', openaiFollowUp('call_never_seen'));
    assert.equal(o3.status, 200, 'openai fallback strip -> 200');
    assert.equal(observed.openai.at(-1).reasoning_effort, 'none', 'reasoning explicitly disabled');

    // A gateway that ignores reasoning_content (the real new-api behaviour)
    // cannot be repaired by re-injecting it; only disabling thinking works.
    const o4 = await post(proxyPort, '/v1/chat/completions', openaiFollowUp('call_strict_1'), {
      'x-mock-strict': '1',
    });
    assert.equal(o4.status, 200, 'openai strict gateway continuation -> 200');
    assert.equal(observed.openai.at(-1).reasoning_effort, 'none', 'strict gateway got reasoning off');
    assert.ok(
      observed.openai.at(-1).messages.find((m) => m.role === 'assistant').reasoning_content === undefined,
      'strict gateway reasoning_content removed',
    );

    // The user's exact case: pi replays reasoning_content, sends no
    // reasoning_effort, and the gateway thinks by default. Only the explicit
    // disable can save it.
    const o5 = await post(proxyPort, '/v1/chat/completions', openaiReplayFollowUp('call_replay_1'), {
      'x-mock-strict': '1',
    });
    assert.equal(o5.status, 200, 'openai replayed-reasoning continuation -> 200');
    assert.equal(observed.openai.at(-1).reasoning_effort, 'none', 'replayed reasoning was disabled');

    // ================= Flaky gateway: retry across transient failures =================
    // AgentRouter load-balances across channels; the same request can come
    // back 500, with the thinking error, or 200. A single fallback is not
    // enough, so the proxy must keep retrying the most-degraded attempt.
    {
      const flaky = await startFlakyUpstream(['500', 'thinking', '500', '200']);
      const retryProxy = await startProxy(flaky.port, { RETRY_ATTEMPTS: '5', RETRY_DELAY_MS: '0' });
      try {
        const r = await post(retryProxy.port, '/v1/chat/completions', openaiReplayFollowUp('call_flaky_1'));
        assert.equal(r.status, 200, 'flaky gateway eventually -> 200');
        assert.ok(flaky.seen.length >= 4, `proxy retried across transient failures (saw ${flaky.seen.length})`);
        assert.equal(flaky.seen.at(-1).reasoning_effort, 'none', 'final attempt disabled reasoning');
      } finally {
        retryProxy.child.kill('SIGTERM');
        flaky.server.close();
      }
    }

    // The same failure, but framed as text/event-stream (the shape pi actually
    // triggers by sending stream: true). It must still be detected and retried.
    {
      const flaky = await startFlakyUpstream(['thinking-sse', '200']);
      const retryProxy = await startProxy(flaky.port, { RETRY_ATTEMPTS: '5', RETRY_DELAY_MS: '0' });
      try {
        const r = await post(retryProxy.port, '/v1/chat/completions', openaiReplayFollowUp('call_sse_1'));
        assert.equal(r.status, 200, 'SSE-framed thinking error is retried -> 200');
        assert.ok(flaky.seen.length >= 2, 'retried after SSE thinking error');
      } finally {
        retryProxy.child.kill('SIGTERM');
        flaky.server.close();
      }
    }

    console.log('PASS: all proxy scenarios (anthropic + openai + retries)');
  } finally {
    child.kill('SIGTERM');
    server.close();
  }
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
