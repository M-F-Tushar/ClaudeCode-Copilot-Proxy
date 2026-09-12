import { config } from '../config/index.js';
import { CatalogModel, setCatalogForTesting } from '../services/model-catalog.js';
import { AnthropicMessageRequest, ContentBlock } from '../types/anthropic.js';
import { inspectRequestCompatibility } from './request-policy.js';

const request: AnthropicMessageRequest = {
  model: 'claude-sonnet-5',
  max_tokens: 128,
  messages: [{ role: 'user', content: 'Hello' }],
};
const originalPolicy = config.anthropic.unsupportedFeatures;
const originalSelection = config.anthropic.modelSelection;

beforeEach(() => {
  config.anthropic.unsupportedFeatures = 'warn';
  config.anthropic.modelSelection = 'strict';
});
afterEach(() => {
  config.anthropic.unsupportedFeatures = originalPolicy;
  config.anthropic.modelSelection = originalSelection;
  setCatalogForTesting([]);
});

it('does not invent compatibility losses for ordinary text requests', () => {
  expect(inspectRequestCompatibility(request)).toEqual([]);
});

it('reports model resolution without rejecting intentional aliases', () => {
  config.anthropic.unsupportedFeatures = 'reject';
  expect(inspectRequestCompatibility({ ...request, model: 'sonnet' })).toEqual(['model_resolved']);
});

it('reports ignored thinking, caching, metadata and sampling controls', () => {
  expect(inspectRequestCompatibility({
    ...request,
    thinking: { type: 'adaptive' },
    top_k: 10,
    metadata: { user_id: 'test' },
    system: [{ type: 'text', text: 'System', cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'high' },
  })).toEqual(expect.arrayContaining([
    'thinking_unsupported', 'prompt_cache_unsupported', 'metadata_unsupported',
    'top_k_unsupported', 'output_config_unsupported',
  ]));
});

it('checks caching and thinking in tool results and historical messages', () => {
  const warnings = inspectRequestCompatibility({
    ...request,
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Old reasoning' }] },
      { role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: [{ type: 'text', text: 'Result', cache_control: { type: 'ephemeral' } }],
      }] },
    ],
  });
  expect(warnings).toContain('thinking_unsupported');
  expect(warnings).toContain('prompt_cache_unsupported');
});

it('rejects unsupported semantics when explicitly configured', () => {
  config.anthropic.unsupportedFeatures = 'reject';
  expect(() => inspectRequestCompatibility({
    ...request, thinking: { type: 'enabled', budget_tokens: 1024 },
  })).toThrow(/thinking_unsupported/);
  expect(() => inspectRequestCompatibility({
    ...request, cache_control: { type: 'ephemeral' },
  })).toThrow(/prompt_cache_unsupported/);
  expect(inspectRequestCompatibility({
    ...request, thinking: { type: 'disabled' },
  })).toEqual([]);
});

it('rejects unsupported content instead of silently deleting it', () => {
  expect(() => inspectRequestCompatibility({
    ...request,
    messages: [{ role: 'user', content: [{ type: 'document' } as unknown as ContentBlock] }],
  })).toThrow(/Unsupported content block/);
});

function setModel(overrides: Partial<CatalogModel>): void {
  setCatalogForTesting([{
    id: request.model, displayName: 'Sonnet', vendor: 'Anthropic', isClaude: true,
    pickerEnabled: true, isChatDefault: false, supportsTools: true, supportsVision: true,
    ...overrides,
  }]);
}

it('enforces published tool and vision capabilities', () => {
  setModel({ supportsTools: false, supportsVision: false });
  expect(() => inspectRequestCompatibility({
    ...request, tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  })).toThrow(/does not support tool calls/);
  expect(() => inspectRequestCompatibility({
    ...request,
    messages: [{ role: 'user', content: [{
      type: 'image', source: { type: 'url', url: 'https://example.com/image.png' },
    }] }],
  })).toThrow(/does not support images/);
});

it('exposes output budget clamping and can reject it', () => {
  setModel({ maxOutputTokens: 64 });
  expect(inspectRequestCompatibility(request)).toContain('max_tokens_clamped');
  config.anthropic.unsupportedFeatures = 'reject';
  expect(() => inspectRequestCompatibility(request)).toThrow(/max_tokens_clamped/);
});

it('reports context-window clamping and rejects inputs beyond the window', () => {
  setModel({ maxOutputTokens: 1000, maxContextTokens: 40 });
  expect(inspectRequestCompatibility(request)).toContain('context_window_clamped');
  setModel({ maxContextTokens: 1 });
  expect(() => inspectRequestCompatibility(request)).toThrow(/context window/);
});
