import {
  AnthropicMessage,
  AnthropicSystemPrompt,
  AnthropicTool,
  ContentBlock,
} from '../types/anthropic.js';

export const TOKEN_CALIBRATION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TOKEN_CALIBRATIONS = 32;

const MIN_CALIBRATION_TOKENS = 32;
const MIN_OBSERVED_RATIO = 0.25;
const MAX_OBSERVED_RATIO = 8;
const MIN_APPLIED_RATIO = 0.5;
const MAX_APPLIED_RATIO = 4;
const CALIBRATION_CONFIDENCE_SAMPLES = 4;
const CALIBRATION_ALPHA = 0.25;

interface TokenCalibration {
  ratio: number;
  samples: number;
  lastUsedAt: number;
}

export interface InputTokenEstimate {
  inputTokens: number;
  rawInputTokens: number;
  source: 'heuristic' | 'calibrated';
  calibrationSamples: number;
}

const calibrations = new Map<string, TokenCalibration>();

function modelKey(model?: string): string {
  return model?.trim().toLowerCase() ?? '';
}

function expireCalibrations(now = Date.now()): void {
  for (const [key, calibration] of calibrations) {
    if (now - calibration.lastUsedAt > TOKEN_CALIBRATION_TTL_MS) {
      calibrations.delete(key);
    }
  }
}

function getCalibration(model?: string): TokenCalibration | undefined {
  const key = modelKey(model);
  if (!key) {
    return undefined;
  }
  expireCalibrations();
  const calibration = calibrations.get(key);
  if (calibration) {
    calibrations.delete(key);
    calibrations.set(key, calibration);
  }
  return calibration;
}

/**
 * Local heuristic in twelfths of a token. Punctuation and non-ASCII text are
 * deliberately weighted more heavily than prose so source code and Unicode do
 * not inherit the severe undercounting of a flat characters/4 estimate.
 */
export function estimateTokenUnits(text: string): number {
  let units = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) {
      units += 24;
    } else if (code >= 0x800) {
      units += 36;
    } else if (code >= 0x80) {
      units += 24;
    } else if (/[a-zA-Z0-9]/.test(text[index])) {
      units += 4;
    } else if (/\s/.test(text[index])) {
      units += 3;
    } else {
      units += 12;
    }
  }
  return units;
}

function systemText(system?: AnthropicSystemPrompt): string {
  if (typeof system === 'string') {
    return system;
  }
  if (!Array.isArray(system)) {
    return '';
  }
  return system
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

function blockText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((block) => {
    if (!block || typeof block !== 'object') {
      return '';
    }
    if (block.type === 'text') {
      return block.text;
    }
    if (block.type === 'image') {
      return '[image]';
    }
    return '';
  }).join('\n');
}

export function estimateRawInputTokens(
  messages: AnthropicMessage[],
  system?: AnthropicSystemPrompt,
  tools?: AnthropicTool[]
): number {
  let units = estimateTokenUnits(systemText(system));

  for (const message of messages ?? []) {
    units += 12 * 8;
    if (typeof message?.content === 'string') {
      units += estimateTokenUnits(message.content);
      continue;
    }

    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      switch (block.type) {
        case 'text':
          units += estimateTokenUnits(block.text);
          break;
        case 'tool_use':
          units += 12 * 12;
          units += estimateTokenUnits(block.name + JSON.stringify(block.input ?? {}));
          break;
        case 'tool_result':
          units += 12 * 8;
          units += estimateTokenUnits(blockText(block.content));
          break;
        case 'thinking':
          units += estimateTokenUnits(block.thinking);
          break;
        case 'redacted_thinking':
          units += estimateTokenUnits(block.data);
          break;
        case 'image':
          units += 12 * 1600;
          break;
        default:
          break;
      }
    }
  }

  for (const tool of tools ?? []) {
    units += 12 * 16;
    units += estimateTokenUnits((tool.name ?? '') + (tool.description ?? ''));
    units += estimateTokenUnits(JSON.stringify(tool.input_schema ?? {}));
  }

  return Math.max(1, Math.ceil(units / 12));
}

/**
 * Estimate the exact request shape sent upstream. Once a model has returned
 * authoritative prompt usage, later estimates are adjusted by a bounded,
 * expiring per-model calibration rather than assuming every tokenizer behaves
 * like characters/4.
 */
export function estimateInputTokensDetailed(
  messages: AnthropicMessage[],
  system?: AnthropicSystemPrompt,
  tools?: AnthropicTool[],
  model?: string
): InputTokenEstimate {
  const rawInputTokens = estimateRawInputTokens(messages, system, tools);
  const calibration = getCalibration(model);
  if (!calibration) {
    return {
      inputTokens: rawInputTokens,
      rawInputTokens,
      source: 'heuristic',
      calibrationSamples: 0,
    };
  }

  const confidence = Math.min(
    calibration.samples / CALIBRATION_CONFIDENCE_SAMPLES,
    1
  );
  const boundedRatio = Math.min(
    MAX_APPLIED_RATIO,
    Math.max(MIN_APPLIED_RATIO, calibration.ratio)
  );
  const appliedRatio = 1 + (boundedRatio - 1) * confidence;

  return {
    inputTokens: Math.max(1, Math.ceil(rawInputTokens * appliedRatio)),
    rawInputTokens,
    source: 'calibrated',
    calibrationSamples: calibration.samples,
  };
}

export function estimateInputTokens(
  messages: AnthropicMessage[],
  system?: AnthropicSystemPrompt,
  tools?: AnthropicTool[],
  model?: string
): number {
  return estimateInputTokensDetailed(messages, system, tools, model).inputTokens;
}

/**
 * Learn from provider usage without retaining prompts or tool data. Small
 * requests are ignored because fixed provider overhead would distort a ratio
 * that is later applied to large Claude Code contexts.
 */
export function recordInputTokenObservation(
  model: string | undefined,
  rawInputTokens: number,
  actualInputTokens: number
): void {
  const key = modelKey(model);
  if (!key || !Number.isFinite(rawInputTokens) || !Number.isFinite(actualInputTokens) ||
      rawInputTokens < MIN_CALIBRATION_TOKENS || actualInputTokens <= 0) {
    return;
  }

  const observedRatio = actualInputTokens / rawInputTokens;
  if (observedRatio < MIN_OBSERVED_RATIO || observedRatio > MAX_OBSERVED_RATIO) {
    return;
  }

  expireCalibrations();
  const previous = calibrations.get(key);
  const ratio = previous
    ? previous.ratio * (1 - CALIBRATION_ALPHA) + observedRatio * CALIBRATION_ALPHA
    : observedRatio;
  const calibration: TokenCalibration = {
    ratio,
    samples: Math.min((previous?.samples ?? 0) + 1, Number.MAX_SAFE_INTEGER),
    lastUsedAt: Date.now(),
  };
  calibrations.delete(key);
  calibrations.set(key, calibration);

  while (calibrations.size > MAX_TOKEN_CALIBRATIONS) {
    const oldest = calibrations.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    calibrations.delete(oldest);
  }
}

export function resetTokenEstimatorForTesting(): void {
  calibrations.clear();
}
