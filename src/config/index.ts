import dotenv from 'dotenv';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };

// Load environment variables
dotenv.config();

// Schema for env validation
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('localhost'),
  PROXY_AUTH_TOKEN: z.string().min(16).optional(),
  PROXY_ALLOWED_ORIGINS: z.string().default(''),
  JSON_BODY_LIMIT: z.string().regex(/^\d+(?:kb|mb)$/i).default('10mb'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(3600000).default(300000),
  UPSTREAM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(0),
  UPSTREAM_SAFE_GET_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  UPSTREAM_MAX_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(10000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  GITHUB_COPILOT_CLIENT_ID: z.string().default('Iv1.b507a08c87ecfe98'),
  // Rate limiting settings (requests per minute)
  RATE_LIMIT_DEFAULT: z.string().default('600'),
  RATE_LIMIT_CHAT_COMPLETIONS: z.string().default('300'),
  // GitHub Copilot chat endpoint (override for enterprise/proxy setups)
  COPILOT_CHAT_ENDPOINT: z.string().url().default('https://api.githubcopilot.com/chat/completions'),
  COPILOT_MESSAGES_ENDPOINT: z.string().url().optional(),
  // Identity headers required by the Copilot chat API
  COPILOT_INTEGRATION_ID: z.string().default('vscode-chat'),
  COPILOT_EDITOR_VERSION: z.string().default('vscode/1.99.3'),
  COPILOT_PLUGIN_VERSION: z.string().default('copilot-chat/0.26.7'),
  COPILOT_USER_AGENT: z.string().default('GitHubCopilotChat/0.26.7'),
  // Default model used when Claude Code does not send a known model
  DEFAULT_CLAUDE_MODEL: z.string().default('claude-sonnet-5'),
  // Set to 'true' to also advertise non-Claude Copilot models on /v1/models
  EXPOSE_ALL_COPILOT_MODELS: z.enum(['true', 'false']).default('false'),
  MODEL_SELECTION: z.enum(['strict', 'compatible']).default('strict'),
  ANTHROPIC_UPSTREAM_MODE: z.enum(['auto', 'native', 'chat']).default('auto'),
  UNSUPPORTED_FEATURES: z.enum(['warn', 'reject']).default('warn'),
  // Upper bound applied to max_tokens sent upstream
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(1000000).default(64000),
  // Set to 'false' to fall back to buffered (non-streaming) upstream requests
  ENABLE_UPSTREAM_STREAMING: z.enum(['true', 'false']).default('true'),
});

// Parse and validate environment variables
const env = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  HOST: process.env.HOST,
  PROXY_AUTH_TOKEN: process.env.PROXY_AUTH_TOKEN,
  PROXY_ALLOWED_ORIGINS: process.env.PROXY_ALLOWED_ORIGINS,
  JSON_BODY_LIMIT: process.env.JSON_BODY_LIMIT,
  UPSTREAM_TIMEOUT_MS: process.env.UPSTREAM_TIMEOUT_MS,
  UPSTREAM_MAX_RETRIES: process.env.UPSTREAM_MAX_RETRIES,
  UPSTREAM_SAFE_GET_RETRIES: process.env.UPSTREAM_SAFE_GET_RETRIES,
  UPSTREAM_MAX_RETRY_DELAY_MS: process.env.UPSTREAM_MAX_RETRY_DELAY_MS,
  LOG_LEVEL: process.env.LOG_LEVEL,
  GITHUB_COPILOT_CLIENT_ID: process.env.GITHUB_COPILOT_CLIENT_ID,
  RATE_LIMIT_DEFAULT: process.env.RATE_LIMIT_DEFAULT,
  RATE_LIMIT_CHAT_COMPLETIONS: process.env.RATE_LIMIT_CHAT_COMPLETIONS,
  COPILOT_CHAT_ENDPOINT: process.env.COPILOT_CHAT_ENDPOINT,
  COPILOT_MESSAGES_ENDPOINT: process.env.COPILOT_MESSAGES_ENDPOINT,
  COPILOT_INTEGRATION_ID: process.env.COPILOT_INTEGRATION_ID,
  COPILOT_EDITOR_VERSION: process.env.COPILOT_EDITOR_VERSION,
  COPILOT_PLUGIN_VERSION: process.env.COPILOT_PLUGIN_VERSION,
  COPILOT_USER_AGENT: process.env.COPILOT_USER_AGENT,
  DEFAULT_CLAUDE_MODEL: process.env.DEFAULT_CLAUDE_MODEL,
  EXPOSE_ALL_COPILOT_MODELS: process.env.EXPOSE_ALL_COPILOT_MODELS,
  MODEL_SELECTION: process.env.MODEL_SELECTION,
  ANTHROPIC_UPSTREAM_MODE: process.env.ANTHROPIC_UPSTREAM_MODE,
  UNSUPPORTED_FEATURES: process.env.UNSUPPORTED_FEATURES,
  MAX_OUTPUT_TOKENS: process.env.MAX_OUTPUT_TOKENS,
  ENABLE_UPSTREAM_STREAMING: process.env.ENABLE_UPSTREAM_STREAMING,
});

