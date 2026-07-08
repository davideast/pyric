import type {
  CallbackProvider,
  ModelClient,
  ModelErrorEvent,
  ModelEvent,
  ProviderChatMessage,
  ProviderToolDecl,
  ProviderTurnResult,
} from '@inbrowser/agent';

interface StructuredProviderError extends Error {
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

function modelErrorEvent(error: unknown): ModelErrorEvent {
  if (!(error instanceof Error)) {
    return { kind: 'error', message: String(error) };
  }
  const structured = error as StructuredProviderError;
  return {
    kind: 'error',
    message: error.message,
    ...(structured.code ? { code: structured.code } : {}),
    ...(typeof structured.retryable === 'boolean' ? { retryable: structured.retryable } : {}),
    ...(structured.details ? { details: structured.details } : {}),
  };
}

export function callbackProviderAsModelClient(
  provider: CallbackProvider,
  id: string,
): ModelClient {
  return {
    id,
    supportsTools: provider.supportsTools ?? typeof provider.chatWithTools === 'function',
    chat(req, signal) {
      return drive(provider, req, signal);
    },
  };
}

async function* drive(
  provider: CallbackProvider,
  req: Parameters<ModelClient['chat']>[0],
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const queue: ModelEvent[] = [];
  let resolver: (() => void) | null = null;
  let done = false;

  function push(ev: ModelEvent) {
    queue.push(ev);
    resolver?.();
    resolver = null;
  }

  function finish() {
    done = true;
    resolver?.();
    resolver = null;
  }

  const callbacks = {
    onText: (chunk: string) => push({ kind: 'text', text: chunk }),
    onThinking: (chunk: string) => push({ kind: 'thinking', text: chunk }),
    onToolCall: (call: {
      callId: string;
      name: string;
      args: unknown;
      signature?: string;
    }) =>
      push({
        kind: 'tool_call',
        id: call.callId,
        name: call.name,
        args: call.args,
        ...(call.signature ? { signature: call.signature } : {}),
      }),
    signal,
  };

  const messages: ProviderChatMessage[] = req.messages.map((m) => ({
    role: m.role,
    text: m.text,
    ...(m.toolCalls
      ? {
          toolCalls: m.toolCalls.map((tc) => ({
            callId: tc.id,
            name: tc.name,
            args: tc.args,
            ...(tc.signature ? { signature: tc.signature } : {}),
          })),
        }
      : {}),
    ...(m.toolCallId ? { callId: m.toolCallId } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.resultJson !== undefined ? { resultJson: m.resultJson } : {}),
  }));

  const tools: ProviderToolDecl[] = req.tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));

  let result: ProviderTurnResult | undefined;
  let error: unknown;
  const driver = (async () => {
    try {
      if (req.toolUseEnabled && provider.chatWithTools) {
        result = await provider.chatWithTools(messages, tools, callbacks);
      } else {
        const prompt = messages
          .filter((m) => m.role === 'user' || m.role === 'system')
          .map((m) => m.text ?? '')
          .filter(Boolean)
          .join('\n\n');
        result = await provider.ask(prompt, callbacks.onText, { signal });
      }
    } catch (e) {
      error = e;
    } finally {
      finish();
    }
  })();

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        resolver = resolve;
      });
    }
    const next = queue.shift();
    if (next) yield next;
  }
  await driver;

  if (error) {
    yield modelErrorEvent(error);
    return;
  }

  yield {
    kind: 'usage',
    usage: {
      promptTokens: result?.usage?.promptTokens ?? 0,
      outputTokens: result?.usage?.outputTokens ?? 0,
      ...(result?.usage?.cachedTokens !== undefined
        ? { cachedTokens: result.usage.cachedTokens }
        : {}),
      ...(result?.usage?.reasoningTokens !== undefined
        ? { reasoningTokens: result.usage.reasoningTokens }
        : {}),
      ...(typeof result?.usage?.costUsd === 'number' ? { costUsd: result.usage.costUsd } : {}),
    },
  };
}
