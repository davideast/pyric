import { getGenerativeModel } from 'firebase/ai';
import type { Content, EnhancedGenerateContentResponse, GenerativeModel } from 'firebase/ai';
import { ai, auth } from '../firebase/app';
import { type FinishReason, type GenerateReplyInput, type GenerateReplyResult, ServiceError } from '../firebase/types';

const MODEL = 'gemini-3.5-flash';
const MAX_MESSAGES = 40;
const MAX_TEXT = 20_000;
const modeInstructions = {
  explore: 'Help the user explore possibilities. Surface alternatives, assumptions, and useful questions before converging.',
  plan: 'Help the user turn ideas into a practical plan. Clarify the desired outcome, sequence the work, and identify the next concrete step.',
  refine: 'Help the user pressure-test and improve the current direction. Identify weaknesses, tradeoffs, and specific refinements without discarding useful intent.',
  direct: 'You are a direct, helpful AI assistant. Answer questions clearly and accurately without assumptions.',
} as const;
const modeGenerationConfig = {
  explore: { maxOutputTokens: 6144, thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } },
  plan: { maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true } },
  refine: { maxOutputTokens: 6144, thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } },
  direct: { maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true } },
} as const;

const toContent = (role: 'user' | 'assistant' | 'system', text: string): Content => {
  let mappedRole: 'user' | 'model' | 'system' = 'user';
  const isAssistant = role === 'assistant';
  if (isAssistant) {
    mappedRole = 'model';
  } else {
    const isSystem = role === 'system';
    if (isSystem) {
      mappedRole = 'system';
    }
  }
  return {
    role: mappedRole,
    parts: [{ text: text.slice(0, MAX_TEXT) }],
  };
};

const finishReason = (value: string | undefined): FinishReason => {
  const isMaxTokens = value === 'MAX_TOKENS';
  if (isMaxTokens) {
    return 'length';
  }
  const isSafety = value === 'SAFETY' || value === 'BLOCKLIST' || value === 'PROHIBITED_CONTENT';
  if (isSafety) {
    return 'safety';
  }
  const hasValue = value !== undefined && value !== null && value !== '';
  if (hasValue) {
    return 'stop';
  }
  return null;
};

const resultFromResponse = (response: EnhancedGenerateContentResponse, model: string): GenerateReplyResult => {
  const meta = response.usageMetadata;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  const hasMeta = meta !== undefined && meta !== null;
  if (hasMeta) {
    const hasPromptTokens = meta.promptTokenCount !== undefined && meta.promptTokenCount !== null;
    if (hasPromptTokens) {
      inputTokens = meta.promptTokenCount;
    }
    const hasCandidatesTokens = meta.candidatesTokenCount !== undefined && meta.candidatesTokenCount !== null;
    if (hasCandidatesTokens) {
      outputTokens = meta.candidatesTokenCount;
    }
  }
  return {
    text: response.text(),
    model,
    inputTokenCount: inputTokens,
    outputTokenCount: outputTokens,
    finishReason: finishReason(response.candidates?.[0]?.finishReason),
  };
};

const modelFor = (model: string | undefined, mode: GenerateReplyInput['mode']): { name: string; client: GenerativeModel } => {
  let name = MODEL;
  const hasModel = model !== undefined && model !== null && model !== '';
  if (hasModel) {
    name = model;
  }
  const isSupported = name === MODEL;
  if (!isSupported) {
    throw new ServiceError('invalid-input', 'Unsupported model');
  }
  let selectedMode: 'explore' | 'plan' | 'refine' | 'direct' = 'explore';
  const hasMode = mode !== undefined && mode !== null;
  if (hasMode) {
    selectedMode = mode;
  }
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
    const hasUser = auth.currentUser !== null && auth.currentUser !== undefined;
    if (!hasUser) {
      throw new ServiceError('unauthenticated', 'Sign in is required');
    }
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
    const hasUser = auth.currentUser !== null && auth.currentUser !== undefined;
    if (!hasUser) {
      throw new ServiceError('unauthenticated', 'Sign in is required');
    }
    const model = modelFor(input.model, input.mode);
    const contents = input.messages.slice(-MAX_MESSAGES).map((message) => toContent(message.role, message.text));
    try {
      const result = await model.client.generateContentStream({ contents });
      for await (const chunk of result.stream) {
        const isAborted = input.signal?.aborted === true;
        if (isAborted) {
          throw new DOMException('Generation cancelled', 'AbortError');
        }
        let thought: string | undefined = undefined;
        const hasThoughtSummary = typeof (chunk as { thoughtSummary?: () => string | undefined }).thoughtSummary === 'function';
        if (hasThoughtSummary) {
          thought = (chunk as { thoughtSummary: () => string | undefined }).thoughtSummary();
        } else {
          const parts = chunk.candidates?.[0]?.content?.parts;
          const hasParts = parts !== undefined && parts !== null;
          if (hasParts) {
            const thoughtStrings: string[] = [];
            for (const part of parts) {
              const isThoughtPart = part.thought === true;
              if (isThoughtPart) {
                const partText = part.text;
                const hasPartText = typeof partText === 'string' && partText.length > 0;
                if (hasPartText) {
                  thoughtStrings.push(partText);
                }
              }
            }
            const hasThoughtStrings = thoughtStrings.length > 0;
            if (hasThoughtStrings) {
              thought = thoughtStrings.join('');
            }
          }
        }
        const hasThoughtStr = typeof thought === 'string' && thought.length > 0;
        if (hasThoughtStr) {
          const validThought = thought as string;
          const hasOnThought = typeof onThought === 'function';
          if (hasOnThought) {
            onThought(validThought);
          }
        }
        let text: string | undefined = undefined;
        const hasTextFn = typeof chunk.text === 'function';
        if (hasTextFn) {
          text = chunk.text();
        } else {
          const parts = chunk.candidates?.[0]?.content?.parts;
          const hasParts = parts !== undefined && parts !== null;
          if (hasParts) {
            const textStrings: string[] = [];
            for (const part of parts) {
              const isThoughtPart = part.thought === true;
              if (!isThoughtPart) {
                const partText = part.text;
                const hasPartText = typeof partText === 'string' && partText.length > 0;
                if (hasPartText) {
                  textStrings.push(partText);
                }
              }
            }
            const hasTextStrings = textStrings.length > 0;
            if (hasTextStrings) {
              text = textStrings.join('');
            }
          }
        }
        const hasTextStr = typeof text === 'string' && text.length > 0;
        if (hasTextStr) {
          const validText = text as string;
          onChunk(validText);
        }
      }
      return resultFromResponse(await result.response, model.name);
    } catch (error) {
      const isAbortError = error instanceof DOMException && error.name === 'AbortError';
      if (isAbortError) {
        throw error;
      }
      throw new ServiceError('provider', 'The AI provider request failed', error);
    }
  }
}
