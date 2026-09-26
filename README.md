# AI Proxy

**A tiny, zero-dependency reverse proxy that fixes the "thinking must be passed back" error** when you talk to Anthropic- or OpenAI-compatible AI gateways such as [QuantumNous/new-api](https://github.com/QuantumNous/new-api), [one-api](https://github.com/songquanpeng/one-api), LiteLLM, and similar translators.

Works with **Claude Code**, **[pi](https://pi.dev)** (the coding agent), the OpenAI SDK, the Anthropic SDK, and anything else that speaks:

- **Anthropic Messages** → `POST /v1/messages`
- **OpenAI Chat Completions** → `POST /v1/chat/completions`

```
Node >= 18   ·   zero dependencies   ·   ~600 LOC   ·   MIT
```

---

## Table of contents

- [The problem](#the-problem)
- [What this proxy does](#what-this-proxy-does)
- [Quick start](#quick-start)
- [Point your client at it](#point-your-client-at-it)
  - [Claude Code](#claude-code-anthropic-messages)
  - [pi](#pi-openai-completions)
  - [OpenAI SDK](#openai-sdk)
  - [Anthropic SDK](#anthropic-sdk)
  - [curl](#curl)
- [Configuration](#configuration)
- [Run as a service](#run-as-a-service)
- [Health and logs](#health-and-logs)
- [Troubleshooting](#troubleshooting)
- [Provider gotchas](#provider-gotchas)
- [How it works](#how-it-works)
- [Tests](#tests)
- [Security](#security)
- [Limitations](#limitations)
- [FAQ](#faq)
- [License](#license)

---

## The problem

When extended thinking / reasoning is enabled **and the model uses a tool**, the upstream API requires that the assistant turn containing the tool call also carries the thinking block that produced it — *including the original signature*.

- Anthropic dialect: `content[]` must contain the `thinking` / `redacted_thinking` block(s).
- OpenAI dialect: the assistant message must contain `reasoning_content`.

Gateways and format translators frequently **drop those blocks** from the conversation history. The next request is then rejected:

```json
{
  "type": "invalid_request_error",
  "message": "The `content[].thinking` in the thinking mode must be passed back to the API. (request_id: ...)",
  "param": "",
  "code": null
}
```

OpenAI-dialect gateways surface the same requirement as a `reasoning_content ... must be passed back` error.

You cannot fix this on the client side, and you cannot ask the gateway to stop dropping the blocks. So the repair has to happen in the middle.

## What this proxy does

`server.mjs` sits between your client and the gateway and:

1. **Forwards every request untouched** — streaming (SSE) and non-streaming, both dialects, all headers and the client's API key preserved.
2. **Captures thinking as it streams by.** It parses responses and stores `thinking` / `redacted_thinking` blocks (Anthropic) and `reasoning_content` (OpenAI) in an in-memory LRU cache, keyed by `tool_use` / `tool_call` id.
3. **On the thinking error, retries automatically** after re-injecting the missing blocks into the matching assistant turns — original text *and signature* preserved.
4. **If the blocks can't be recovered** (e.g. the proxy restarted between turns), it retries with thinking/reasoning **explicitly disabled** (`thinking: {type:"disabled"}` / `reasoning_effort: "none"`), so the request still succeeds instead of hard-failing. Just deleting the fields is not enough — models like `claude-opus-5` think by default.
5. **Retries transient upstream failures — forever.** Gateways such as AgentRouter load-balance across several channels, so the *same* request can randomly return `200`, the thinking `400`, or a `500`. When the retry plan runs out it wraps around and starts again (`+cycle1`, `+cycle2`, …) until a request succeeds, so an intermittent failure becomes a normal response instead of a surfaced error. Only a definitive 4xx that is *not* the thinking error is ever returned as-is.
6. **`DISABLE_THINKING=1`** strips thinking from every request up front (brute-force mode).

When no repair is needed the proxy is a transparent passthrough.

## Quick start

Node 18+ only. There is nothing to install.

```bash
git clone https://github.com/k1zenn/ai_proxy.git
cd ai_proxy
./run.sh          # or: node server.mjs
```

`./run.sh` is a foreground runner: **Ctrl+C stops it and frees the port.** If
the port is already held — by the systemd unit below, or by a proxy left over
from an earlier terminal — `run.sh` stops that process first, so you never have
to hunt for a PID. Anything else on the port is reported and left untouched.

You should see:

```
thinking-fix-proxy listening on http://127.0.0.1:8787
  upstream : https://your-gateway.example.com
  fallback : disable thinking on failure
  dialects : anthropic /v1/messages + openai /v1/chat/completions
```

Verify it is alive:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"cache":0,"upstream":"https://your-gateway.example.com"}
```

Now point your client at `http://127.0.0.1:8787` (see below) and keep the proxy running.

## Point your client at it

The golden rule: **the proxy path is the same path your client already uses.** You only change the host/port, never the route.

| Client | Base URL you set | Client appends | Proxy forwards |
| --- | --- | --- | --- |
| Claude Code | `http://127.0.0.1:8787` | `/v1/messages` | `UPSTREAM` + `/v1/messages` |
| pi | `http://127.0.0.1:8787/v1` | `/chat/completions` | `UPSTREAM` + `/v1/chat/completions` |
| OpenAI SDK | `http://127.0.0.1:8787/v1` | `/chat/completions` | `UPSTREAM` + `/v1/chat/completions` |
| Anthropic SDK | `http://127.0.0.1:8787` | `/v1/messages` | `UPSTREAM` + `/v1/messages` |

`UPSTREAM` is configured **without** a trailing `/v1` (for example `https://your-gateway.example.com`).

### Claude Code (Anthropic Messages)

Edit `~/.claude/settings.json` and change **only** `ANTHROPIC_BASE_URL`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "your-upstream-api-key",
    "ANTHROPIC_MODEL": "claude-opus-5"
  },
  "model": "claude-opus-5"
}
```

The key is forwarded as both `x-api-key` and `Authorization: Bearer`.

### pi (OpenAI completions)

Add or edit the provider in `~/.pi/agent/models.json` (note: this is the **top-level** agent dir; there is no `~/.pi/agent/agent/models.json` lookup in pi):

```json
{
  "providers": {
    "my-gateway": {
      "name": "My Gateway",
      "baseUrl": "http://127.0.0.1:8787/v1",
      "api": "openai-completions",
      "apiKey": "$MY_GATEWAY_API_KEY",
      "compat": { "supportsDeveloperRole": false },
      "models": [
        { "id": "claude-opus-5", "name": "claude-opus-5", "contextWindow": 200000 },
        { "id": "deepseek-v4-flash", "name": "deepseek-v4-flash", "reasoning": true, "contextWindow": 700000 }
      ]
    }
  }
}
```

Two things that bite people:

- **The `/v1` suffix is required.** pi appends `/chat/completions`, so `http://127.0.0.1:8787` alone would produce `/chat/completions` instead of `/v1/chat/completions`.
- **Add `"compat": { "supportsDeveloperRole": false }`** if you set `"reasoning": true` on a model. Otherwise pi sends the OpenAI `developer` role, which many gateways reject with `422 unknown variant 'developer'`. See [Provider gotchas](#provider-gotchas).

You can verify resolution before running anything:

```bash
pi --list-models | grep my-gateway
```

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="your-upstream-api-key",
)

resp = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content, end="")
```

### Anthropic SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:8787",   # SDK appends /v1/messages
    api_key="your-upstream-api-key",
)

msg = client.messages.create(
    model="claude-opus-5",
    max_tokens=1024,
    thinking={"type": "enabled", "budget_tokens": 1024},
    messages=[{"role": "user", "content": "hello"}],
)
```

### curl

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer $UPSTREAM_API_KEY" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

> Some gateways reject non-browser/non-official client fingerprints (see [Provider gotchas](#provider-gotchas)); `curl` may legitimately return `401` even though your real client works.

## Configuration

Resolution order: **environment variable → `config.json` → built-in default.**

| Env var | `config.json` | Default | Description |
| --- | --- | --- | --- |
| `UPSTREAM` | `upstream` | — | Gateway base URL, **no** trailing slash and no `/v1`. Point this at your gateway |
| `PORT` | `port` | `8787` | Local port (`0` = random free port) |
| `HOST` | `host` | `127.0.0.1` | Bind address; use `0.0.0.0` for clients outside WSL/containers |
| `UPSTREAM_API_KEY` | `upstreamApiKey` | — | If set, overrides the client's key for every request |
| `FALLBACK_DISABLE_THINKING` | `fallbackDisableThinking` | `true` | Retry with thinking disabled on an unrecoverable thinking error |
| `DISABLE_THINKING` | `disableThinking` | `false` | Always strip thinking/reasoning from requests |
| `CACHE_SIZE` | `cacheSize` | `5000` | Max cached `id → thinking` entries in the LRU |
| `RETRY_ATTEMPTS` | `retryAttempts` | `5` | Copies of the most-degraded attempt appended to the first pass of the retry plan; after that the plan cycles forever (`+cycleN` labels) until a request succeeds |
| `RETRY_DELAY_MS` | `retryDelayMs` | `400` | Delay between retries, in milliseconds (applies to every retry, including cycles) |
| `MAX_BODY` | `maxBody` | `67108864` | Max request body size in bytes (64 MiB) |
| `LOG` | `log` | `true` | Request/attempt logging |
| `CONFIG` | — | `./config.json` | Alternate config file path |

Default `config.json`:

```json
{
  "upstream": "https://your-gateway.example.com",
  "host": "127.0.0.1",
  "port": 8787,
  "log": true,
  "fallbackDisableThinking": true,
  "disableThinking": false,
  "cacheSize": 5000,
  "retryAttempts": 5,
  "retryDelayMs": 400
}
```

Common overrides:

```bash
# different gateway
UPSTREAM=https://new-api.example.com node server.mjs

# expose to a Windows / other-machine client
HOST=0.0.0.0 node server.mjs

# pin the upstream key server-side (clients can then send anything)
UPSTREAM_API_KEY=sk-... node server.mjs

# nuke thinking on every request
DISABLE_THINKING=1 node server.mjs

# repeat the degraded attempt more often in the first pass (retries are unlimited regardless)
RETRY_ATTEMPTS=8 RETRY_DELAY_MS=250 node server.mjs
```

## Run as a service

### nohup

```bash
cd ai_proxy
nohup node server.mjs > proxy.log 2>&1 &
echo $! > proxy.pid
tail -f proxy.log
kill "$(cat proxy.pid)"
```

### systemd (user service)

Create `~/.config/systemd/user/ai-proxy.service`:

```ini
[Unit]
Description=AI Proxy (thinking-fix reverse proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/ai_proxy
ExecStart=/usr/bin/node %h/ai_proxy/server.mjs
Environment=HOST=127.0.0.1
Environment=PORT=8787
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ai-proxy
loginctl enable-linger "$USER"        # start on boot even without an interactive login
journalctl --user -u ai-proxy -f
```

`enable-linger` matters: a user service is otherwise stopped at logout and is
not started after a reboot until you log in again — which is exactly how the
proxy goes missing between tool-calling turns and the "thinking must be passed
back" error comes back.

> **`run.sh` and the systemd unit share one port.** Running `./run.sh` stops the
> `ai-proxy` unit first, and Ctrl+C leaves it stopped. If you want the
> always-on service back, run `systemctl --user start ai-proxy`.

### WSL / container note

If the client runs **on Windows** while the proxy runs **inside WSL**, bind `0.0.0.0` and use the WSL IP (or `localhost` with WSL2 localhost forwarding):

```bash
HOST=0.0.0.0 node server.mjs
hostname -I | awk '{print $1}'      # WSL IP for the Windows-side client
```

## Health and logs

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"cache":0,"upstream":"https://your-gateway.example.com"}
```

`cache` is the current number of cached thinking entries. It grows as tool-calling turns complete.

Log lines look like this — note the attempt labels:

```
2026-01-01T00:00:00.000Z [POST /v1/messages] attempt "original" -> thinking error; retrying as "repair-thinking"
2026-01-01T00:00:00.123Z [POST /v1/messages] attempt "repair-thinking" -> 200
2026-01-01T00:00:01.000Z [POST /v1/chat/completions] attempt "original" -> HTTP 500; retrying as "strip-reasoning"
2026-01-01T00:00:01.400Z [POST /v1/chat/completions] attempt "strip-reasoning" -> thinking error; retrying as "strip-reasoning+retry1"
2026-01-01T00:00:01.800Z [POST /v1/chat/completions] attempt "strip-reasoning+retry1" -> 200
2026-01-01T00:00:02.000Z [POST /v1/chat/completions] attempt "original" -> 200 stream (919ms)
2026-01-01T00:00:03.000Z [POST /v1/chat/completions] attempt "strip-reasoning+retry2" -> thinking error; retrying as "original+cycle1"
2026-01-01T00:00:03.919Z [POST /v1/chat/completions] attempt "original+cycle1" -> 200 stream (919ms)
```

| Attempt label | Meaning |
| --- | --- |
| `original` | Request forwarded byte-for-byte |
| `repair-thinking` / `repair-reasoning` | Missing blocks were recovered from cache and re-injected |
| `strip-thinking` / `strip-reasoning` | Fallback: thinking/reasoning **explicitly disabled** so the call can succeed |
| `…+retryN` | A transient thinking error / `5xx` was retried (flaky gateway channel) |
| `…+cycleN` | The retry plan wrapped around and restarted — retries never stop |
| `force-strip` | `DISABLE_THINKING=1` is on |
| `raw` / `empty` | Non-JSON body (tunnelled untouched) |

**Request bodies are never logged.** Only method, path, attempt label, status, and latency.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `400 content[].thinking ... must be passed back` keeps appearing | Either the cache was empty (proxy restarted mid-conversation), the gateway cannot round-trip thinking at all (see below), **or the gateway is load-balancing to a strict channel** | Keep the proxy alive across turns and make sure the proxy is the one in the request path. The proxy already retries forever across channels, so a stuck request means every channel is strict — then set `DISABLE_THINKING=1` to force thinking off up front |
| `422 ... unknown variant 'developer'` | Your client sent the OpenAI `developer` role; the gateway only accepts `system` | Set `compat.supportsDeveloperRole: false` (pi) or the equivalent for your client |
| `401 unauthorized client detected` | The **gateway** fingerprints clients and blocks yours. Common with `curl`, `python`, and generic `node` user-agents | The proxy forwards your client's `User-Agent`, so use the client the gateway expects; do not diagnose with `curl` |
| Request hangs; the log repeats `upstream error: getaddrinfo ENOTFOUND …` | DNS/network/TLS problem reaching `UPSTREAM` | Check `UPSTREAM` and connectivity — the proxy retries connect failures forever, so the client only times out |
| `413 request body too large` | Body exceeded `MAX_BODY` | Raise `MAX_BODY` |
| `EADDRINUSE` / `address already in use` from `run.sh` | The port is held by the systemd `ai-proxy` unit or a previous proxy | Use `./run.sh` (it stops those automatically) or `PORT=8788 ./run.sh`; `node server.mjs` on its own does not take over the port |
| Health check works but requests fail | Auth/upstream issue, not the proxy | Run with `LOG=1` and read the attempt lines |
| `/v1/models` returns `401` but completions work | Some gateways restrict the models endpoint for limited keys | Ignore it; use a real completion as your check |

## Provider gotchas

These are upstream behaviors that the proxy deliberately does **not** paper over, because they are not protocol bugs and silently masking them would hide real misconfiguration. The one exception is transient channel flakiness, which the retry plan does absorb.

### Client fingerprinting

Some gateways reject requests based on the client's `User-Agent` (and, less often, TLS fingerprint). A gateway that does this typically returns:

```json
{"error":{"message":"unauthorized client detected"},"message":"UNAUTHENTICATED","type":"unauthorized_client_error"}
```

for `curl`, `OpenAI/Python`, and bare `node` user-agents, while accepting official CLI user-agents and pi's `pi (<os> <release>; <arch>)`.

The proxy **forwards your client's headers unchanged**, so a permitted client stays permitted. Because a `curl` test will often be rejected, always validate with the client you actually intend to use.

### OpenAI clients + Claude models + new-api/one-api: thinking cannot be replayed

This is the case the explicit-disable fallback exists for. Gateways such as
[QuantumNous/new-api](https://github.com/QuantumNous/new-api) expose upstream
Claude thinking to OpenAI clients as `reasoning_content`, but their
OpenAI→Claude **request** translator never reads `reasoning_content` back into
a signed `thinking` block. The round trip is lossy in one direction only:

```
Claude thinking  ──►  reasoning_content        (response path: works)
reasoning_content ──►  ???                      (request path: dropped)
```

So re-injecting `reasoning_content` cannot satisfy Anthropic, and a follow-up
tool turn fails even though the client played its part correctly. The only
reliable repair through the OpenAI dialect is to turn thinking off, which the
proxy does by sending `reasoning_effort: "none"`.

If you want to keep thinking on for Claude models, point the client at the
gateway's **Anthropic Messages** endpoint instead (`anthropic-messages` in pi,
or `ANTHROPIC_BASE_URL` for Claude Code). There the client replays the signed
`thinking` blocks itself and the gateway passes them through untouched; the
proxy then acts as a pure passthrough.

### Flaky multi-channel gateways (AgentRouter and friends)

Some gateways front several upstream channels behind one endpoint and pick one
per request. The channels disagree about thinking: one accepts the request,
another demands the thinking block be replayed, and a third may be briefly
unavailable. The result is that the **same** request randomly returns `200`, the
thinking `400`, or a `500`:

```
POST /v1/chat/completions  ->  200
POST /v1/chat/completions  ->  400  content[].thinking must be passed back
POST /v1/chat/completions  ->  500  Service temporarily unavailable
```

This is not something a client can observe or fix, and a single fallback is not
enough because the retry can land on another bad channel. The proxy therefore
retries indefinitely: after the most-degraded attempt is exhausted the plan
wraps around (`+cycle1`, `+cycle2`, …) until a channel answers `200`. The
thinking error is only ever surfaced if the client gives up first.

One extra trap makes this look unfixable: when the client streams (`stream:
true`, as pi does), the gateway frames the thinking error as
`text/event-stream` rather than JSON. A proxy that only inspects JSON error
bodies will forward it untouched. This proxy matches the error message in
either framing.

### `developer` vs `system` role

OpenAI-compatible reasoning models may use the `developer` role for the system prompt. Many gateways only accept `system`:

```
422 {"message":"Failed to deserialize the JSON body into the target type: messages[0].role: unknown variant `developer`, expected one of `system`, `user`, `assistant`, `tool` ..."}
```

Fix it in the client: for pi, set `"compat": { "supportsDeveloperRole": false }` on the provider or model.

### Reasoning is sometimes on by default

Some gateways return `reasoning_content` even when the client never asked for reasoning. That is exactly the condition that makes the missing-block error likely on the *next* turn — the case this proxy exists for.

## How it works

```
            ┌────────────────────────────────────────────────────────────┐
 client ──▶ │  ai_proxy (server.mjs)                                     │
            │                                                            │
            │  1. read body ──▶ JSON? ──yes──▶ detect dialect            │
            │       │                              │                     │
            │       │                              ├─ anthropic: cache/  │
            │       │                              │   repair thinking  │
            │       │                              └─ openai: cache/     │
            │       │                                  repair reasoning  │
            │       ▼                                                    │
            │  2. call upstream ──▶ 2xx ──▶ stream & capture ──▶ client   │
            │                     │                                      │
            │                     └─ 4xx + thinking-error              │
            │                          └─▶ next attempt (repair → strip) │
            └────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                              UPSTREAM (gateway)
```

**Attempt planning** (`buildAttempts`) computes the candidate request bodies once per request:

- Anthropic: `original` → `repair-thinking` → `strip-thinking`
- OpenAI: `original` → `repair-reasoning` → `strip-reasoning`
- Only attempts that actually change the body are included.

The retry plan (`buildRetryPlan`) then appends `RETRY_ATTEMPTS` copies of the
last attempt (e.g. `strip-reasoning+retry1`…), so a transient thinking error or
`5xx` simply advances to the next item. The plan is finite, but the request loop
is not: when it runs out, it wraps around and restarts with `+cycleN` labels,
retrying until the upstream answers successfully (or the client disconnects).

**Capture** (`StreamCollector`) handles both dialects at once and works on SSE and on buffered JSON:

- Anthropic: `content_block_start` creates a block keyed by index; `thinking_delta` / `signature_delta` accumulate into it; `tool_use` blocks provide the cache key.
- OpenAI: `choices[].delta.reasoning_content` / `delta.reasoning` accumulate; `delta.tool_calls[].id` provides the cache key.

**Retry** triggers when the upstream returns a `5xx`, fails to connect, or returns a `4xx` body matching the thinking-error pattern. There is no attempt limit — the plan cycles until the upstream answers. The error is matched by its message rather than its content-type, because for a streaming request (`stream: true`, which is what pi sends) AgentRouter frames it as `text/event-stream` instead of JSON — the case that previously slipped straight through to the client. A `4xx` that does not match the pattern is forwarded verbatim.

## Tests

```bash
node test/proxy.test.mjs
# PASS: all proxy scenarios (anthropic + openai + retries)
```

The test spins up a mock gateway that reproduces the exact `400` on **both** dialects, then verifies:

- Anthropic first turn → `200`, streaming thinking + tool_use captured.
- Anthropic continuation → `200`, original `thinking` text **and signature** re-injected.
- Anthropic continuation with an unknown tool id → `200`, `thinking` stripped (fallback).
- OpenAI first turn → `200`, `reasoning_content` present in the response.
- OpenAI continuation → `200`, `reasoning_content` re-injected.
- OpenAI continuation with an unknown tool call id → `200`, `reasoning_effort: "none"` (fallback).
- OpenAI continuation against a strict gateway that drops `reasoning_content` → `200` only because thinking is explicitly disabled.
- OpenAI continuation that replays `reasoning_content` with no `reasoning_effort` (pi's real shape) against the strict gateway → `200`, reasoning disabled.
- A flaky gateway that returns `500` → thinking `400` → `500` → `200` → `200`, proving the retry plan survives channel-dependent failures.
- A gateway that fails more times than the plan has items → still `200`, because the plan wraps around and keeps retrying.
- A definitive `4xx` (`402`) → forwarded immediately, never retried.

No network access and no API keys are required.

## Security

- **Bind to loopback by default.** `127.0.0.1` unless you explicitly set `HOST=0.0.0.0`.
- **No disk writes.** Nothing is persisted; request bodies are never logged.
- **The proxy holds your API key in memory only.** It strips hop-by-hop headers and never stores credentials.
- **`HOST=0.0.0.0` exposes a credential-relaying proxy on your network.** Anything that can reach the port can spend your upstream quota. Prefer loopback, a firewall, or SSH tunnelling.
- **TLS terminates at the gateway.** Client → proxy is plain HTTP, so keep it on loopback or a trusted private network.
- **`UPSTREAM_API_KEY`** is the way to give clients *no* usable key: they talk to the proxy, the proxy injects the real key.

## Limitations

- **The cache is in memory and per process.** If the proxy restarts between the tool call and the follow-up, signatures are lost and the request falls back to disabling thinking.
- **Repair requires a prior captured turn in the same process.** It cannot invent a signature.
- **Message history rewriting is heuristic.** Blocks are matched by `tool_use` / `tool_call` id; exotic dialects may not match.
- **Only request/response JSON is inspected.** Multipart and non-JSON bodies are tunnelled untouched.
- **No request queueing, rate limiting, or backoff.** Thinking errors, `5xx`, and connect failures are retried indefinitely at a fixed `RETRY_DELAY_MS`; a permanently broken upstream means a request hangs until the client disconnects.
- **The fallback disables reasoning**, so the model may produce a lower-quality answer than a successful repair. It exists to keep you moving, not to be ideal. For Claude models behind new-api this is the only repair that works over the OpenAI dialect (see [Provider gotchas](#provider-gotchas)).

## FAQ

**Do I need this if my client already replays thinking blocks?**
No. When the client sends the blocks itself, the proxy is a pure passthrough. It is insurance for the turns where something drops them.

**Does it work with streaming?**
Yes. SSE is parsed in parallel with the response so the client is never delayed; the response is passed through unmodified.

**Do I need to change any client code?**
No. Change one base URL.

**Why is my `curl` test returning `401`?**
Your gateway fingerprints clients. See [Provider gotchas](#provider-gotchas).

**Will it slow down requests?**
It adds a local hop and buffers the request body in memory. When no repair is needed there is no extra upstream call.

**Can I run several instances?**
Yes — give each its own `PORT`. Caches are not shared, so each instance has its own repair history.

## License

MIT — see [LICENSE](LICENSE).
