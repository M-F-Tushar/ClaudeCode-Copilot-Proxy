# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Project Overview

**GitHub Copilot Proxy for Claude Code** - An Anthropic API-compatible proxy server that enables Claude Code to use GitHub Copilot's Anthropic models (Claude Opus 4.5, Claude Sonnet, etc.) instead of direct Anthropic API access.

### Goals

1. **Primary**: Enable Claude Code to leverage GitHub Copilot's Anthropic models (Opus 4.5, Sonnet 4, etc.)
2. **API Compatibility**: Implement Anthropic's Messages API format that Claude Code expects
3. **Model Mapping**: Map Claude model names to GitHub Copilot's Anthropic model endpoints
4. **Seamless Integration**: Handle authentication, token management, and request/response translation

### Architecture

```
┌─────────────────┐     ┌──────────────────────────┐     ┌─────────────────────┐
│   Claude Code   │────▶│   Copilot Proxy Server   │────▶│  GitHub Copilot API │
│  (Anthropic API │     │                          │     │  (Anthropic Models) │
│     format)     │     │  - Auth (OAuth device)   │     │  - claude-opus-5    │
└─────────────────┘     │  - Request translation   │     │  - claude-sonnet-5  │
                        │  - Response translation  │     │  - etc.             │
                        │  - Streaming support     │     └─────────────────────┘
                        └──────────────────────────┘
```

### Key Components

| Component | Purpose | Status |
|-----------|---------|--------|
| `routes/anthropic.ts` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` | ✅ Implemented |
| `services/native-anthropic.ts` | Native Messages/counting, opaque blocks/SSE, beta headers and cache usage | ✅ Implemented |
| `services/anthropic-service.ts` | Chat fallback translation, incl. tools, images, SSE | ✅ Implemented |
| `utils/model-mapper.ts` | Claude model name → Copilot model name | ✅ Implemented |
| `services/model-catalog.ts` | Live `GET {endpoints.api}/models` catalog, cached 10 min | ✅ Implemented |
| `types/anthropic.ts` | Anthropic Messages API types | ✅ Implemented |
| `types/copilot-chat.ts` | Copilot chat-completions (OpenAI dialect) types | ✅ Implemented |
| `services/auth-service.ts` | GitHub OAuth device flow, token refresh | ✅ Implemented |
| `routes/openai.ts` | OpenAI-compatible relay for Cursor: forwards to Copilot's chat endpoint, endpoint-gated by the catalog | ✅ Implemented |
| `utils/sse-relay.ts` | Byte-exact SSE frame relay; graceful completion drains (keep-alive) instead of destroying sockets | ✅ Implemented |

### API Mappings

**Native Anthropic Messages API (preferred):**

`ANTHROPIC_UPSTREAM_MODE=auto` uses native `/v1/messages` when the account's live
catalog advertises it for the resolved Claude model. Native mode preserves all
request fields except the resolved model ID, forwards `anthropic-version` and
`anthropic-beta`, and retains response fields/SSE frames including thinking,
signatures, cache usage and nested tool-result images. Counting uses the native
`/v1/messages/count_tokens` endpoint. Native errors do not trigger chat retries.

Do not apply chat sanitization, thinking removal or heuristic context clamping
to native requests. Copilot itself validates native budgets. `native` mode
requires advertised support or a configured native endpoint; `chat` mode forces
translation. A configured chat endpoint keeps auto mode on chat.

**Anthropic Messages API → OpenAI chat fallback only:**

| Anthropic field | Copilot equivalent |
|-----------------|--------------------|
| `model` | Strict IDs/intentional family aliases by default; prefix retargeting only in compatible mode |
| `messages` | `messages` array, roles preserved |
| `system` (string or text blocks) | Leading `system` message |
| `messages` entry with `role: 'system'` | Inline `system` message, kept in place (Claude Code's `mid-conversation-system-2026-04-07` beta) |
| `content` text blocks | `content` string, or multimodal parts when images are present |
| `content` image blocks | `image_url` parts with a `data:` URI |
| `tools` | `tools` (function definitions); names sanitised to `[A-Za-z0-9_-]` |
| `tool_choice` `auto`/`any`/`none`/`tool` | `auto`/`required`/`none`/`{type:'function'}` |
| assistant `tool_use` blocks | assistant `tool_calls` |
| user `tool_result` blocks | standalone `role: 'tool'` messages placed before the user text |
| `max_tokens`, `temperature`, `top_p` | Same names |
| `stop_sequences` | Sent as `stop`, but Copilot ignores it — enforced locally instead |
| `stream` | `stream`, with SSE translated back into Anthropic events |
| `cache_control`, `thinking` | Warned/rejected in chat mode; preserved in native mode |

**Required upstream headers** (see `buildCopilotHeaders`): `Copilot-Integration-Id`,
`Editor-Version`, `Editor-Plugin-Version`, `Machine-Id`, and `Copilot-Vision-Request`
when the request contains images. Omitting `Editor-Version` fails with
`missing Editor-Version header for IDE auth`.

`X-Github-Api-Version: 2025-05-01` is validated upstream — an unrecognised value is
rejected with `invalid apiVersion`, so it cannot be changed casually.

**Endpoint**: resolved from the Copilot token's `endpoints.api`, which is
account-specific (`api.individual.githubcopilot.com` for individual plans).

**Model IDs**: Copilot serves its own Anthropic model IDs and retires them quickly;
it does *not* accept Anthropic's public names. `services/model-catalog.ts` fetches the
account's live list from `GET {endpoints.api}/models`, which drives `/v1/models`,
alias retargeting and per-model `max_tokens` clamping. `CLAUDE_MODEL_MAPPINGS` is only
the cold-start fallback used before the catalog loads.

**Chat response shape**: a tool-calling reply is split across multiple `choices` entries
(text in one, `tool_calls` in another). Never read only `choices[0]`.

### Configuration for Claude Code

1. Start the proxy server: `npm start`
2. In Claude Code settings, set:
   - **API Base URL**: `http://localhost:3000`
   - **API Key**: (handled by GitHub OAuth)
3. Authenticate via `http://localhost:3000/auth.html`

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Development Workflow

### Running the Server

```bash
npm install           # Install dependencies
npm run build         # Build TypeScript
npm run dev           # Transpile source with ts-node ESM; typecheck separately
npm start             # Production mode
```

### Testing

```bash
npm test              # Run Jest tests
npm run typecheck     # tsc --noEmit
npm run lint          # Lint code
```

Tests live next to the code they cover (`*.test.ts`) and are excluded from the build.
The translation layer is designed to be testable without network access: prefer adding
cases to `src/services/anthropic-service.test.ts` (pure converters and the
`convertCopilotStreamToAnthropicEvents` generator) over mocking `fetch`.
Native gateway contracts live in `src/routes/anthropic.native.test.ts` and use
loopback HTTP fixtures to verify opaque payload/SSE forwarding, provider counting,
usage, cancellation and retry/error semantics without real credentials.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
