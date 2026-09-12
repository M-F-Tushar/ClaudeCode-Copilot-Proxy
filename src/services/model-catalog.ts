/**
 * Live GitHub Copilot model catalog.
 *
 * Copilot advertises exactly the models an account is entitled to at
 * `GET {endpoints.api}/models`. Claude Code should see that list - not a
 * hardcoded snapshot that drifts every time Copilot rotates a model ID - so the
 * catalog is fetched on demand, cached, and used for `/v1/models`, alias
 * resolution and per-model output limits.
 *
 * Every failure path falls back to the last good snapshot (or an empty one, in
 * which case the static config in `config/index.ts` still applies), so the
 * proxy keeps working offline or before authentication.
 */

import { destroyUpstreamBody, upstreamFetch } from '../utils/upstream-fetch.js';
import { config } from '../config/index.js';
import { getCopilotToken } from './auth-service.js';
import { buildCopilotHeaders } from '../utils/copilot-headers.js';
import { logger } from '../utils/logger.js';

/** How long a fetched catalog is considered fresh. */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/** Minimum spacing between catalog fetch attempts after a failure. */
const CATALOG_RETRY_MS = 30 * 1000;

/** A chat model offered by the signed-in Copilot account. */
export interface CatalogModel {
  id: string;
  displayName: string;
  vendor: string;
  family?: string;
  /** Anthropic-vendored (Claude) model. */
  isClaude: boolean;
  /** Copilot shows this model in its own picker. */
  pickerEnabled: boolean;
  isChatDefault: boolean;
  maxOutputTokens?: number;
  maxNonStreamingOutputTokens?: number;
  maxPromptTokens?: number;
  maxContextTokens?: number;
  supportedEndpoints?: string[];
  supportsTools: boolean;
  supportsVision: boolean;
}

/** Subset of Copilot's `/models` payload that this proxy relies on. */
interface RawCopilotModel {
  id?: string;
  name?: string;
  vendor?: string;
  preview?: boolean;
  model_picker_enabled?: boolean;
  is_chat_default?: boolean;
  supported_endpoints?: string[];
  policy?: { state?: string };
  capabilities?: {
    type?: string;
    family?: string;
    limits?: {
      max_output_tokens?: number;
      max_non_streaming_output_tokens?: number;
      max_prompt_tokens?: number;
      max_context_window_tokens?: number;
      vision?: unknown;
    };
    supports?: {
      tool_calls?: boolean;
      vision?: boolean;
      streaming?: boolean;
    };
  };
}

let catalog: CatalogModel[] = [];
let fetchedAt = 0;
let lastAttemptAt = 0;
let inFlight: Promise<CatalogModel[]> | null = null;

/**
 * Resolve the account-specific `/models` URL.
 *
 * Mirrors `resolveCopilotChatEndpoint`: the host advertised by the Copilot
 * token wins, because individual and business plans are served from different
 * hosts.
 */
function resolveModelsEndpoint(): string {
  const api = getCopilotToken()?.endpoints?.api;
  if (api) {
    return `${api.replace(/\/+$/, '')}/models`;
  }

  return config.github.copilot.anthropicEndpoints.COPILOT_ANTHROPIC_CHAT.replace(
    /\/chat\/completions\/?$/,
    '/models'
  );
}

/**
 * Normalise one upstream entry, or null when it is not a usable chat model.
 */
function toCatalogModel(raw: RawCopilotModel): CatalogModel | null {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    return null;
  }

  // Embedding and completion models cannot serve Messages API traffic.
  const type = raw.capabilities?.type;
  if (type && type !== 'chat') {
    return null;
  }

  // Models gated behind an org policy the user has not accepted return 403.
  const policyState = raw.policy?.state;
  if (policyState && policyState !== 'enabled') {
    return null;
  }

  const vendor = raw.vendor ?? '';
  const limits = raw.capabilities?.limits;

  return {
    id,
    displayName: raw.name?.trim() || id,
    vendor,
    family: raw.capabilities?.family,
    isClaude: vendor.toLowerCase() === 'anthropic' || id.toLowerCase().startsWith('claude'),
    pickerEnabled: raw.model_picker_enabled !== false,
    isChatDefault: raw.is_chat_default === true,
    maxOutputTokens:
      typeof limits?.max_output_tokens === 'number' ? limits.max_output_tokens : undefined,
    maxNonStreamingOutputTokens: limits?.max_non_streaming_output_tokens,
    maxPromptTokens: limits?.max_prompt_tokens,
    supportedEndpoints: Array.isArray(raw.supported_endpoints)
      ? raw.supported_endpoints.filter(endpoint => typeof endpoint === 'string')
      : [],
    maxContextTokens:
      typeof limits?.max_context_window_tokens === 'number'
        ? limits.max_context_window_tokens
        : undefined,
    supportsTools: raw.capabilities?.supports?.tool_calls !== false,
    supportsVision:
      raw.capabilities?.supports?.vision !== false || limits?.vision !== undefined,
  };
}

