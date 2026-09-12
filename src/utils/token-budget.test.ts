import { config } from '../config/index.js';
import { setCatalogForTesting } from '../services/model-catalog.js';
import { AnthropicMessageRequest } from '../types/anthropic.js';
import { resetTokenEstimatorForTesting } from './token-estimator.js';
import { ContextWindowError, resolveRequestTokenBudget } from './token-budget.js';

const originalSelection = config.anthropic.modelSelection;
const request: AnthropicMessageRequest = {
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hello' }],
  max_tokens: 128,
};

beforeEach(() => {
  config.anthropic.modelSelection = 'strict';
  resetTokenEstimatorForTesting();
  setCatalogForTesting([{
    id: request.model,
    displayName: 'Claude Sonnet 5',
    vendor: 'Anthropic',
    isClaude: true,
    pickerEnabled: true,
    isChatDefault: true,
    maxOutputTokens: 100,
    maxContextTokens: 1000,
    supportsTools: true,
    supportsVision: true,
  }]);
});

afterEach(() => {
  config.anthropic.modelSelection = originalSelection;
  resetTokenEstimatorForTesting();
  setCatalogForTesting([]);
});

it('applies both published output and context limits', () => {
  const outputLimited = resolveRequestTokenBudget(request);
  expect(outputLimited.effectiveMaxTokens).toBe(100);
  expect(outputLimited.outputLimitClamped).toBe(true);
  expect(outputLimited.contextWindowClamped).toBe(false);

  setCatalogForTesting([{
    id: request.model,
    displayName: 'Claude Sonnet 5',
    vendor: 'Anthropic',
    isClaude: true,
    pickerEnabled: true,
    isChatDefault: true,
    maxOutputTokens: 1000,
    maxContextTokens: outputLimited.estimate.inputTokens + 20,
    supportsTools: true,
    supportsVision: true,
  }]);
  const contextLimited = resolveRequestTokenBudget(request);
  expect(contextLimited.effectiveMaxTokens).toBe(20);
  expect(contextLimited.contextWindowClamped).toBe(true);
});

it('rejects a request whose estimated input already exceeds the context window', () => {
  setCatalogForTesting([{
    id: request.model,
    displayName: 'Claude Sonnet 5',
    vendor: 'Anthropic',
    isClaude: true,
    pickerEnabled: true,
    isChatDefault: true,
    maxOutputTokens: 100,
    maxContextTokens: 1,
    supportsTools: true,
    supportsVision: true,
  }]);
  expect(() => resolveRequestTokenBudget(request)).toThrow(ContextWindowError);
});