// API endpoints for OpenAI-compatible Copilot API
const API_ENDPOINTS = {
  GITHUB_COPILOT_TOKEN: 'https://api.github.com/copilot_internal/v2/token',
  GITHUB_COPILOT_COMPLETIONS: 'https://copilot-proxy.githubusercontent.com/v1/engines/copilot-codex/completions',
};

// API endpoints for Anthropic-compatible Copilot API (Claude models)
const ANTHROPIC_API_ENDPOINTS = {
  // GitHub Copilot's chat completions endpoint (OpenAI-compatible, supports Claude models)
  COPILOT_ANTHROPIC_CHAT: env.COPILOT_CHAT_ENDPOINT,
};

// Anthropic model identifiers currently served by GitHub Copilot. Requests
// naming one of these are forwarded verbatim instead of being remapped.
// Verified against GET https://api.githubcopilot.com/models.
export const COPILOT_ANTHROPIC_MODELS = [
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-opus-4.8-fast',
  'claude-opus-4.7',
  'claude-sonnet-5',
  'claude-haiku-4.5',
  'claude-fable-5.1',
  'claude-fable-5',
];

// Claude model mappings: Claude Code model names -> Copilot model names.
// Uses prefix matching, so 'claude-opus-4-5' matches 'claude-opus-4-5-20251001'.
//
// Copilot retires Anthropic model IDs aggressively and does NOT serve the
// public Anthropic names, so every retired name is aliased onto the closest
// live model. Sending an unlisted name returns 400 model_not_supported.
export const CLAUDE_MODEL_MAPPINGS: Record<string, string> = {
  // Opus family -> latest live Opus
  'claude-opus-4-5': 'claude-opus-5',
  'claude-opus-4-1': 'claude-opus-5',
  'claude-opus-4': 'claude-opus-5',
  'claude-3-opus': 'claude-opus-5',
  'claude-opus-5': 'claude-opus-5',
  'opusplan': 'claude-opus-5',
  'opus': 'claude-opus-5',

  // Sonnet family -> latest live Sonnet
  'claude-sonnet-4-5': 'claude-sonnet-5',
  'claude-sonnet-4': 'claude-sonnet-5',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-3-7-sonnet': 'claude-sonnet-5',
  'claude-3-5-sonnet': 'claude-sonnet-5',
  'sonnet': 'claude-sonnet-5',

  // Haiku family (Claude Code's background/"small fast" model)
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-3-5-haiku': 'claude-haiku-4.5',
  'haiku': 'claude-haiku-4.5',
};

