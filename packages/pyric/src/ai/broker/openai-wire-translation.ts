import type {
  GenerateContentRequest,
  WirePart,
  WireResponse,
} from './types.js';

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: Array<{ type: 'function'; function: Record<string, unknown> }>;
  tool_choice?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  response_format?:
    | { type: 'json_object' }
    | {
        type: 'json_schema';
        json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
      };
  frequency_penalty?: number;
  presence_penalty?: number;
}

export interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning?: string;
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAIStreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: Array<Partial<OpenAIToolCall> & { index: number }>;
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function synthToolCallId(name: string, ordinal: number): string {
  return `call_${name}_${ordinal}`;
}

function isModelTurn(role: string | undefined): boolean {
  const upper = (role ?? '').toUpperCase();
  return upper === 'MODEL' || upper === 'ASSISTANT';
}

export function geminiToOpenAIRequest(
  model: string,
  req: GenerateContentRequest,
  stream: boolean,
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  if (req.systemInstruction) {
    const text = (req.systemInstruction.parts ?? []).map((p) => p.text ?? '').join('');
    if (text) messages.push({ role: 'system', content: text });
  }

  const pendingIdsByName = new Map<string, string[]>();
  let callOrdinal = 0;

  for (const content of req.contents ?? []) {
    const isFunctionResponseTurn =
      !isModelTurn(content.role) && content.parts.some((part) => part.functionResponse);
    if (isFunctionResponseTurn) {
      for (const part of content.parts) {
        if (!part.functionResponse) continue;
        const queue = pendingIdsByName.get(part.functionResponse.name) ?? [];
        const id = queue.shift() ?? synthToolCallId(part.functionResponse.name, callOrdinal++);
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify(part.functionResponse.response),
        });
      }
      continue;
    }

    const role = isModelTurn(content.role) ? 'assistant' : 'user';
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];

    for (const part of content.parts) {
      if (part.thought) continue;
      if (typeof part.text === 'string') {
        textParts.push(part.text);
      } else if (part.functionCall) {
        const id = synthToolCallId(part.functionCall.name, callOrdinal++);
        const queue = pendingIdsByName.get(part.functionCall.name) ?? [];
        queue.push(id);
        pendingIdsByName.set(part.functionCall.name, queue);
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      } else if (part.inlineData) {
        textParts.push(`[unsupported inlineData part: ${part.inlineData.mimeType}]`);
      }
    }

    let joinedText: string | null = null;
    if (textParts.length > 0) {
      joinedText = textParts.join('');
    }
    const msg: OpenAIMessage = { role, content: joinedText };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    messages.push(msg);
  }

  const out: OpenAIRequest = { model, messages, stream };
  if (stream) out.stream_options = { include_usage: true };

  const decls = (req.tools ?? []).flatMap((t) => t.functionDeclarations ?? []);
  if (decls.length > 0) {
    out.tools = decls.map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: d.description,
        parameters: normalizeSchema(d.parameters) ?? { type: 'object', properties: {} },
      },
    }));
  }

  const mode = req.toolConfig?.functionCallingConfig?.mode;
  if (mode === 'ANY') out.tool_choice = 'required';
  else if (mode === 'NONE') out.tool_choice = 'none';
  else if (mode === 'AUTO') out.tool_choice = 'auto';

  const g = req.generationConfig;
  if (g) {
    if (g.temperature !== undefined) out.temperature = g.temperature;
    if (g.topP !== undefined) out.top_p = g.topP;
    if (g.maxOutputTokens !== undefined) out.max_tokens = g.maxOutputTokens;
    if (g.stopSequences?.length) out.stop = g.stopSequences;
    if (g.frequencyPenalty !== undefined) out.frequency_penalty = g.frequencyPenalty;
    if (g.presencePenalty !== undefined) out.presence_penalty = g.presencePenalty;
    if (g.responseMimeType === 'application/json') {
      if (g.responseSchema) {
        out.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            schema: normalizeSchema(g.responseSchema)!,
            strict: true,
          },
        };
      } else {
        out.response_format = { type: 'json_object' };
      }
    }
  }

  return out;
}

export function normalizeSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = { ...(schema as Record<string, unknown>) };
  if (typeof s.type === 'string') s.type = s.type.toLowerCase();
  delete s.nullable;
  if (s.properties && typeof s.properties === 'object') {
    s.properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        normalizeSchema(v),
      ]),
    );
  }
  if (s.items) s.items = normalizeSchema(s.items);
  return s;
}

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP',
  content_filter: 'SAFETY',
};

