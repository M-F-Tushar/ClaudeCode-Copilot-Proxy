# GitHub Copilot Proxy for Claude Code & Cursor IDE

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.0+-green.svg)](https://nodejs.org/)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)

> ⚠️ **Disclaimer**: This project is for **educational purposes only**. It demonstrates API proxy patterns and OAuth device flow authentication. Use at your own risk and ensure compliance with GitHub Copilot's Terms of Service.

An **Anthropic Messages API-compatible** proxy that lets **Claude Code** run on your **GitHub Copilot** subscription (Pro, Pro+, Business, Enterprise). It also exposes an OpenAI-compatible surface for **Cursor IDE**.

## ✨ What works

The proxy prefers Copilot's **native Anthropic Messages API** when the account's
live catalog advertises it. The older OpenAI chat translator remains a fallback.
It does **not** promise the same model build, reasoning quality, caching, quotas,
or latency as `api.anthropic.com`.

| Capability | Status | Notes |
|---|---|---|
| `POST /v1/messages` (buffered) | ✅ | Native payload/response fields preserved; translation only in chat mode |
| `POST /v1/messages` (streaming) | ✅ | Native SSE frames forwarded, including thinking/signature and future deltas |
| **Tool calling** | ✅ | Native tool definitions, IDs, inputs, choices, and history retained |
| **Streamed tool calls** | ✅ | Native lifecycle retained; chat fallback serializes interleaved tool fragments |
| **Images** | ✅ | Native image blocks, including nested tool-result images, are preserved |
| **System prompts** | ✅ | Native strings, blocks, and cache boundaries preserved |
| Sampling parameters | ✅ | Native request values forwarded without heuristic budget changes |
| `POST /v1/messages/count_tokens` | ✅ | Provider counting in native mode; labelled local estimate in chat mode |
| `GET /v1/models`, `GET /v1/models/:model` | ✅ | Anthropic pagination envelope |
| Error semantics | ✅ | Upstream status codes and Anthropic error types are preserved |
| Prompt caching (`cache_control`) | ✅ | Native markers and cache usage retained; eligibility remains upstream-controlled |
| Extended thinking | ✅ | Native configuration, thinking blocks, and signatures retained |

### Fidelity and reliability controls

- **No silent version substitution by default.** `MODEL_SELECTION=strict` accepts
  available Copilot IDs and intentional family aliases. Unavailable dated/versioned
  IDs fail rather than selecting a different generation. Responses report the
  upstream model ID (or the resolved request ID if upstream omits it).
- **Native first, not guessed.** `ANTHROPIC_UPSTREAM_MODE=auto` selects native
  routing only for Claude models advertising `/v1/messages`. `native` requires
  support (or an explicit native endpoint); `chat` opts into translation.
  A pinned `COPILOT_CHAT_ENDPOINT` retains chat routing in auto mode. Failed native
  generations are never silently replayed through the translator.
- **Native semantics stay native.** Only the resolved model identifier changes
  in the request. Thinking, signatures, tools, images, cache markers, output
  configuration and unknown future fields are preserved. `anthropic-version`
  and `anthropic-beta` reach upstream; inbound client credentials do not.
  Native output/context limits are enforced by the provider, not by a local
  heuristic that can prematurely reject valid requests.
- **Chat fallback losses are explicit.** In chat mode, `X-Proxy-Warnings` reports
  discarded thinking/cache controls and other translation losses;
  `UNSUPPORTED_FEATURES=reject` refuses these requests. These restrictions do not
  disable features that the native API can handle.
- **Model and token behavior is observable.** `X-Proxy-Resolved-Model` identifies
  the routed model, `X-Proxy-Actual-Model` reports the upstream response model,
  `X-Proxy-Transport` identifies `native` or `chat`, and `X-Proxy-Token-Count`
  identifies `upstream`, `heuristic`, or `calibrated` counting.
- **Streaming stays incremental.** Native frames are not reconstructed or
  rewritten. Chat translation may buffer parallel tools to maintain valid block
  ordering. Both paths bound buffering and reject interrupted streams instead
  of inventing tool arguments or a successful final event.
- **Bounded requests.** Upstream deadlines include response bodies; disconnected
  clients cancel active generation, and SSE writes respect slow-client backpressure.
  Retries default to **off** to avoid duplicate premium usage. Opt-in retries apply
  only to explicit 429/502/503/504 responses, never a partially delivered stream.
- **Provider counting replaces guesses where available.** Native counting calls
  Copilot's `/v1/messages/count_tokens` rather than estimating locally. Native
  cache-read/creation usage fields reach Claude Code unchanged. Chat estimates
  remain approximate and can be substantially wrong after mixed workloads.
  The dashboard counts cache tokens as input but is not a premium-request,
  quota, or billing ledger.

For reproducible model comparisons, choose a concrete ID from `/v1/models`, not
`sonnet`/`opus`/`haiku` aliases, and use the opt-in benchmark below. Even matching
model labels cannot establish identical serving configurations.

### Alignment with official Claude Code and the installed client

The [official Claude Code repository](https://github.com/anthropics/claude-code)
contains distribution/support material, releases, plugins and examples, not a
complete open-source checkout of the installed CLI. Compatibility is based on
the [official gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol),
the [Messages streaming contract](https://platform.claude.com/docs/en/build-with-claude/streaming),
and direct testing of the installed client, rather than transplanting CLI code.
Microsoft's [Copilot Chat implementation](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/chatEndpoint.ts)
also selects native Messages based on advertised model capabilities. This is
implementation evidence, not a stable public GitHub API availability guarantee.

The 2026-09-12 comparison used installed **Claude Code 2.1.268** and
`claude-sonnet-5`. Public Claude Code `main` had already reached 2.1.269; settings
introduced there must not be assumed to work in 2.1.268. Keep the local client
version and chosen model fixed for comparisons. Follow the official
[gateway connection](https://code.claude.com/docs/en/llm-gateway-connect) and
[model configuration](https://code.claude.com/docs/en/model-config) guidance:
`ANTHROPIC_BASE_URL` changes the destination, not the model or its context limit.
Use a real catalog ID and do not claim 1M context from a model label alone.

| Area | Earlier chat-only route | Native route observed on the tested account |
|---|---|---|
| Prompt/history structure | Flattened/reordered content | Native JSON retained except explicit model resolution |
| Thinking | Removed | Real thinking/signature returned; signed-history continuation succeeded |
| Image tool results | Omitted from tool messages | Installed Claude Code read a synthetic PNG and answered its color |
| Cache semantics | Markers discarded | 11,013 cache-creation tokens followed by 11,013 cache-read tokens |
| Large-context count | 14,830 estimated vs 8,028 upstream | 8,028 returned unchanged; code, Unicode and tool counts also matched |
| Installed client | Basic text/Read checks | Text, Read, streamed reasoning and image-Read workflows succeeded |
| Same-backend text latency | No native-route comparison | Two paired trials added 29 ms and 36 ms versus direct Copilot native |

These observations are **not comparisons against `api.anthropic.com`**: a direct
Anthropic API key was unavailable. The timing sample is too small for a latency
guarantee. Provider token counting is itself an estimate, as described in the
[token-counting documentation](https://platform.claude.com/docs/en/build-with-claude/token-counting).
One reasoning response used markdown around the correct numeric answer; it was
preserved, not silently reformatted. Native forwarding reduces proxy-induced
differences but cannot make model serving, quotas, output randomness or billing
identical between GitHub and Anthropic.

Native counting availability is separate from Messages support. Successful
counts are labelled `upstream`; counting errors remain upstream errors rather
than becoming apparently authoritative local estimates. The explicit chat
fallback still has the documented heuristic-counting and feature limitations.

## 📖 Contents

**New here?** Read [Getting started](#-getting-started) — it covers everything
from installing Node.js to your first Claude Code session.

- [Getting started](#-getting-started) — the full step-by-step walkthrough
- [Install without cloning](#-alternative-install-without-cloning)
- [Claude Code configuration reference](#-claude-code-configuration-reference) — models, cost tuning
- [Configuration with Cursor IDE](#-configuration-with-cursor-ide)
- [How it works](#-how-it-works) — architecture, endpoints, project layout
- [Configuration reference](#️-configuration-reference) — environment variables
- [Docker](#-docker) · [Development](#️-development) · [Troubleshooting](#-troubleshooting)

## 🚀 Getting started

This walkthrough assumes **no prior knowledge** of the project. Follow it top to
bottom and you will have Claude Code running on your Copilot subscription. It
takes about five minutes.

> Every command below is typed into a terminal: **Terminal** on macOS/Linux, or
> **PowerShell** on Windows.

### Step 1 — Check what you need

| Requirement | Why | Check it |
|---|---|---|
| **Node.js 20 or newer** | Runs the proxy | `node --version` |
| **Git** | Clones the repository | `git --version` |
| **A GitHub Copilot subscription** | Provides the Claude models | Pro, Pro+, Business or Enterprise |
| **Claude Code** | The client you'll be using | `claude --version` |

Each of those commands should print a version number. If any of them says
`command not found`, install the missing tool:

- **Node.js** — download the LTS installer from [nodejs.org](https://nodejs.org/),
  or use a version manager:
  ```bash
  # macOS (Homebrew)
  brew install node

  # Windows (winget)
  winget install OpenJS.NodeJS.LTS

  # Linux / macOS (nvm — recommended if you juggle Node versions)
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  nvm install 20
  ```
  If `node --version` prints something lower than `v20`, upgrade — the proxy
  will not start on older versions.

- **Claude Code** — install it globally:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

You do **not** need an Anthropic API key or an Anthropic account. That is the
entire point of this proxy.

### Step 2 — Get the code

```bash
git clone https://github.com/shyamsridhar123/ClaudeCode-Copilot-Proxy.git
cd ClaudeCode-Copilot-Proxy
```

Stay in this folder for the next three steps.

### Step 3 — Install dependencies

```bash
npm install
```

This downloads the libraries into a `node_modules/` folder. It only needs to be
done once (and again after you pull updates). Warnings about deprecated
sub-dependencies are normal; errors are not.

### Step 4 — Build it

```bash
npm run build
```

The project is written in TypeScript, which browsers and Node cannot run
directly. This step compiles `src/` into plain JavaScript in `dist/`. **If you
skip this, `npm start` will fail with "Cannot find module".**

### Step 5 — Start the proxy

```bash
npm start
```

You should see:

```
info: Server running at http://localhost:3000/
info: Press CTRL-C to stop the server
```

**Leave this terminal window open.** The proxy has to keep running for Claude
Code to work — closing it or pressing `Ctrl-C` stops everything. From here on,
open a **second** terminal window for the remaining commands.

### Step 6 — Sign in with GitHub

Open <http://localhost:3000> in your browser. You will land on the
authentication page.

1. Click **Sign in with GitHub**.
2. The page shows an **8-character code** (like `A1B2-C3D4`) and a link to
   <https://github.com/login/device>.
3. Open that link, paste the code, and approve the request.
4. Return to the proxy tab — it polls automatically and switches to
   **Authenticated** within a few seconds.

Your tokens are cached in `~/.github-copilot-proxy/` with owner-only
permissions and refreshed automatically before they expire, so **this is a
one-time step**. It survives restarts and reboots.

> Nothing is sent to Anthropic, and no password is shared with this project —
> GitHub's device flow hands back a scoped token directly.

### Step 7 — Confirm the proxy is healthy

Before wiring up Claude Code, check the proxy process. In your second
terminal:

```bash
curl http://localhost:3000/health
```

Expected:

```json
{"status":"healthy","version":"0.1.0"}
```

`/health` is a process liveness check, **not** an authentication or upstream
availability probe. Now check the cached model catalog:

```bash
curl -s http://localhost:3000/v1/models
```

You should see entries such as `claude-opus-5`, `claude-sonnet-5` and
`claude-haiku-4.5`. If instead you get:

```json
{"type":"error","error":{"type":"authentication_error","message":"GitHub Copilot authentication required..."}}
```

then Step 6 did not complete — go back and finish the GitHub sign-in.

Finally, send a real message through Copilot:

```bash
curl -s http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"sonnet","max_tokens":64,"messages":[{"role":"user","content":"Say hello in five words."}]}'
```

A JSON reply containing a `"text"` block means the whole chain — proxy, GitHub
auth, Copilot — worked for this request. It does not establish compatibility for
every model, large context, or tool workflow.

<details>
<summary>Windows PowerShell versions of the commands above</summary>

PowerShell aliases `curl` to `Invoke-WebRequest`, which uses different syntax.
Use `curl.exe` explicitly, or:

```powershell
Invoke-RestMethod http://localhost:3000/health

Invoke-RestMethod http://localhost:3000/v1/messages `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"model":"sonnet","max_tokens":64,"messages":[{"role":"user","content":"Say hello in five words."}]}'
```

</details>

### Step 8 — Point Claude Code at the proxy

Claude Code reads settings from a JSON file. Create or edit one of these:

| Scope | Path |
|---|---|
| **This project only** | `.claude/settings.local.json` inside your project folder |
| **Everything you do** (recommended) | `~/.claude/settings.json` — on Windows, `%USERPROFILE%\.claude\settings.json` |

Put this in it:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
    "ANTHROPIC_MODEL": "sonnet",
    "ANTHROPIC_SMALL_FAST_MODEL": "haiku",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1"
  }
}
```

What each line does:

- `ANTHROPIC_BASE_URL` — sends Claude Code to your proxy instead of Anthropic. **This is the key setting.**
- `ANTHROPIC_AUTH_TOKEN` — use the same secret as the server's `PROXY_AUTH_TOKEN`
  when configured. The `sk-dummy` placeholder works only on a tokenless loopback
  instance; it is not an access credential for a protected proxy.
- `ANTHROPIC_MODEL` — your everyday model. `sonnet` is the best balance of cost and capability.
- `ANTHROPIC_SMALL_FAST_MODEL` — the cheap model for background chores like conversation titles.
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` — makes Claude Code call `GET /v1/models` on the proxy and list every model your Copilot plan can reach in `/model`. Without it the picker only ever offers the three alias slots (opus/sonnet/haiku).
- `DISABLE_NON_ESSENTIAL_MODEL_CALLS` — suppresses background chores such as conversation titles, which directly reduces premium-request usage. It does **not** interfere with model discovery.

> **Do not set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.** It silently disables the
> `GET /v1/models` discovery call, so `/model` will never show more than the three
> alias slots. Claude Code logs `[Bootstrap] Skipped: Nonessential traffic disabled`
> when this happens.

### Seeing every model in `/model`

With discovery enabled, Claude Code caches the proxy's catalog in
`~/.claude/cache/gateway-models.json` and adds one `From gateway` entry per model.
Two things commonly hide them:

- **An `availableModels` allowlist** in `settings.json` filters the picker. Because it
  matches literal model IDs, a list such as `["default","opus","sonnet","haiku"]`
  removes every discovered model. Omit the key entirely unless you deliberately want
  to restrict the list — it would otherwise need editing each time Copilot retires an ID.
- **The cached `baseUrl` must match `ANTHROPIC_BASE_URL` exactly**, trailing slash
  included, or the cache is ignored.

Discovery is asynchronous and cache-backed, so the *first* run after enabling it may
still show the old picker; the models appear on the next run.

Some newer models (currently the Fable family) are gated by GitHub Copilot on the
Claude Code version, which it reads from the `cc_version=...` billing header Claude
Code puts in its system prompt. If a model returns
`Claude Code <version> does not support this model`, run `claude update`.

If the folder does not exist yet, create it first:

```bash
mkdir -p ~/.claude          # macOS / Linux
```
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude"   # Windows
```

### Step 9 — Run Claude Code

With the proxy still running in the first terminal, go to any project folder and
start Claude Code:

```bash
cd ~/some-project
claude
```

Ask it something that touches your files, for example *"what does this
repository do?"*. Watch the proxy's terminal — you should see lines like:

```
info: POST /v1/messages - 200 - 1423ms
```

That is your Copilot subscription answering. **You're done.**

### Everyday use after setup

You never repeat Steps 1–4 or Step 6. A normal session is just:

```bash
# Terminal 1 — start the proxy, leave it running
cd ClaudeCode-Copilot-Proxy && npm start

# Terminal 2 — work as usual
claude
```

**Updating to a newer version:**

```bash
cd ClaudeCode-Copilot-Proxy
git pull
npm install
npm run build      # don't forget this — stale dist/ causes confusing bugs
npm start
```

**Stopping:** press `Ctrl-C` in the proxy terminal.

**Signing out:** delete `~/.github-copilot-proxy/`, or use the sign-out button
on the auth page.

### First-run problems

| What you see | What it means |
|---|---|
| `Cannot find module '.../dist/index.js'` | You skipped `npm run build` (Step 4). |
| `EADDRINUSE: address already in use :::3000` | Something else owns port 3000 — often a second copy of this proxy. Stop it, or start with `PORT=3001 npm start` and update `ANTHROPIC_BASE_URL` to match. |
| Claude Code still asks you to log in to Anthropic | Your settings file is not being read. Check the filename spelling exactly, and that the JSON has no trailing commas. |
| `Connection refused` from Claude Code | The proxy is not running. Restart it in Terminal 1. |
| Browser shows the code but never says *Authenticated* | The device code expired (they are short-lived). Click **Sign in with GitHub** again for a fresh code. |
| `command not found: claude` | Claude Code is not installed — see Step 1. |
| Everything works but answers seem to come from the wrong model | Run `/model` inside Claude Code to see what it selected, and check the mapping table below. |

Still stuck? Restart the proxy with debug logging and read what it reports for
each request:

```bash
LOG_LEVEL=debug npm start
```

## 📦 Alternative: install without cloning

If you would rather not keep a source checkout, install the published package
globally. Steps 6–9 above still apply.

```bash
npm install -g claudecode-copilot-proxy
claudecode-copilot-proxy
```

The server starts at http://localhost:3000, and there is no build step.

The published npm package may lag this checkout. The version number alone does
not prove it includes these improvements; build from source to use the audited
changes until a release containing them is published.

## 🤖 Claude Code configuration reference

The settings file from Step 8 is the minimum. Everything below is optional
tuning.

### Verifying it works

- The server log shows `POST /v1/messages - 200 - <duration>ms`.
- The log line `Requesting Copilot chat completion` reports the mapped model, e.g. `claude-sonnet-5`.
- Token usage is visible at http://localhost:3000/usage.html.
- Editing files, running Bash, and other tool-driven workflows complete normally — that exercises the tool-calling path.

### Supported models

`GET /v1/models` is answered from your **live Copilot catalog** — the proxy calls
Copilot's own `/models` endpoint with your token and advertises every Claude
model your plan can actually serve (Pro+ accounts see the full Opus / Sonnet /
Haiku range), refreshing it every 10 minutes. A static fallback is used before the
first successful fetch, and the last good snapshot survives temporary failures.
Catalog entries are not a guarantee of current upstream availability.

```bash
curl -s http://localhost:3000/v1/models | jq '.data[].id'
```

Pick any of those IDs inside Claude Code:

```
/model claude-opus-4.8
```

If your Claude Code build lists provider models in the `/model` picker, it will
show exactly this list. Older builds show Anthropic's built-in presets instead —
typing the ID after `/model`, or setting `ANTHROPIC_MODEL`, works either way.

GitHub Copilot uses its own IDs. By default, concrete IDs must be available
without substitution; public dated names such as `claude-sonnet-4-5-20250929`
are rejected unless offered verbatim. Short `sonnet` / `opus` / `haiku` /
`opusplan` aliases deliberately select a moving model of that family.

For legacy behavior, explicitly set `MODEL_SELECTION=compatible`. **Only in this
opt-in mode** do older names use cross-version mappings such as:

| Claude Code model | Copilot model |
|---|---|
| `claude-opus-4-5*`, `claude-opus-4-1*`, `opus`, `opusplan` | `claude-opus-5` |
| `claude-sonnet-4-5*`, `claude-sonnet-4*`, `sonnet` | `claude-sonnet-5` |
| `claude-haiku-4-5*`, `claude-3-5-haiku*`, `haiku` | `claude-haiku-4.5` |
| `claude-3-7-sonnet*`, `claude-3-5-sonnet*` | `claude-sonnet-5` |

In compatible mode these are only defaults. Any ID present in your live catalog is forwarded
verbatim, and if a mapped target is *not* in your catalog the request is
retargeted to the newest live model of the same family (Opus → newest Opus,
Sonnet → newest Sonnet, ...). Unrecognised `claude-*` identifiers fall back to
`DEFAULT_CLAUDE_MODEL`, so a model rename will not break your session.

Set `EXPOSE_ALL_COPILOT_MODELS=true` to also advertise the non-Claude models
(GPT, Gemini) your plan includes.

### Getting the most from a Copilot Pro+ plan

GitHub bills Copilot usage in **premium requests**, and each model carries a multiplier. A few settings make a large difference:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
    "ANTHROPIC_MODEL": "sonnet",
    "ANTHROPIC_SMALL_FAST_MODEL": "haiku",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

- Use **Sonnet** as the main model and reserve **Opus** for hard problems (`/model opus`) — Opus costs several times more per request.
- Keep a cheap model for Claude Code's background work (conversation summaries, titles) via `ANTHROPIC_SMALL_FAST_MODEL`.
- Native `count_tokens` uses the provider's counting endpoint without requesting
  generation; chat mode uses a local estimate. Counting latency includes an
  upstream round trip in native mode.
- Use `/compact` and `/clear` regularly: fewer, larger turns cost less than many small ones, because billing is per request rather than per token.

### Optional: GPT and Gemini models

Any other model your Copilot plan exposes is passed through untouched:

```json
{ "env": { "ANTHROPIC_MODEL": "gpt-5.5" } }
```

## 🔌 Configuration with Cursor IDE

Cursor speaks the OpenAI API rather than Anthropic's, so it uses a different
base URL on the same running proxy.

Requests are relayed to Copilot's own OpenAI-compatible chat endpoint with only
the model resolved and Copilot identity headers added; tools, images, streaming
frames and usage pass through unchanged. `GET /openai/v1/models` lists every
model Copilot serves through that endpoint (GPT-4.1/5.4, Gemini, Claude, ...).
Models Copilot serves only through its `/responses` API (for example `gpt-5.5`)
are omitted and rejected with a clear 400 before any request is spent. The
deprecated `max_tokens` field is renamed to `max_completion_tokens` when the
modern field is absent, because Copilot rejects the old one for GPT-5.x
(`X-Proxy-Warnings: max_tokens_renamed`).

1. Complete Steps 1–6 above so the proxy is running and authenticated.
2. Open Cursor IDE → **Settings** → **API Keys**.
3. Enable **Override OpenAI Base URL** and set it to
   `http://localhost:3000/openai/v1` — note the `/openai/v1` suffix, which is
   where these routes are mounted.
4. Enter the server's `PROXY_AUTH_TOKEN` as the API key if configured; a placeholder
   works only on a tokenless loopback instance.

To switch back to normal Cursor behaviour, turn off the base URL override.

## 🤔 How it works

```
┌─────────────────┐     ┌────────────────────────────┐     ┌──────────────────────┐
│   Claude Code   │────▶│    Copilot Proxy Server    │────▶│  GitHub Copilot API  │
│ (Anthropic API) │     │                            │     │ (native + chat APIs) │
│                 │◀────│  • OAuth device flow       │◀────│  • claude-opus-5     │
└─────────────────┘ SSE │  • Native Messages         │ SSE │  • claude-sonnet-5   │
                        │  • Chat fallback           │     │  • claude-haiku-4.5  │
                        │  • SSE ⇄ SSE               │     └──────────────────────┘
                        └────────────────────────────┘
```

1. The proxy runs the GitHub OAuth device flow and exchanges the GitHub token for a Copilot token, refreshing it before expiry.
2. Claude Code posts Anthropic Messages API requests to `/v1/messages`.
3. The live catalog determines whether the resolved model advertises native `/v1/messages`. `native-anthropic.ts` forwards that protocol with only model resolution and Copilot authentication/identity headers changed.
4. Native response fields and SSE frames are preserved, including thinking/signatures and cache accounting. Otherwise `anthropic-service.ts` performs the documented, explicitly lossy chat-completions translation.
5. Native failures preserve HTTP status, error body, request IDs and retry guidance. A native failure never automatically triggers a second generation using chat mode.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/messages` | Anthropic Messages API (also at `/anthropic/v1/messages`) |
| `POST /v1/messages/count_tokens` | Native provider count or labelled chat-mode estimate |
| `GET /v1/models`, `GET /v1/models/:model` | Model discovery |
| `POST /openai/v1/chat/completions` | OpenAI-compatible surface for Cursor |
| `GET /health` | Health check |
| `GET /auth.html`, `GET /usage.html` | Authentication portal and usage dashboard |
| `POST /auth/login`, `/auth/check`, `/auth/logout`, `GET /auth/status` | Device-flow control |

### Project layout

```
src/
├── config/       Environment parsing, model mappings, endpoints
├── middleware/   Rate limiting, request logging, error handling
├── public/       Auth portal and usage dashboard
├── routes/       anthropic.ts (Claude Code), openai.ts (Cursor), auth.ts, usage.ts
├── services/     native-anthropic.ts, anthropic-service.ts (chat translation), auth-service.ts
├── types/        anthropic.ts, copilot-chat.ts, openai.ts, github.ts
└── utils/        model-mapper.ts, logger.ts, machine-id.ts
```

## ⚙️ Configuration reference

All settings are optional; see [`.env.example`](.env.example) for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `localhost` | Listen address |
| `PROXY_AUTH_TOKEN` | unset | Shared inbound secret, at least 16 characters; mandatory off loopback |
| `PROXY_ALLOWED_ORIGINS` | unset | Additional exact browser origins, comma-separated; requires authenticated access |
| `JSON_BODY_LIMIT` | `10mb` | Maximum parsed JSON body; raise deliberately for larger images/contexts |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `COPILOT_CHAT_ENDPOINT` | *(from your Copilot token)* | Pin a GitHub Enterprise host or corporate proxy. Leave unset to use the account-specific host GitHub advertises, e.g. `api.individual.githubcopilot.com`. |
| `COPILOT_MESSAGES_ENDPOINT` | *(from your Copilot token)* | Explicit native Messages URL, including `/v1/messages`; counts use its `/count_tokens` subpath |
| `COPILOT_INTEGRATION_ID` | `vscode-chat` | Client identity required by Copilot |
| `COPILOT_EDITOR_VERSION` / `COPILOT_PLUGIN_VERSION` / `COPILOT_USER_AGENT` | vscode defaults | Client identity headers |
| `DEFAULT_CLAUDE_MODEL` | `claude-sonnet-5` | Fallback for unknown Claude models in compatible mode |
| `MODEL_SELECTION` | `strict` | Reject version substitutions; `compatible` opts into legacy alias retargeting |
| `ANTHROPIC_UPSTREAM_MODE` | `auto` | Prefer advertised native Messages; `native` requires it, `chat` forces the legacy translator |
| `UNSUPPORTED_FEATURES` | `warn` | In chat mode, warn or `reject` requests requiring unpreservable semantics |
| `EXPOSE_ALL_COPILOT_MODELS` | `false` | Also advertise non-Claude models (GPT, Gemini) on `/v1/models` |
| `MAX_OUTPUT_TOKENS` | `64000` | Chat-mode output ceiling; native mode forwards the original budget for provider validation |
| `ENABLE_UPSTREAM_STREAMING` | `true` | Chat-mode streaming toggle; native mode preserves the client's `stream` value |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Per-fetch deadline through body consumption, including retries |
| `UPSTREAM_MAX_RETRIES` | `0` | Opt-in bounded retries for explicit transient HTTP failures (maximum 3) |
| `UPSTREAM_SAFE_GET_RETRIES` | `2` | Retries for idempotent Copilot token/catalog GETs |
| `UPSTREAM_MAX_RETRY_DELAY_MS` | `10000` | Maximum retry wait; longer `Retry-After` values are passed back instead |
| `RATE_LIMIT_DEFAULT` / `RATE_LIMIT_CHAT_COMPLETIONS` | `600` / `300` | Requests per minute (`0` disables) |
| `MAX_TOKENS_PER_REQUEST` / `MAX_TOKENS_PER_MINUTE` | `0` | Optional token ceilings (`0` disables) |

## 🐳 Docker

Keep the published port loopback-only. The container binds to all interfaces
internally, so it requires a real `PROXY_AUTH_TOKEN` even with this port mapping:

```bash
docker build -t claudecode-copilot-proxy .
export PROXY_AUTH_TOKEN="$(openssl rand -hex 32)"
docker run -p 127.0.0.1:3000:3000 -e PROXY_AUTH_TOKEN \
  -v copilot-proxy-auth:/home/node/.github-copilot-proxy claudecode-copilot-proxy
```

Keep this secret securely for reuse and set Claude Code's `ANTHROPIC_AUTH_TOKEN`
to the same value. Enter it on the authentication/usage pages when prompted.
The pages keep it only in memory, not in URLs or browser storage.
The named volume preserves authentication across container restarts. The image
runs as the unprivileged `node` user; old root-owned bind mounts need ownership
adjustments.

### Network access

API, authentication-control, and usage operations require the configured secret.
Foreign browser origins and untrusted Host headers are rejected even on a
tokenless localhost instance. Same-origin auth/usage pages remain usable; CORS is
not wildcard-enabled. For a trusted HTTPS reverse proxy, configure the exact
public origin in `PROXY_ALLOWED_ORIGINS` and preserve its Host header.
Do not expose the raw HTTP server publicly: inbound authentication is not TLS,
per-user isolation, or a production security guarantee.

## 🛠️ Development

```bash
npm run dev        # Run source with the fast ts-node ESM transpiler
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint
npm test           # Jest
npm run build      # Compile to dist/
```

`npm run dev` runs directly from source without ts-node's startup type-checking;
run `npm run typecheck` separately (CI still requires it). Restart after edits. The packaged
`claudecode-copilot-proxy start` command runs the compiled `dist` entrypoint
and supports native Windows paths.

### Checking compatibility against direct Anthropic

Offline benchmark-parser checks run with `npm test`; live comparisons are opt-in
and consume both direct API and Copilot quota. With the proxy running and
authenticated, set these variables in PowerShell:

```powershell
# Supply ANTHROPIC_API_KEY and PROXY_AUTH_TOKEN securely, outside source control.
$env:RUN_COMPATIBILITY_BENCHMARK = 'true'
$env:BENCHMARK_PROXY_URL = 'http://localhost:3000'
$env:BENCHMARK_ANTHROPIC_MODEL = '<exact-direct-Anthropic-model-ID>'
$env:BENCHMARK_PROXY_MODEL = '<exact-ID-from-the-proxy-model-list>'
$env:BENCHMARK_SAMPLES = '1'
$env:BENCHMARK_TIMEOUT_MS = '30000'
node --experimental-vm-modules .\node_modules\jest\bin\jest.js --runInBand compatibility-benchmark
```

Inspect the emitted JSON, not just Jest's exit status: live task mismatches are
reported rather than asserted. The report separates contract/task success from
first-fragment and total latency. Synthetic expected-output matches do not
establish general coding quality, thinking/cache parity, or identical models.
The OpenAI/Cursor relay is not covered by the Anthropic A/B comparison.

### Measuring the proxy's own overhead

Without a direct Anthropic key you can still measure what the proxy adds on top
of Copilot's native endpoint (same account, model and prompts):

```powershell
npm run build
$env:PROXY_URL = 'http://localhost:3000'   # set PROXY_AUTH_TOKEN too if configured
$env:SAMPLES = '6'
node scripts/measure-proxy-overhead.mjs
```

It reports p50/mean totals for `count_tokens`, buffered and streamed messages
on both paths plus the paired difference, and prints timings only. The
2026-09-12 run (6 paired samples, `claude-sonnet-5`) measured paired p50
overheads of −105 ms, −36 ms and +17 ms respectively — within network jitter.
Before the keep-alive fix in this release, every request following a streamed
message paid a fresh TLS handshake (~800 ms); that is what the script exists to
catch.

See [`AUDIT.md`](AUDIT.md) for the full audit trail: original findings,
what changed, measurements and residual limitations.

## 🩺 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401 authentication_error` | Missing/wrong proxy secret, or GitHub sign-in is unavailable/revoked. Check `PROXY_AUTH_TOKEN` first, then authenticate at http://localhost:3000. |
| `400` unavailable model | Strict selection prevented a version substitution. Select a concrete `/v1/models` ID or intentional family alias. |
| `400` unsupported semantics | Remove the reported options or explicitly select best-effort `UNSUPPORTED_FEATURES=warn`. |
| `403 permission_error` | Your Copilot plan does not include the requested model. Pick another with `/model`. |
| `429 rate_limit_error` | You hit the proxy's request limit or Copilot's. Raise `RATE_LIMIT_*` or wait for the `Retry-After` window. |
| `404 not_found_error` on a model | The model is not offered by Copilot. Check `GET /v1/models`. |
| Tools never fire | Confirm you are on this version: earlier releases dropped `tools` entirely. `npm run build` after pulling. |
| Streaming looks buffered | A corporate proxy is buffering SSE. Set `ENABLE_UPSTREAM_STREAMING=false` as a fallback. |
| `413` request too large | Raise `JSON_BODY_LIMIT` only as needed; the default is 10 MB. |
| `504` upstream timeout | Upstream did not complete within the deadline; inspect connectivity or deliberately increase `UPSTREAM_TIMEOUT_MS`. |

Run with `LOG_LEVEL=debug` to see the mapped model, message count, and tool count for every request.

## 📄 License

MIT — see the [LICENSE](LICENSE) file.

## 🤝 Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit using conventional commits (`git commit -m 'feat: add amazing feature'`)
4. Push and open a Pull Request
