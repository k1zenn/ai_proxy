/**
 * End-to-end test for thinking-fix-proxy.
 *
 * Spins up a mock gateway that reproduces the exact
 * "content[].thinking must be passed back" 400 on BOTH the Anthropic
 * (/v1/messages) and OpenAI (/v1/chat/completions) dialects, then runs the
 * proxy in front of it and verifies transparent repair.
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
  return body.messages.some((m) => {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return false;
    const hasToolUse = m.content.some((b) => b && b.type === 'tool_use');
    const hasThinking = m.content.some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'));
    return hasToolUse && !hasThinking;
  });
}

function openaiMissingReasoning(body) {
  if (!body || !Array.isArray(body.messages)) return false;
  const reasoningOn = body.reasoning_effort !== undefined || body.thinking !== undefined || body.reasoning !== undefined;
  if (!reasoningOn) return false;
  return body.messages.some((m) => {
    if (!m || m.role !== 'assistant') return false;
    const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    const hasReasoning = typeof m.reasoning_content === 'string' || typeof m.reasoning === 'string';
    return hasTools && !hasReasoning;
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
      (isOpenAI ? observed.openai : observed.anthropic).push(body);

      // ---- OpenAI dialect ----
      if (isOpenAI) {
        if (openaiMissingReasoning(body)) {
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
      if (body && body.thinking && anthropicMissingThinking(body)) {
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

async function post(port, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'client-key' },
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

function openaiFollowUp(toolCallId) {
  return {
    model: 'claude-opus-5',
    reasoning_effort: 'medium',
    messages: [
      { role: 'user', content: 'weather in Paris?' },
      {
        role: 'assistant',
        tool_calls: [
          { id: toolCallId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
        ],
      },
      { role: 'tool', tool_call_id: toolCallId, content: '22C and sunny' },
    ],
  };
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
    assert.equal(observed.anthropic.at(-1).thinking, undefined, 'thinking param stripped');

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
    assert.equal(observed.openai.at(-1).reasoning_effort, undefined, 'reasoning_effort stripped');

    console.log('PASS: all proxy scenarios (anthropic + openai)');
  } finally {
    child.kill('SIGTERM');
    server.close();
  }
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
