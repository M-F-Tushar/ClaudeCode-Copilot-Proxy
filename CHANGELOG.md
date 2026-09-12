# Changelog

## [Unreleased]

### Added
- **Keep-alive-preserving SSE relay.** Ending a streamed response used to destroy
  the upstream socket, so every following request (Claude Code's `count_tokens`,
  the next message) paid a fresh TLS handshake (~800 ms measured). Graceful
  completion now drains the body and returns the connection to the pool; only
  client disconnects and errors cancel upstream.
- **Cursor/OpenAI relay rebuilt.** `/openai/v1/chat/completions` forwards to
  Copilot's OpenAI-compatible chat endpoint (tools, images, streaming, usage
  preserved) instead of the retired codex completions endpoint; `/openai/v1/models`
  lists the live catalog filtered to chat-capable models; `/responses`-only models
  fail fast with a clear 400; deprecated `max_tokens` is renamed to
  `max_completion_tokens` when absent.
- **Stale-while-revalidate model catalog** with failure backoff: requests never
  wait for a catalog refresh once a snapshot exists.
- **Proactive Copilot token refresh** ten minutes before expiry, off the request path.
- `HEAD /api/hello` answers Claude Code's gateway startup probe; `/health` reports the version.
- `scripts/measure-proxy-overhead.mjs` measures proxy-vs-direct-Copilot latency.
- `AUDIT.md` final audit report.
- **Native Anthropic routing.** Auto mode uses `/v1/messages` when the account's
  model catalog advertises it. Thinking/signatures, nested tool-result images,
  cache markers/usage, native SSE frames and beta/version headers are preserved.
  `ANTHROPIC_UPSTREAM_MODE=chat` retains the older translator; `native` requires
  native support. Failed native generations are never replayed in chat mode.
- **Provider token counting.** Native routing uses `/v1/messages/count_tokens`,
  removing heuristic context rejection and counting errors from that path.
  Chat-only fallback estimates remain approximate.
- Native gateway contract tests for transparent fields/frames, count requests,
  cache usage, errors, cancellation, buffer limits and body-read deadlines.
- **Live model discovery.** `GET /v1/models` now reflects the signed-in account's real
  Copilot catalog (`GET {endpoints.api}/models`, cached for 10 minutes), so every Claude
  model the plan includes is selectable from Claude Code instead of a hardcoded subset.
  The static list in `src/config/index.ts` remains as an offline/cold-start fallback.
- **Catalog-aware model resolution.** Any live model ID is forwarded verbatim, and an
  alias whose mapped target is not in the account's catalog is retargeted to the newest
  live model of the same family instead of failing with `model_not_supported`.
- **Per-model chat output limits.** Chat-mode `max_tokens` is clamped to the model's published
  `max_output_tokens` when it is lower than `MAX_OUTPUT_TOKENS`.
- `EXPOSE_ALL_COPILOT_MODELS` to also advertise non-Claude models (GPT, Gemini).
- **Tool calling** for Claude Code: Anthropic `tools` / `tool_choice` are translated to
  Copilot function tools, `tool_use` blocks to `tool_calls`, and `tool_result` blocks
  to standalone `tool` messages in the order the upstream API expects.
- **Real SSE streaming**: upstream Copilot events are converted to Anthropic events as
  they arrive, including streamed tool-call arguments as `input_json_delta`.
- **Image support**: `base64` and `url` image blocks become data URIs and set the
  `Copilot-Vision-Request` header.
- Support for the block-array form of `system` that Claude Code sends.
- Pass-through of `temperature` and `top_p`, and local enforcement of `stop_sequences`.
- `GET /v1/models/:model`, and `GET /v1/models` now returns Anthropic's pagination envelope.
- `src/types/copilot-chat.ts` describing Copilot's chat-completions dialect.
- Configurable Copilot endpoint, client identity headers, default model, output-token
  ceiling and upstream streaming toggle.
- Unit and route tests for the translation layer, streaming, model mapping and auth errors.
- `npm run typecheck` and `npm run lint:fix` scripts.

### Fixed
- **Stale Copilot model identifiers.** Every mapped Claude model except
  `claude-haiku-4.5` had been retired upstream and returned
  `400 model_not_supported`. Verified against a live account and remapped onto
  `claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4.5`.
- **Tool calls were silently dropped in non-streaming responses.** Copilot splits a
  reply across several `choices` entries (text in one, `tool_calls` in another) and
  only `choices[0]` was read, which stalled Claude Code's agent loop. All choices are
  now merged into a single Anthropic message.
- **`stop_sequences` were ignored.** Copilot accepts the `stop` parameter but does not
  act on it, so sequences are now enforced locally in both the buffered and streaming
  paths, including sequences split across chunk boundaries, and reported as
  `stop_reason: "stop_sequence"`.
- **Hardcoded chat endpoint.** The account-specific host advertised by the Copilot token
  (e.g. `api.individual.githubcopilot.com`) is now used, with `COPILOT_CHAT_ENDPOINT`
  left as an explicit override.
- **Missing `Copilot-Integration-Id` header**, which caused the Copilot chat endpoint to
  reject requests.
- **Rate limiter compared the cumulative request count** against the per-minute limit,
  permanently rate-limiting long-running Claude Code sessions. It now uses a sliding
  one-minute window.
- Per-request and per-minute token ceilings rejected normal Claude Code contexts; they
  are now opt-in and disabled by default.
- Rate-limit errors on Anthropic routes are returned in the Anthropic error envelope.
- Authentication middleware returned 401 without attempting a token refresh; refreshes
  are now attempted and de-duplicated across concurrent requests.
- Upstream errors are surfaced with their original status code and matching Anthropic
  error type instead of a blanket 500.
- Non-text content (tool calls, images) is no longer silently dropped when converting
  requests.
- Persisted token files are written with owner-only permissions.
- Cursor IDE base URL documented as `/openai/v1`, matching where the routes are mounted.

### Changed
- Plain-text upstream errors (Copilot answers some 4xx as `text/plain`) keep their
  real status inside the Anthropic/OpenAI error envelope instead of becoming 502s.
- Dependencies `uuid`, `cors` and `@microsoft/fetch-event-source` removed
  (`node:crypto.randomUUID` replaces `uuid`); `npm audit --omit=dev` is clean.
- Native mode leaves output/context budget validation to the provider.
  `MAX_OUTPUT_TOKENS`, `UNSUPPORTED_FEATURES` and `ENABLE_UPSTREAM_STREAMING`
  retain their existing meaning for the chat fallback only.
- Development startup uses the transpile-only ESM loader to avoid slow inline
  ts-node type-checking; the separate `typecheck` and build quality gates remain.
- Minimum supported Node.js version is now 20; CI runs on Node 20 and 22 and the Docker
  image is based on Node 22.
- Model mapping resolves the longest matching prefix and falls back to
  `DEFAULT_CLAUDE_MODEL` for unknown Claude identifiers.
- `count_tokens` estimates from all content blocks and tool schemas rather than text only.

## [v0.1.0] - 2025-03-24

### Added
- Initial release of GitHub Copilot Proxy
- OAuth Device Flow Authentication with GitHub
- OpenAI-Compatible API endpoints (`/v1/models` and `/v1/chat/completions`)
- Token management with automatic refresh and validation
- Streaming support for real-time completions
- Rate limiting based on requests and token usage
- Usage monitoring and metrics dashboard
- Web-based authentication UI
- Environment variable configuration with Zod validation
- Enhanced .gitignore with additional standard entries
