import { deleteApp, initializeApp } from 'firebase/app';
import { AIError, getAI, getGenerativeModel } from 'firebase/ai';
import type { Probe } from '../../rigs/types.ts';

interface StreamOutcome {
  yieldedTexts: string[];
  yieldedChunkCount: number;
  aggregateText: string | null;
  threw: {
    isAIError: boolean;
    code: string | null;
    name: string | null;
  } | null;
}

function makeSseResponse(frames: string): Response {
  const bytes = new TextEncoder().encode(frames);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function runStreamCase(
  model: ReturnType<typeof getGenerativeModel>,
  setNextResponse: (res: Response) => void,
  frames: string,
): Promise<StreamOutcome> {
  setNextResponse(makeSseResponse(frames));
  const yieldedTexts: string[] = [];
  let yieldedChunkCount = 0;
  try {
    const result = await model.generateContentStream('probe mid-stream error');
    result.response.catch(() => undefined);
    for await (const chunk of result.stream) {
      yieldedChunkCount += 1;
      yieldedTexts.push(chunk.text());
    }
    const aggregate = await result.response;
    return {
      yieldedTexts,
      yieldedChunkCount,
      aggregateText: aggregate.text(),
      threw: null,
    };
  } catch (err) {
    let code: string | null = null;
    let name: string | null = null;
    if (err !== null && typeof err === 'object') {
      const record = err as { code?: unknown; name?: unknown };
      if (typeof record.code === 'string') code = record.code;
      if (typeof record.name === 'string') name = record.name;
    }
    return {
      yieldedTexts,
      yieldedChunkCount,
      aggregateText: null,
      threw: {
        isAIError: err instanceof AIError,
        code,
        name,
      },
    };
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  description:
    'Staged offline firebase/ai generateContentStream() behavior on 200 SSE streams carrying mid-stream JSON error envelopes (object and array-wrapped) and truncated trailing frames (#1753), awaiting live production wire capture.',
  async observe() {
    const originalFetch = globalThis.fetch;
    let nextResponse: Response | undefined;
    const setNextResponse = (res: Response): void => {
      nextResponse = res;
    };
    globalThis.fetch = Object.assign(
      async () => {
        if (nextResponse === undefined) {
          throw new Error('Missing staged SSE response in offline stream probe');
        }
        const current = nextResponse;
        nextResponse = undefined;
        return current;
      },
      { preconnect: originalFetch.preconnect },
    );

    const app = initializeApp(
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-mid-stream-error',
        appId: '1:100000000000:web:deadbeef1753',
      },
      'ai-offline-mid-stream-error-handling',
    );

    try {
      const model = getGenerativeModel(getAI(app), { model: 'gemini-flash-lite-latest' });

      const firstChunk =
        'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"alpha "}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5}}\r\n\r\n';
      const objectErrorChunk =
        'data: {"error":{"code":500,"message":"Internal stream error","status":"INTERNAL"}}\r\n\r\n';
      const arrayErrorChunk =
        'data: [{"error":{"code":500,"message":"Array stream error","status":"INTERNAL"}}]\r\n\r\n';
      const finalChunk =
        'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"beta"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}\r\n\r\n';

      const objectMidStreamError = await runStreamCase(
        model,
        setNextResponse,
        firstChunk + objectErrorChunk + finalChunk,
      );
      const arrayMidStreamError = await runStreamCase(
        model,
        setNextResponse,
        firstChunk + arrayErrorChunk + finalChunk,
      );
      const trailingUnparsedFrame = await runStreamCase(
        model,
        setNextResponse,
        `${firstChunk}data: {"error":`,
      );

      return {
        objectMidStreamError,
        arrayMidStreamError,
        trailingUnparsedFrame,
      };
    } finally {
      globalThis.fetch = originalFetch;
      await deleteApp(app);
    }
  },
};