/**
 * The cached catalog. Empty until the first successful fetch, which lets every
 * caller degrade to the static configuration.
 */
export function getCatalogSnapshot(): CatalogModel[] {
  return catalog;
}

/** Claude models from the cached catalog. */
export function getClaudeCatalogModels(): CatalogModel[] {
  return catalog.filter((model) => model.isClaude);
}

/** Case-insensitive lookup against the cached catalog. */
export function findCatalogModel(id: string): CatalogModel | undefined {
  if (!id) {
    return undefined;
  }

  const normalized = id.trim().toLowerCase();
  return catalog.find((model) => model.id.toLowerCase() === normalized);
}

/** Upstream output-token ceiling for a model, when Copilot published one. */
export function getCatalogOutputLimit(id: string): number | undefined {
  return findCatalogModel(id)?.maxOutputTokens;
}

/**
 * Fetch the catalog, reusing the cached copy while it is fresh.
 *
 * A stale snapshot is returned immediately while a single background refresh
 * replaces it, so no Claude Code request pays the catalog round trip. Only a
 * cold start with no snapshot waits. Never rejects: on failure the previous
 * snapshot is kept and the next attempt is delayed.
 */
export async function refreshModelCatalog(
  options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<CatalogModel[]> {
  if (options.signal?.aborted) {
    throw options.signal.reason;
  }
  const now = Date.now();
  const isFresh = catalog.length > 0 && now - fetchedAt < CATALOG_TTL_MS;
  if (!options.force && isFresh) {
    return catalog;
  }
  // Unauthenticated: nothing to fetch yet, and this must not start a backoff.
  if (!getCopilotToken()?.token) {
    return catalog;
  }
  const backingOff = !options.force && lastAttemptAt > fetchedAt &&
    now - lastAttemptAt < CATALOG_RETRY_MS;
  if (!inFlight && !backingOff) {
    lastAttemptAt = now;
    inFlight = fetchCatalog().finally(() => {
      inFlight = null;
    });
  }
  if (!inFlight || (!options.force && catalog.length > 0)) {
    return catalog;
  }

  if (!options.signal) {
    return inFlight;
  }
  // Cancel only this waiter: other requests may be sharing the catalog fetch.
  const signal = options.signal;
  const pending = inFlight;
  return new Promise<CatalogModel[]>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) {
      onAbort();
    }
  });
}

async function fetchCatalog(): Promise<CatalogModel[]> {
  const token = getCopilotToken()?.token;
  if (!token) {
    return catalog;
  }

  const url = resolveModelsEndpoint();

  try {
    const response = await upstreamFetch(
      url,
      {
        method: 'GET',
        headers: buildCopilotHeaders(token, { stream: false, hasImages: false }),
      },
      { maxRetries: config.upstream.safeGetRetries }
    );

    if (!response.ok) {
      logger.warn('Copilot model catalog request failed', {
        status: response.status,
      });
      destroyUpstreamBody(response);
      return catalog;
    }

    const payload = (await response.json()) as { data?: RawCopilotModel[] };
    const models: CatalogModel[] = [];
    const seen = new Set<string>();

    for (const raw of payload?.data ?? []) {
      const model = toCatalogModel(raw);
      if (!model) {
        continue;
      }
      const key = model.id.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push(model);
    }

    if (models.length === 0) {
      logger.warn('Copilot model catalog was empty, keeping previous snapshot');
      return catalog;
    }

    catalog = models;
    fetchedAt = Date.now();

    logger.info('Loaded Copilot model catalog', {
      total: models.length,
      claude: models.filter((model) => model.isClaude).length,
    });

    return catalog;
  } catch (error) {
    logger.warn('Could not load Copilot model catalog');
    return catalog;
  }
}

/**
 * Warm the catalog in the background at startup. Safe to call unauthenticated.
 */
export function primeModelCatalog(): void {
  void refreshModelCatalog();
}

/** Test hook: replace or clear the cached catalog, optionally marking it stale. */
export function setCatalogForTesting(models: CatalogModel[], ageMs = 0): void {
  catalog = models;
  fetchedAt = models.length > 0 ? Date.now() - ageMs : 0;
  lastAttemptAt = 0;
}
