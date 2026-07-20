import { getGenerativeModel } from 'firebase/ai';
import type { Content, EnhancedGenerateContentResponse, GenerativeModel } from 'firebase/ai';
import { ai, auth } from '../firebase/app';
import { type FinishReason, type GenerateReplyInput, type GenerateReplyResult, ServiceError } from '../firebase/types';

const MODEL = 'gemini-2.5-flash';
const MAX_MESSAGES = 40;
const MAX_TEXT = 20_000;
const modeInstructions = {
  explore: 'Help the user explore possibilities. Surface alternatives, assumptions, and useful questions before converging.',
  plan: 'Help the user turn ideas into a practical plan. Clarify the desired outcome, sequence the work, and identify the next concrete step.',
  refine: 'Help the user pressure-test and improve the current direction. Identify weaknesses, tradeoffs, and specific refinements without discarding useful intent.',
} as const;
const modeGenerationConfig = {
  explore: { maxOutputTokens: 6144, thinkingConfig: { thinkingBudget: 768, includeThoughts: true } },
  plan: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } },
  refine: { maxOutputTokens: 6144, thinkingConfig: { thinkingBudget: 768, includeThoughts: true } },
} as const;

const toContent = (role: 'user' | 'assistant' | 'system', text: string): Content => ({
  role: role === 'assistant' ? 'model' : role,
  parts: [{ text: text.slice(0, MAX_TEXT) }],
});

const finishReason = (value: string | undefined): FinishReason => {
  if (value === 'MAX_TOKENS') return 'length';
  if (value === 'SAFETY' || value === 'BLOCKLIST' || value === 'PROHIBITED_CONTENT') return 'safety';
  return value ? 'stop' : null;
};

const resultFromResponse = (response: EnhancedGenerateContentResponse, model: string): GenerateReplyResult => ({
  text: response.text(),
  model,
  inputTokenCount: response.usageMetadata?.promptTokenCount ?? null,
  outputTokenCount: response.usageMetadata?.candidatesTokenCount ?? null,
  finishReason: finishReason(response.candidates?.[0]?.finishReason),
});

const modelFor = (model: string | undefined, mode: GenerateReplyInput['mode']): { name: string; client: GenerativeModel } => {
  const name = model ?? MODEL;
  if (name !== MODEL) throw new ServiceError('invalid-input', 'Unsupported model');
  const selectedMode = mode ?? 'explore';
  return {
    name,
    client: getGenerativeModel(ai, {
      model: name,
      systemInstruction: modeInstructions[selectedMode],
      generationConfig: modeGenerationConfig[selectedMode],
    }),
  };
};

export class AiChatService {
  async generate(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    if (!auth.currentUser) throw new ServiceError('unauthenticated', 'Sign in is required');
    const model = modelFor(input.model, input.mode);
    const contents = input.messages.slice(-MAX_MESSAGES).map((message) => toContent(message.role, message.text));
    try {
      const result = await model.client.generateContent({ contents });
      return resultFromResponse(result.response, model.name);
    } catch (error) {
      throw new ServiceError('provider', 'The AI provider request failed', error);
    }
  }

  async stream(input: GenerateReplyInput, onChunk: (chunk: string) => void, onThought?: (thought: string) => void): Promise<GenerateReplyResult> {
    if (!auth.currentUser) throw new ServiceError('unauthenticated', 'Sign in is required');
    const model = modelFor(input.model, input.mode);
    const contents = input.messages.slice(-MAX_MESSAGES).map((message) => toContent(message.role, message.text));
    try {
      const result = await model.client.generateContentStream({ contents });
      for await (const chunk of result.stream) {
        if (input.signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
        const thought = (chunk as EnhancedGenerateContentResponse & { thoughtSummary?: () => string | undefined }).thoughtSummary?.();
        if (thought) onThought?.(thought);
        const text = chunk.text();
        if (text) onChunk(text);
      }
      return resultFromResponse(await result.response, model.name);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ServiceError('provider', 'The AI provider request failed', error);
    }
  }
}
