# Final Audit Report — ClaudeCode-Copilot-Proxy

**Date:** 2026-09-12  
**Scope:** Every finding of the original repository audit, the follow-up work
landed since, live verification against GitHub Copilot with the installed
Claude Code client (2.1.268), and the proxy's measured overhead versus the
"original" path.

## Executive verdict

**The Claude Code path is now a transparent gateway with no measurable proxy
overhead on the tested account.** Claude Code's native Anthropic Messages
protocol is forwarded to Copilot's native `/v1/messages` (advertised by the
live catalog for every Claude model); thinking blocks and signatures, prompt
cache markers and cache usage, nested tool-result images, beta headers and raw
SSE frames all survive unchanged. Token counting uses Copilot's provider
counter and matched it exactly on every fixture.

Measured against direct calls to the same Copilot endpoint (6 paired samples,
`claude-sonnet-5`), the proxy's paired-p50 overhead was **−105 ms**
(`count_tokens`), **−36 ms** (buffered message) and **+17 ms** (streamed
message) — inside network jitter. First complete streamed frame: 844 ms via
proxy vs 867 ms direct.

**What this does not establish:** equivalence with `api.anthropic.com`. No
direct Anthropic API key was available, so model serving, quotas, output
quality and Anthropic-side latency remain unmeasured. Copilot's native Messages
support is implementation-verified (this account, plus Microsoft's first-party
client selecting it from model metadata), not a documented public GitHub API
guarantee.

## Status of the original findings

