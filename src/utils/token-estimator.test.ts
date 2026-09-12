import {
  estimateInputTokensDetailed,
  estimateRawInputTokens,
  MAX_TOKEN_CALIBRATIONS,
  recordInputTokenObservation,
  resetTokenEstimatorForTesting,
} from './token-estimator.js';

const messages = [{ role: 'user' as const, content: 'x'.repeat(1200) }];

beforeEach(resetTokenEstimatorForTesting);
afterEach(resetTokenEstimatorForTesting);

it('starts with the conservative content-aware heuristic', () => {
  const estimate = estimateInputTokensDetailed(messages, undefined, undefined, 'model-a');
  expect(estimate.source).toBe('heuristic');
  expect(estimate.inputTokens).toBe(estimate.rawInputTokens);
  expect(estimate.inputTokens).toBeGreaterThan(300);
});

it('calibrates gradually from authoritative model-specific prompt usage', () => {
  const raw = estimateRawInputTokens(messages);
  recordInputTokenObservation('model-a', raw, raw * 2);
  const first = estimateInputTokensDetailed(messages, undefined, undefined, 'model-a');
  expect(first.source).toBe('calibrated');
  expect(first.inputTokens).toBeGreaterThan(raw);
  expect(first.inputTokens).toBeLessThan(raw * 2);

  for (let index = 0; index < 3; index++) {
    recordInputTokenObservation('model-a', raw, raw * 2);
  }
  expect(estimateInputTokensDetailed(messages, undefined, undefined, 'model-a').inputTokens)
    .toBe(raw * 2);
  expect(estimateInputTokensDetailed(messages, undefined, undefined, 'model-b').source)
    .toBe('heuristic');
});

it('ignores tiny or implausible observations and bounds retained models', () => {
  recordInputTokenObservation('tiny', 10, 100);
  recordInputTokenObservation('implausible', 100, 10_000);
  expect(estimateInputTokensDetailed(messages, undefined, undefined, 'tiny').source)
    .toBe('heuristic');
  expect(estimateInputTokensDetailed(messages, undefined, undefined, 'implausible').source)
    .toBe('heuristic');

  const raw = estimateRawInputTokens(messages);
  for (let index = 0; index <= MAX_TOKEN_CALIBRATIONS; index++) {
    recordInputTokenObservation(`model-${index}`, raw, raw + 10);
  }
  expect(estimateInputTokensDetailed(messages, undefined, undefined, 'model-0').source)
    .toBe('heuristic');
  expect(estimateInputTokensDetailed(
    messages,
    undefined,
    undefined,
    `model-${MAX_TOKEN_CALIBRATIONS}`
  ).source).toBe('calibrated');
});