export function mapFinishReason(reason: string | null | undefined): string {
  if (!reason) return 'STOP';
  return FINISH_REASON_MAP[reason] ?? 'OTHER';
}

function parseToolArguments(raw: string): { args: Record<string, unknown>; malformed: boolean } {
  try {
    return { args: JSON.parse(raw || '{}') as Record<string, unknown>, malformed: false };
  } catch {
    return { args: { __malformed: raw }, malformed: true };
  }
}

function messagePartsFromOpenAI(msg: {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  reasoning?: string;
  reasoning_content?: string;
}): WirePart[] {
  const parts: WirePart[] = [];
  const reasoning = msg.reasoning ?? msg.reasoning_content;
  if (reasoning) parts.push({ text: reasoning, thought: true });
  if (msg.content) parts.push({ text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    const { args } = parseToolArguments(tc.function.arguments);
    parts.push({ functionCall: { name: tc.function.name, args } });
  }
  if (parts.length === 0) parts.push({ text: '' });
  return parts;
}

export function openAIToGeminiResponse(resp: OpenAIResponse): WireResponse {
  const choice = resp.choices[0]!;
  const malformedToolArgs = (choice.message.tool_calls ?? []).some(
    (tc) => parseToolArguments(tc.function.arguments).malformed,
  );
  let finishReason = mapFinishReason(choice.finish_reason);
  if (malformedToolArgs) {
    finishReason = 'MALFORMED_FUNCTION_CALL';
  }
  const out: WireResponse = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: messagePartsFromOpenAI(choice.message) },
        finishReason,
      },
    ],
  };
  if (resp.usage) {
    out.usageMetadata = {
      promptTokenCount: resp.usage.prompt_tokens,
      candidatesTokenCount: resp.usage.completion_tokens,
      totalTokenCount: resp.usage.total_tokens,
    };
  }
  return out;
}

export function openAIChunkToParts(chunk: OpenAIStreamChunk): WirePart[] {
  const choice = chunk.choices?.[0];
  const parts: WirePart[] = [];
  const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
  if (reasoning) parts.push({ text: reasoning, thought: true });
  if (choice?.delta?.content) parts.push({ text: choice.delta.content });
  return parts;
}

export class ToolCallBuffer {
  private readonly byIndex = new Map<number, { name: string; args: string }>();

  add(deltas: Array<Partial<OpenAIToolCall> & { index: number }> | undefined): void {
    for (const d of deltas ?? []) {
      const slot = this.byIndex.get(d.index) ?? { name: '', args: '' };
      if (d.function?.name) slot.name += d.function.name;
      if (d.function?.arguments) slot.args += d.function.arguments;
      this.byIndex.set(d.index, slot);
    }
  }

  get size(): number {
    return this.byIndex.size;
  }

  flush(): { parts: WirePart[]; malformed: boolean } {
    const parts: WirePart[] = [];
    let malformed = false;
    const indexes = [...this.byIndex.keys()].sort((a, b) => a - b);
    for (const i of indexes) {
      const { name, args: raw } = this.byIndex.get(i)!;
      const parsed = parseToolArguments(raw);
      if (parsed.malformed) malformed = true;
      parts.push({ functionCall: { name, args: parsed.args } });
    }
    this.byIndex.clear();
    return { parts, malformed };
  }
}

export class SseParser {
  private buffer = '';

  push(text: string): string[] {
    this.buffer += text;
    const payloads: string[] = [];
    for (;;) {
      const lf = this.buffer.indexOf('\n\n');
      const crlf = this.buffer.indexOf('\r\n\r\n');
      let at = lf;
      if (lf === -1) {
        at = crlf;
      } else if (crlf !== -1 && crlf < lf) {
        at = crlf;
      }
      if (at === -1) break;
      const isCrlf = at === crlf && crlf !== -1 && (lf === -1 || crlf < lf);
      const sepLen = isCrlf ? 4 : 2;
      const rawEvent = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + sepLen);
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data: ')) payloads.push(line.slice('data: '.length));
        else if (line.startsWith('data:')) payloads.push(line.slice('data:'.length));
      }
    }
    return payloads;
  }
}

export const DONE_SENTINEL = '[DONE]';
