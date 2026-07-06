/**
 * Streaming prompt-enhancement call.
 *
 * Runs a SINGLE-TURN, NO-TOOLS inference against the same provider +
 * model + key the user has selected in the playground. The system
 * prompt is the condensed shape rules from `system-prompt.ts`; the
 * user message is the raw input. Yields text chunks as they arrive.
 *
 * Cancellable via the supplied `AbortSignal`; the relay's
 * `NormalizedRequest.signal` is plumbed through to the provider's
 * fetch so abort kills the upstream connection promptly.
 */
import type { NormalizedRequest } from '@inbrowser/relay';
import { createInference } from '~/lib/llm/inference';
import { resolveActiveSkills } from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';
import { buildEnhancerPrompt } from './system-prompt';

export interface EnhanceParams {
  rawInput: string;
  providerId: string;
  modelId: string;
  apiKey: string;
  signal?: AbortSignal;
}

export async function* enhancePrompt({
  rawInput,
  providerId,
  modelId,
  apiKey,
  signal,
}: EnhanceParams): AsyncGenerator<string> {
  const client = createInference();
  const req: NormalizedRequest = {
    provider: providerId,
    model: modelId,
    apiKey,
    messages: [
      // Skill-aware: an active skill with an enhancerShape (e.g. Game
      // rules) reshapes the prompt for its domain.
      {
        role: 'system',
        text: buildEnhancerPrompt(
          resolveActiveSkills(useSkillsStore.getState().activeSkillIds),
        ),
      },
      { role: 'user', text: rawInput },
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
      // Bubble the message up as a thrown error so the caller can
      // mark the card as errored. Empty-streams (model emitted no
      // text) are rare for a prompt this prescriptive; the caller
      // handles that by checking whether anything was yielded.
      throw new Error(evt.message);
    }
    // text-only flow; ignore thinking/usage/tool_call events — the
    // enhancer prompt requests plain prose, no tools.
  }
}

/** Word count for the card's 30-50w sweet-spot indicator. Matches the
 *  shape rule in `system-prompt.ts`. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