// Models advertised on GET /v1/models when the live catalog is unavailable.
// The live catalog from GET {endpoints.api}/models always takes precedence, so
// this list is only a cold-start/offline fallback. `DEFAULT_CLAUDE_MODEL`
// decides which Copilot model unrecognised Claude identifiers fall back to.
export const AVAILABLE_CLAUDE_MODELS = [
  {
    id: 'claude-opus-5',
    display_name: 'Claude Opus 5',
    copilot_model: 'claude-opus-5',
  },
  {
    id: 'claude-sonnet-5',
    display_name: 'Claude Sonnet 5',
    copilot_model: 'claude-sonnet-5',
  },
  {
    id: 'claude-haiku-4.5',
    display_name: 'Claude Haiku 4.5',
    copilot_model: 'claude-haiku-4.5',
  },
  {
    id: 'claude-opus-4.8',
    display_name: 'Claude Opus 4.8',
    copilot_model: 'claude-opus-4.8',
  },
  {
    id: 'claude-opus-4.8-fast',
    display_name: 'Claude Opus 4.8 Fast',
    copilot_model: 'claude-opus-4.8-fast',
  },
  {
    id: 'claude-opus-4.7',
    display_name: 'Claude Opus 4.7',
    copilot_model: 'claude-opus-4.7',
  },
  {
    id: 'claude-fable-5.1',
    display_name: 'Claude Fable 5.1',
    copilot_model: 'claude-fable-5.1',
  },
  {
    id: 'claude-fable-5',
    display_name: 'Claude Fable 5',
    copilot_model: 'claude-fable-5',
  },
  // Optional: GPT and Gemini models (pass-through, user must specify in settings)
  {
    id: 'gpt-5.5',
    display_name: 'GPT 5.5 (Optional)',
    copilot_model: 'gpt-5.5',
  },
  {
    id: 'gemini-3.8-flash',
    display_name: 'Gemini 3.8 Flash (Optional)',
    copilot_model: 'gemini-3.8-flash',
  },
];

// Configuration object
export const config = {
  version: pkg.version,
  isDevelopment: env.NODE_ENV === 'development',
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  server: {
    port: parseInt(env.PORT, 10),
    host: env.HOST,
    authToken: env.PROXY_AUTH_TOKEN,
    allowedOrigins: env.PROXY_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    bodyLimit: env.JSON_BODY_LIMIT,
  },
  upstream: {
    timeoutMs: env.UPSTREAM_TIMEOUT_MS,
    maxRetries: env.UPSTREAM_MAX_RETRIES,
    safeGetRetries: env.UPSTREAM_SAFE_GET_RETRIES,
    maxRetryDelayMs: env.UPSTREAM_MAX_RETRY_DELAY_MS,
  },
  logging: {
    level: env.LOG_LEVEL,
  },
  github: {
    copilot: {
      clientId: env.GITHUB_COPILOT_CLIENT_ID,
      apiEndpoints: API_ENDPOINTS,
      anthropicEndpoints: ANTHROPIC_API_ENDPOINTS,
    }
  },
  copilot: {
    integrationId: env.COPILOT_INTEGRATION_ID,
    editorVersion: env.COPILOT_EDITOR_VERSION,
    pluginVersion: env.COPILOT_PLUGIN_VERSION,
    userAgent: env.COPILOT_USER_AGENT,
    // Only set when the user pinned an endpoint; otherwise the endpoint
    // advertised by the Copilot token wins.
    chatEndpointOverride: process.env.COPILOT_CHAT_ENDPOINT,
    messagesEndpointOverride: env.COPILOT_MESSAGES_ENDPOINT,
  },
  anthropic: {
    defaultModel: env.DEFAULT_CLAUDE_MODEL,
    exposeAllModels: env.EXPOSE_ALL_COPILOT_MODELS === 'true',
    modelSelection: env.MODEL_SELECTION,
    upstreamMode: env.ANTHROPIC_UPSTREAM_MODE,
    unsupportedFeatures: env.UNSUPPORTED_FEATURES,
    maxOutputTokens: env.MAX_OUTPUT_TOKENS,
    streamUpstream: env.ENABLE_UPSTREAM_STREAMING === 'true',
  },
  rateLimits: {
    default: parseInt(env.RATE_LIMIT_DEFAULT, 10),
    chatCompletions: parseInt(env.RATE_LIMIT_CHAT_COMPLETIONS, 10),
    // Token usage thresholds. Claude Code routinely sends very large
    // contexts, so these are advisory ceilings rather than tight limits.
    maxTokensPerRequest: parseInt(process.env.MAX_TOKENS_PER_REQUEST ?? '0', 10),
    maxTokensPerMinute: parseInt(process.env.MAX_TOKENS_PER_MINUTE ?? '0', 10),
    tokenRateLimitResetTime: 60 * 1000, // 1 minute in ms
  }
};
