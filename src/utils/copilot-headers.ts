/**
 * Headers required by GitHub Copilot's API.
 *
 * Kept separate from the translation layer so both the chat endpoint and the
 * model catalog can use them without a circular import.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { getMachineId } from './machine-id.js';

/**
 * Build the headers required by GitHub Copilot's API.
 *
 * `Editor-Version` is mandatory for IDE auth and `X-Github-Api-Version` is
 * validated upstream, so neither can be omitted or changed casually.
 */
export function buildCopilotHeaders(
  copilotToken: string,
  options: { stream: boolean; hasImages: boolean }
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: options.stream ? 'text/event-stream' : 'application/json',
    Authorization: 'Bearer ' + copilotToken,
    'X-Request-Id': randomUUID(),
    'X-Github-Api-Version': '2025-05-01',
    'Machine-Id': getMachineId(),
    'Copilot-Integration-Id': config.copilot.integrationId,
    'Editor-Version': config.copilot.editorVersion,
    'Editor-Plugin-Version': config.copilot.pluginVersion,
    'User-Agent': config.copilot.userAgent,
    'Openai-Intent': 'conversation-panel',
  };

  if (options.hasImages) {
    headers['Copilot-Vision-Request'] = 'true';
  }

  return headers;
}
