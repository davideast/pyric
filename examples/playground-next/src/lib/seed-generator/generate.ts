/**
 * Streaming AI seed proposal generation (single-turn, no tools).
 */
import type { NormalizedRequest } from '@inbrowser/relay';

import { createInference } from '~/lib/llm/inference';

import { SEED_GENERATOR_SYSTEM_PROMPT } from './system-prompt';

export interface GenerateSeedParams {
  contextPayload: string;
  hint?: string;
  providerId: string;
  modelId: string;
  apiKey: string;
  signal?: AbortSignal;
}

export async function* generateSeedProposal({
  contextPayload,
  hint,
  providerId,
  modelId,
  apiKey,
  signal,
}: GenerateSeedParams): AsyncGenerator<string> {
  const userParts = [
    'Generate demo sandbox seed data from this workspace context:',
    '',
    contextPayload,
  ];
  const trimmedHint = hint?.trim();
  if (trimmedHint) {
    userParts.push('', `User hint: ${trimmedHint}`);
  }

  const client = createInference();
  const req: NormalizedRequest = {
    provider: providerId,
    model: modelId,
    apiKey,
    messages: [
      { role: 'system', text: SEED_GENERATOR_SYSTEM_PROMPT },
      { role: 'user', text: userParts.join('\n') },
    ],
    tools: [],
    toolUseEnabled: false,
    ...(signal ? { signal } : {}),
  };

  for await (const evt of client.stream(req)) {
    if (signal?.aborted) return;
    if (evt.kind === 'text') {
      yield evt.chunk;
      continue;
    }
    if (evt.kind === 'error') {
      throw new Error(evt.message);
    }
  }
}
