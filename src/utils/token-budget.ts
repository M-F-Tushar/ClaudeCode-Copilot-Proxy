import { config } from '../config/index.js';
import { findCatalogModel } from '../services/model-catalog.js';
import { AnthropicMessageRequest } from '../types/anthropic.js';
import { mapClaudeModelToCopilot } from './model-mapper.js';
import { estimateInputTokensDetailed, InputTokenEstimate } from './token-estimator.js';

export class ContextWindowError extends Error {
  readonly status = 400;

  constructor(model: string, inputTokens: number, contextTokens: number) {
    super(
      `Estimated input for model '${model}' is ${inputTokens} tokens, exceeding ` +
      `its published ${contextTokens}-token context window. Reduce the conversation or tools.`
    );
    this.name = 'ContextWindowError';
  }
}

export interface RequestTokenBudget {
  model: string;
  estimate: InputTokenEstimate;
  effectiveMaxTokens: number;
  outputLimitClamped: boolean;
  contextWindowClamped: boolean;
  maxContextTokens?: number;
}

/**
 * Resolve the model and the largest safe output budget for the request using
 * the live catalog. This prevents a large Claude Code context plus an
 * Anthropic-sized max_tokens value from failing only after reaching Copilot.
 */
export function resolveRequestTokenBudget(
  request: AnthropicMessageRequest
): RequestTokenBudget {
  const model = mapClaudeModelToCopilot(request.model);
  const catalog = findCatalogModel(model);
  const estimate = estimateInputTokensDetailed(
    request.messages,
    request.system,
    request.tools,
    model
  );
  const outputLimit = Math.min(
    config.anthropic.maxOutputTokens,
    catalog?.maxOutputTokens ?? Number.POSITIVE_INFINITY
  );

  let contextOutputLimit = Number.POSITIVE_INFINITY;
  if (catalog?.maxContextTokens !== undefined) {
    contextOutputLimit = catalog.maxContextTokens - estimate.inputTokens;
    if (contextOutputLimit < 1) {
      throw new ContextWindowError(model, estimate.inputTokens, catalog.maxContextTokens);
    }
  }

  const effectiveMaxTokens = Math.max(
    1,
    Math.min(request.max_tokens, outputLimit, contextOutputLimit)
  );

  return {
    model,
    estimate,
    effectiveMaxTokens,
    outputLimitClamped: outputLimit < request.max_tokens,
    contextWindowClamped:
      contextOutputLimit < Math.min(request.max_tokens, outputLimit),
    maxContextTokens: catalog?.maxContextTokens,
  };
}
