import { config } from '../config/index.js';
import { findCatalogModel } from '../services/model-catalog.js';
import { AnthropicMessageRequest, ContentBlock } from '../types/anthropic.js';
import { resolveRequestTokenBudget } from './token-budget.js';

export class RequestCompatibilityError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'RequestCompatibilityError';
  }
}

/**
 * Report translation losses without pretending to implement provider semantics.
 * Strict feature handling rejects the request before a premium request is sent.
 */
export function inspectRequestCompatibility(request: AnthropicMessageRequest): string[] {
  const warnings = new Set<string>();
  const budget = resolveRequestTokenBudget(request);
  const model = budget.model;
  if (model !== request.model) {
    warnings.add('model_resolved');
  }

  if (request.thinking && request.thinking.type !== 'disabled') {
    warnings.add('thinking_unsupported');
  }
  if (request.top_k !== undefined) {
    warnings.add('top_k_unsupported');
  }
  if (request.metadata !== undefined) {
    warnings.add('metadata_unsupported');
  }
  if (request.cache_control) {
    warnings.add('prompt_cache_unsupported');
  }
  if (request.output_config !== undefined) {
    warnings.add('output_config_unsupported');
  }

  let hasImages = false;
  let hasTools = Boolean(request.tools?.length);
  // Iterative traversal also handles cache markers inside tool results.
  const pending: ContentBlock[] = [];
  if (Array.isArray(request.system)) {
    for (const block of request.system) {
      pending.push(block);
    }
  }
  for (const message of request.messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        pending.push(block);
      }
    }
  }
  for (const tool of request.tools ?? []) {
    if (tool.cache_control) {
      warnings.add('prompt_cache_unsupported');
    }
  }
  while (pending.length > 0) {
    const block = pending.pop();
    if (!block || typeof block !== 'object') {
      throw new RequestCompatibilityError('Content blocks must be objects');
    }
    if ('cache_control' in block && block.cache_control) {
      warnings.add('prompt_cache_unsupported');
    }
    switch (block.type) {
      case 'text':
        break;
      case 'image':
        hasImages = true;
        break;
      case 'tool_use':
        hasTools = true;
        break;
      case 'tool_result':
        hasTools = true;
        if (Array.isArray(block.content)) {
          for (const part of block.content) {
            pending.push(part);
          }
          if (block.content.some((part) => part.type === 'image')) {
            warnings.add('tool_result_images_unsupported');
          }
        }
        break;
      case 'thinking':
      case 'redacted_thinking':
        warnings.add('thinking_unsupported');
        break;
      default:
        throw new RequestCompatibilityError('Unsupported content block type');
    }
  }

  const catalog = findCatalogModel(model);
  if (hasTools && catalog?.supportsTools === false) {
    throw new RequestCompatibilityError(`Model '${model}' does not support tool calls`);
  }
  if (hasImages && catalog?.supportsVision === false) {
    throw new RequestCompatibilityError(`Model '${model}' does not support images`);
  }
  if (budget.outputLimitClamped) {
    warnings.add('max_tokens_clamped');
  }
  if (budget.contextWindowClamped) {
    warnings.add('context_window_clamped');
  }

  const losses = [...warnings].filter((warning) => warning !== 'model_resolved');
  if (config.anthropic.unsupportedFeatures === 'reject' && losses.length > 0) {
    throw new RequestCompatibilityError(
      `Copilot cannot preserve these requested semantics: ${losses.join(', ')}. ` +
      'Remove them or explicitly set UNSUPPORTED_FEATURES=warn for best-effort translation.'
    );
  }
  return [...warnings];
}