| # | Original finding | Status | Evidence |
|---|---|---|---|
| 1 | Extended thinking discarded | **Fixed (native)** | Native route forwards `thinking`/`output_config`; live run returned a thinking block with a 788-char signature and a correct signed-history continuation. `anthropic.native.test.ts` asserts byte-exact SSE relay of `thinking_delta`/`signature_delta`. |
| 2 | Prompt-cache markers discarded | **Fixed (native)** | Live: 11,013 `cache_creation_input_tokens` then 11,013 `cache_read_input_tokens` on repeat. Usage fields relayed unchanged. |
| 3 | Streaming read only `choices[0]` | **Fixed** | Chat fallback merges all choices with choice-scoped tool indices (tests); native route never reconstructs. |
| 4 | Parallel streamed tool ordering | **Fixed** | Chat fallback serializes into valid block lifecycle (tests); native relays provider frames. Live: two parallel tool calls with distinct IDs. |
| 5 | Silent model substitution | **Fixed** | `MODEL_SELECTION=strict` default; `X-Proxy-Resolved-Model` / `X-Proxy-Actual-Model` headers; live 400 for invented IDs before any spend. |
| 6 | Token counting ≈ chars/4 | **Fixed (native)** | Provider `/v1/messages/count_tokens`; counts matched direct Copilot on records (8,028), code (1,685), Unicode (645), tools (454). Chat-fallback heuristic remains approximate (`cp-runtime-token-count`, P2). |
| 7 | No timeouts / retries / abort | **Fixed** | Single deadline through body consumption; opt-in bounded retries for explicit 429/502/503/504 only; safe GET retries for token/catalog; disconnect cancels upstream (tests, both routes). |
| 8 | Network exposure / open CORS | **Fixed** | Host/Origin/Sec-Fetch-Site checks, `PROXY_AUTH_TOKEN` required off-loopback, no wildcard CORS, Docker non-root with healthcheck. |
| 9 | Requests counted twice | **Fixed** | Route tests assert `requestCount: 1` for buffered, streamed and aborted requests. |
| 10 | Usage sessions never evicted | **Fixed** | TTL + LRU bound (`usage-service.test.ts`). |
| 11 | SSE writes ignore backpressure | **Fixed** | `writeResponse` awaits `drain`, resolves false on disconnect. |
| 12 | 50 MB body limit | **Fixed** | 10 MB default, configurable. |
| 13 | Error handler logs bodies | **Fixed** | Logs status/method only. |
| 14 | Tool-name sanitisation collisions | **Fixed** | Hash-suffixed reserved namespace; native route needs no sanitisation. |
| 15 | `disable_parallel_tool_use`, `top_k`, metadata ignored | **Fixed / explicit** | Native passes everything through; chat fallback maps `parallel_tool_calls` and warns/rejects the rest via `X-Proxy-Warnings` / `UNSUPPORTED_FEATURES`. |
| 16 | Capability fields not enforced | **Fixed** | Chat fallback enforces tools/vision/limits; native lets Copilot validate (no heuristic rejection of valid requests). |
| 17 | Static fallback advertises GPT/Gemini | **Fixed** | Filtered unless `EXPOSE_ALL_COPILOT_MODELS=true`. |
| 18 | `/health` liveness only | **Documented** | Still liveness (+version); auth state is on `/auth/status`. Intentional: `/health` is public. |
| 19 | Machine ID recomputed per request | **Fixed** | Cached. |
| 20 | Docker root / no healthcheck | **Fixed** | `USER node`, `HEALTHCHECK`. |
| 21 | OpenAI/Cursor path legacy & broken | **Fixed (this release)** | Rebuilt as a relay to Copilot's OpenAI-compatible chat endpoint. Live: GPT-5.4, GPT-4.1, Claude exact; streaming + tool calls OK; `/responses`-only models refused with a clear 400. |
| 22 | Missing tests | **Addressed** | 281 tests across 19 suites incl. authenticated lifecycle, native relay, OpenAI relay, catalog refresh, fetch deadlines/retries, access control, entrypoints. Live A/B vs Anthropic remains opt-in (needs a key). |
| 23 | CI lacks dependency audit | **Partially** | `npm audit --omit=dev` is clean after removing `uuid`, `cors`, `fetch-event-source`; no CI audit step added (would fail on upstream advisories outside the project's control). |
| 24 | Version stuck at 0.1.0 / Unreleased | **Open (maintainer decision)** | All work is under `Unreleased`; cutting a release is a publishing decision, not a code defect. |
| 25 | README contradiction on `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | **Fixed** | The cost example no longer sets it. |

## Findings from this final pass (all fixed)

| Finding | Impact | Fix |
|---|---|---|
| **Streamed responses destroyed the upstream TLS socket** (`for await … return` destroys the stream by default). Every request after a streamed message paid a fresh handshake: `count_tokens` via proxy 1,197 ms p50 vs 373 ms direct. | Largest real-world proxy overhead; Claude Code streams every message. | `utils/sse-relay.ts` iterates with `destroyOnReturn: false`, callers mark graceful completion, the remainder is drained and the socket returns to the keep-alive pool. Tests assert the upstream socket stays open after `message_stop`/`[DONE]`. After fix: 376 ms p50. |
| Catalog refresh blocked one request per 10-minute TTL (~1 s) | Periodic latency spike | Stale-while-revalidate with single in-flight fetch and 30 s failure backoff; only a cold start waits. |
| Copilot token refreshed only after expiry | Periodic blocking refresh (~0.5–1 s) | Background refresh 10 min before expiry, checked every minute. |
| Cursor relay: Copilot rejects deprecated `max_tokens` for GPT-5.x with `text/plain 400` | Cursor requests failed as opaque 502 | Rename to `max_completion_tokens` when absent (verified accepted by GPT-4.1/4o/5.4/5-mini, Gemini, Claude); plain-text upstream errors keep their real status inside the client's error envelope. |
| `gpt-5.5` & other `/responses`-only models listed but unusable via chat | Confusing upstream errors | Model list filtered by advertised endpoint; fast 400 with the advertised endpoints named. |
| Claude Code's startup `HEAD /api/hello` got 404 | Log noise, best-effort probe | Answers 200. |
| Unused/advisory dependencies (`uuid` moderate advisory, `cors`, `fetch-event-source`) | Audit surface | Removed; `node:crypto.randomUUID`. |
| `npm run dev` unusable (ESM `.ts`), packaged CLI failed on Windows paths | Launchers broken | Fixed earlier in this series; covered by `entrypoints.test.ts`. |

## Verification performed

- `npm test` (281 passed, 1 skipped opt-in live A/B), `npm run lint`,
  `npm run typecheck`, `npm run build`.
- Live Copilot (`claude-sonnet-5`): 9 synthetic Anthropic fixtures exact
  (text, stream, forced/parallel tools, tool-result followup, Unicode, stop
  sequence, 8k-token retrieval, image); native counting 4/4 exact; adaptive
  thinking + signed continuation; real cache create/read.
- Installed Claude Code 2.1.268 (`--bare --restricted`, isolated cwd): text,
  Read-tool, streamed reasoning (167 thinking tokens) and image-Read
  workflows all produced the expected answers.
- Cursor/OpenAI relay live: GPT-5.4, GPT-4.1, Claude buffered exact; GPT-5.4
  streamed exact with `[DONE]`; forced tool call `{"a":19,"b":23}`.
- `scripts/measure-proxy-overhead.mjs`, 6 paired samples: see verdict.

## Residual limitations (honest boundaries)

1. **No comparison with `api.anthropic.com`.** Use the opt-in
   `compatibility-benchmark` with a direct key to measure that.
2. **Copilot's native Messages/count endpoints are not publicly documented by
   GitHub.** The proxy gates on the live catalog's `supported_endpoints` and
   never guesses; if GitHub withdraws them, `ANTHROPIC_UPSTREAM_MODE=chat`
   keeps working with the documented losses.
3. **Chat fallback only:** heuristic token counting can over-estimate after
   mixed workloads (`cp-runtime-token-count`), and thinking/cache semantics are
   dropped (warned or rejected).
4. **Cursor relay does not implement the `/responses` API**, so
   `/responses`-only models (e.g. `gpt-5.5`) are unavailable to Cursor.
5. **Small samples.** Latency figures are 6 paired samples on one machine and
   account; they show absence of systematic overhead, not an SLA.
6. Copilot premium-request accounting, quotas and model versions are GitHub's;
   the usage dashboard is local bookkeeping only.
