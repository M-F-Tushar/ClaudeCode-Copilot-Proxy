/**
 * Model mapping utilities for Claude Code -> GitHub Copilot
 *
 * Supports Claude, GPT, Gemini, and other models available in Copilot.
 */

import {
  AVAILABLE_CLAUDE_MODELS,
  CLAUDE_MODEL_MAPPINGS,
  COPILOT_ANTHROPIC_MODELS,
  config,
} from '../config/index.js';
import {
  CatalogModel,
  findCatalogModel,
  getCatalogSnapshot,
  getClaudeCatalogModels,
} from '../services/model-catalog.js';
import { AnthropicModel, AnthropicModelList } from '../types/anthropic.js';

/** Claude model families, in the order used to pick a generic fallback. */
const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Suffixes that mark a variant, so the plain model of a family wins ties. */
const VARIANT_SUFFIX = /-(fast|thinking|preview|latest)$/;

export class ModelSelectionError extends Error {
  readonly status = 400;

  constructor(model: string) {
    super(`Model '${model}' is unavailable without substitution. Select an ID from /v1/models, a family alias, or explicitly set MODEL_SELECTION=compatible.`);
    this.name = 'ModelSelectionError';
  }
}

const FAMILY_ALIASES: Record<string, string> = {
  opus: 'opus',
  opusplan: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

/**
 * Extract the family keyword (`opus`, `sonnet`, ...) from a model name.
 */
function detectFamily(model: string): string | undefined {
  return CLAUDE_FAMILIES.find((family) => model.includes(family));
}

/**
 * Rank a catalog model within its family: newest version first, plain variants
 * before `-fast`/`-thinking` ones.
 */
function familyRank(model: CatalogModel): [number, number] {
  const versions = (model.id.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const version = versions.length > 0 ? Math.max(...versions) : 0;
  return [version, VARIANT_SUFFIX.test(model.id) ? 0 : 1];
}

/**
 * Best live model of a family, or undefined when the account has none.
 */
function bestCatalogModelForFamily(family: string | undefined): CatalogModel | undefined {
  const candidates = getClaudeCatalogModels().filter((model) =>
    family ? model.id.toLowerCase().includes(family) : true
  );

  return candidates.sort((a, b) => {
    const [versionA, plainA] = familyRank(a);
    const [versionB, plainB] = familyRank(b);
    return versionB - versionA || plainB - plainA || a.id.localeCompare(b.id);
  })[0];
}

/**
 * The model unrecognised Claude identifiers fall back to.
 *
 * `DEFAULT_CLAUDE_MODEL` wins whenever the account can actually serve it;
 * otherwise the newest live Sonnet is used, so a retired default cannot break
 * a session.
 */
function resolveDefaultModel(): string {
  const configured = config.anthropic.defaultModel;

  if (getCatalogSnapshot().length === 0 || findCatalogModel(configured)) {
    return configured;
  }

  return (
    bestCatalogModelForFamily(detectFamily(configured.toLowerCase()) ?? 'sonnet')?.id ??
    bestCatalogModelForFamily(undefined)?.id ??
    configured
  );
}

/**
 * Reconcile a statically mapped model with what the account can actually use.
 *
 * With no catalog loaded (offline, or before authentication) the static mapping
 * is returned unchanged, preserving the previous behaviour.
 */
function reconcileWithCatalog(candidate: string, requested: string): string {
  if (getCatalogSnapshot().length === 0) {
    return candidate;
  }

  const live = findCatalogModel(candidate);
  if (live) {
    return live.id;
  }

  const family = detectFamily(requested) ?? detectFamily(candidate.toLowerCase());
  return bestCatalogModelForFamily(family)?.id ?? resolveDefaultModel();
}

/**
 * Map a model name to the Copilot model name.
 *
 * Claude Code sends dated identifiers (`claude-sonnet-4-5-20250929`) and short
 * aliases (`sonnet`, `haiku`, `opusplan`). Matching is done longest-prefix
 * first so `claude-sonnet-4-5-...` never falls back to the `claude-sonnet-4`
 * entry. Copilot serves its own model IDs, not Anthropic's public names.
 *
 * @param model - The requested model name
 * @returns The corresponding Copilot model name
 */
export function mapClaudeModelToCopilot(model: string): string {
  if (config.anthropic.modelSelection === 'strict') {
    const normalized = model?.trim().toLowerCase();
    const live = findCatalogModel(normalized);
    if (live) {
      return live.id;
    }

    // Family aliases deliberately opt into a moving model, unlike versioned IDs.
    const family = Object.hasOwn(FAMILY_ALIASES, normalized) ? FAMILY_ALIASES[normalized] : undefined;
    if (family) {
      if (getCatalogSnapshot().length === 0) {
        return CLAUDE_MODEL_MAPPINGS[normalized];
      }
      const selected = bestCatalogModelForFamily(family);
      if (selected) {
        return selected.id;
      }
    } else if (getCatalogSnapshot().length === 0 &&
               AVAILABLE_CLAUDE_MODELS.some((entry) => entry.id === normalized)) {
      return normalized;
    }

    throw new ModelSelectionError(model);
  }

  if (!model) {
    return resolveDefaultModel();
  }

  const normalized = model.trim().toLowerCase();

  // Anything the account actually offers is forwarded verbatim, so selecting
  // any Copilot model ID from /v1/models works without a mapping entry.
  const live = findCatalogModel(normalized);
  if (live) {
    return live.id;
  }

  // A known Copilot model ID is forwarded verbatim. Checked before prefix
  // matching so 'claude-opus-4.7' is not rewritten by the 'claude-opus-4' key.
  if (COPILOT_ANTHROPIC_MODELS.includes(normalized)) {
    return reconcileWithCatalog(normalized, normalized);
  }

  const direct = CLAUDE_MODEL_MAPPINGS[normalized];
  if (direct) {
    return reconcileWithCatalog(direct, normalized);
  }

  // Already a Copilot model identifier (e.g. "claude-sonnet-5").
  if (Object.values(CLAUDE_MODEL_MAPPINGS).includes(normalized)) {
    return reconcileWithCatalog(normalized, normalized);
  }

  // Longest matching prefix wins so dated suffixes resolve correctly.
  const prefixMatch = Object.keys(CLAUDE_MODEL_MAPPINGS)
    .filter((key) => normalized === key || normalized.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];

  if (prefixMatch) {
    return reconcileWithCatalog(CLAUDE_MODEL_MAPPINGS[prefixMatch], normalized);
  }

  // Unknown Claude variants resolve to the newest live model of the same
  // family, or the default, so Claude Code never fails outright on a rename.
  if (normalized.startsWith('claude')) {
    const family = detectFamily(normalized);
    return (family && bestCatalogModelForFamily(family)?.id) || resolveDefaultModel();
  }

  // Non-Claude models (GPT, Gemini, ...) pass through untouched.
  return model;
}

/**
 * Check if a model is a known Claude model.
 *
 * @param model - The model name to check
 * @returns True if the model is a known Claude model
 */
export function isValidClaudeModel(model: string): boolean {
  if (!model) {
    return false;
  }

  const normalized = model.trim().toLowerCase();

  if (config.anthropic.modelSelection === 'strict') {
    try {
      const resolved = mapClaudeModelToCopilot(model);
      return findCatalogModel(resolved)?.isClaude ?? resolved.startsWith('claude-');
    } catch {
      return false;
    }
  }

  if (findCatalogModel(normalized)?.isClaude) {
    return true;
  }

  if (COPILOT_ANTHROPIC_MODELS.includes(normalized)) {
    return true;
  }

  if (CLAUDE_MODEL_MAPPINGS[normalized]) {
    return true;
  }

  if (Object.values(CLAUDE_MODEL_MAPPINGS).includes(normalized)) {
    return true;
  }

  return normalized.startsWith('claude');
}

/**
 * Build an Anthropic `/v1/models` entry.
 */
function toAnthropicModel(model: { id: string; display_name: string }): AnthropicModel {
  return {
    type: 'model',
    id: model.id,
    display_name: model.display_name,
    created_at: new Date(0).toISOString(),
  };
}

/**
 * Models to advertise: every model the account can actually use, falling back
 * to the static list when the catalog has not been loaded.
 *
 * Copilot's own picker flag is honoured so retired-but-still-served IDs stay
 * out of Claude Code's `/model` list, unless that would leave it empty.
 */
function listAdvertisedModels(): AnthropicModel[] {
  const snapshot = getCatalogSnapshot();

  if (snapshot.length > 0) {
    const scoped = config.anthropic.exposeAllModels
      ? snapshot
      : snapshot.filter((model) => model.isClaude);
    const picked = scoped.filter((model) => model.pickerEnabled);
    const exposed = picked.length > 0 ? picked : scoped;

    return exposed.map((model) =>
      toAnthropicModel({ id: model.id, display_name: model.displayName })
    );
  }

  return AVAILABLE_CLAUDE_MODELS
    .filter((model) => config.anthropic.exposeAllModels || model.id.startsWith('claude-'))
    .map(toAnthropicModel);
}

/**
 * Get the list of available models for the `/v1/models` endpoint, in
 * Anthropic's pagination envelope.
 */
export function getAvailableModels(): AnthropicModelList {
  const models = listAdvertisedModels();

  return {
    data: models,
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models[models.length - 1]?.id ?? null,
  };
}

/**
 * Look up a single model for `GET /v1/models/:model`.
 *
 * @returns The model entry, or null when the model is not recognised
 */
export function getModelById(modelId: string): AnthropicModel | null {
  if (config.anthropic.modelSelection === 'strict') {
    try {
      const resolved = mapClaudeModelToCopilot(modelId);
      return listAdvertisedModels().find((model) => model.id === resolved) ?? null;
    } catch {
      return null;
    }
  }

  const live = findCatalogModel(modelId);
  if (live) {
    return toAnthropicModel({ id: live.id, display_name: live.displayName });
  }

  const found = AVAILABLE_CLAUDE_MODELS.find(
    (model) => model.id === modelId || model.copilot_model === modelId
  );

  if (found) {
    return toAnthropicModel(found);
  }

  // Claude Code also asks about dated aliases; report those as valid too.
  if (isValidClaudeModel(modelId)) {
    return toAnthropicModel({ id: modelId, display_name: getModelDisplayName(modelId) });
  }

  return null;
}

/**
 * Get a human-readable display name for a model.
 *
 * @param model - The model name
 * @returns Human-readable display name
 */
export function getModelDisplayName(model: string): string {
  const live = findCatalogModel(model);
  if (live) {
    return live.displayName;
  }

  const found = AVAILABLE_CLAUDE_MODELS.find(
    (m) => m.id === model || m.copilot_model === model
  );

  if (found) {
    return found.display_name;
  }

  return model
    .replace(/-/g, ' ')
    .replace(/(\d+)/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
