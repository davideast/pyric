/**
 * `/ai <prompt>` terminal builtin. Asks the configured LLM to
 * translate a natural-language request into a single bash command
 * line, streams the response into the terminal, then leaves the
 * suggested command on the input line so the user can press Enter
 * to run it (or edit first).
 *
 * The system prompt constrains the model to output only a command —
 * no fences, no commentary. We still strip any markdown fences or
 * leading prose defensively before placing the line on the input.
 */

import { createInference, type NormalizedRequest } from '~/lib/llm/inference';
import { PROVIDERS } from '~/lib/llm/registry';
import { useLlmStore } from '~/lib/store/llm';

export interface AiCommandSuggestion {
  command: string;
  raw: string;
}

const SYSTEM_PROMPT = [
  'You translate natural-language requests into a SINGLE bash command line that runs in a virtual shell.',
  'Context: the shell is `just-bash` in the browser, operating on a user OPFS workspace. Working directory: {{CWD}}. Files live under /workspace/.',
  'Output exactly one command line — no markdown fences, no leading prose, no trailing explanation. Newlines are not allowed.',
  'If the request is unclear, ambiguous, or unsafe, output a single line starting with `# ` that briefly explains what you would need to know.',
  'Examples:',
  '  user: "list every tsx file"  -> `find /workspace -name "*.tsx"`',
  '  user: "what is in the readme" -> `cat /workspace/README.md`',
  '  user: "remove all logs" -> `# clarify: remove log statements from source, or delete log files?`',
].join('\n');

/**
 * Strip common artefacts the model adds even when told not to:
 * leading triple-backtick fences, language hint after the fence,
 * surrounding whitespace, leading `$ ` prompt markers.
 */
export function cleanCommand(raw: string): string {
  let value = raw.trim();
  // Strip ```...``` fences with optional language tag.
  const fenceMatch = value.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fenceMatch?.[1]) value = fenceMatch[1].trim();
  // Drop a leading `$ ` or `# ` prompt the model echoes.
  value = value.replace(/^\$\s+/, '');
  // Collapse to first newline — model may have spilled over despite
  // the constraint.
  const newlineIdx = value.indexOf('\n');
  if (newlineIdx >= 0) value = value.slice(0, newlineIdx).trimEnd();
  return value;
}

export interface RunAiOptions {
  /** Called with each text chunk as the model streams. UI hook for
   *  echoing tokens into the terminal. */
  onChunk: (chunk: string) => void;
  signal?: AbortSignal;
  /** Current cwd, inlined into the system prompt so the model can
   *  produce paths relative to where the user already is. */
  cwd: string;
}

/**
 * Stream a command suggestion. Resolves when the stream ends with
 * `{ command, raw }`. The cleaned `command` is what should go onto
 * the input line; `raw` is the unmodified stream concatenation for
 * debug / display.
 */
export async function runAi(prompt: string, options: RunAiOptions): Promise<AiCommandSuggestion> {
  const llm = useLlmStore.getState();
  const provider = PROVIDERS[llm.providerId];
  if (!provider) throw new Error(`no provider configured: ${llm.providerId}`);
  const apiKey = provider.byok.getKey();
  if (!apiKey) {
    throw new Error(
      `no API key for ${llm.providerId} — open the key icon in the top bar to add one`,
    );
  }

  const client = createInference();
  const req: NormalizedRequest = {
    provider: llm.providerId,
    model: llm.modelId,
    apiKey,
    messages: [
      { role: 'system', text: SYSTEM_PROMPT.replace('{{CWD}}', options.cwd) },
      { role: 'user', text: prompt },
    ],
    tools: [],
    toolUseEnabled: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let raw = '';
  for await (const evt of client.stream(req)) {
    if (options.signal?.aborted) break;
    if (evt.kind === 'text') {
      raw += evt.chunk;
      options.onChunk(evt.chunk);
      continue;
    }
    if (evt.kind === 'error') {
      throw new Error(evt.message);
    }
  }
  return { command: cleanCommand(raw), raw };
}
