import { diagnostic, diagnosticSettings } from "./remote-diagnostics";
import { getWorkerVersion } from "../../packages/cli/src/serve/worker/client/connection";
/** Example-host infrastructure: transfer an independent Pyric port to the job
 * worker, so AI still uses the same broker and Studio event stream. No API keys
 * are persisted in the durable spec, and the originating tab owns no request. */
import { initializeApp } from "pyric/app";
import { getGenerativeModel } from "pyric/ai";
import { createTransportAI, unpackAiEvidence } from "pyric/ai/internal";
import { wirePort } from "../../packages/cli/src/serve/worker/client/core";
import {
  aiGenerateContent,
  aiStreamGenerateContent,
  aiCountTokens,
} from "../../packages/cli/src/serve/worker/client/ai";
import type { ClientDb } from "../../packages/cli/src/serve/worker/client/handles";
type AnswerEngine = Parameters<typeof createTransportAI>[2];
import { generationModelOptions } from "./generation-model";

export function modelOnPort(
  port: MessagePort,
  options = generationModelOptions,
) {
  wirePort(port);
  port.start();
  const db: ClientDb = { __kind: "client-db", port };
  const transport = {
    async generateContent(request: Record<string, unknown>, model: string) {
      return unpackAiEvidence(await aiGenerateContent(db, { request, model }));
    },
    async *streamGenerateContent(
      request: Record<string, unknown>,
      model: string,
    ) {
      if (diagnosticSettings()) {
        const began = performance.now();
        void getWorkerVersion(db, {timeoutMs: 5000}).then(
          () => diagnostic("ai-probe-ok", {elapsedMs: performance.now()-began}),
          () => diagnostic("ai-probe-failed", {elapsedMs: performance.now()-began}),
        );
      }
      for await (const chunk of aiStreamGenerateContent(db, { request, model }))
        yield unpackAiEvidence(chunk);
    },
    async countTokens(request: Record<string, unknown>, model: string) {
      return await aiCountTokens(db, { request, model });
    },
  };
  const app = initializeApp(
    { projectId: "kin-demo" },
    "kin-generation-" + crypto.randomUUID(),
  );
  return getGenerativeModel(
    createTransportAI(app, undefined, transport as unknown as AnswerEngine),
    options,
  );
}
