/**
 * AI Logic's App Check gate on the wire: the ai-probes request shape (raw
 * fetch, x-goog-api-key) sent from Node with no X-Firebase-AppCheck header and
 * with malformed, placeholder, tampered, and valid tokens. Records the HTTP
 * status and error envelope of each; a 200 records only finishReason.
 */
import type { AppCheck } from 'firebase-admin/app-check';
import { redactJson, redactText, tamperSignature } from './redact.ts';
import { writeObservation, type ObservationContext } from './observation-writer.ts';

const MODEL = 'gemini-flash-lite-latest';
const SDK_DUMMY_TOKEN = Buffer.from(JSON.stringify({ error: 'UNKNOWN_ERROR' })).toString('base64');

export interface AiWireInput {
  context: ObservationContext;
  appCheck: AppCheck;
  appId: string;
  apiKey: string;
  /** A valid Admin-minted token from the admin probes, reused to avoid another mint. */
  validToken: string;
  /** enforcementMode of services/firebaseml.googleapis.com read just before the capture. */
  enforcementMode: string;
}

async function generate(input: AiWireInput, appCheckHeader: string | null) {
  const url = `https://firebasevertexai.googleapis.com/v1beta/projects/${input.context.projectId}/models/${MODEL}:generateContent`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-goog-api-key': input.apiKey };
  if (appCheckHeader !== null) headers['X-Firebase-AppCheck'] = appCheckHeader;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with exactly the word: pyric' }] }] }),
  });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (response.status === 200) {
    const candidate = (body?.candidates as { finishReason?: string }[] | undefined)?.[0];
    return { httpStatus: 200, finishReason: candidate?.finishReason ?? null };
  }
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  return {
    httpStatus: response.status,
    isJson: body !== null,
    errorKeySet: error ? Object.keys(error).sort() : [],
    errorCode: error?.code ?? null,
    errorStatus: error?.status ?? null,
    messageText: error?.message ?? null,
    raw: redactJson(body, input.context.secrets),
  };
}

export async function runAiWireProbes(input: AiWireInput, failures: string[]): Promise<void> {
  const secrets = input.context.secrets;
  try {
    const valid = input.validToken;
    if (!valid) throw new Error('no Admin-minted token from the admin probes');
    const behavior = {
      noHeader: await generate(input, null),
      malformedHeader: await generate(input, 'not-a-token'),
      sdkPlaceholderToken: await generate(input, SDK_DUMMY_TOKEN),
      tamperedSignature: await generate(input, tamperSignature(valid)),
      validAdminMintedToken: await generate(input, valid),
    };
    writeObservation(input.context, 'app-check-ai-gate-wire',
      `AI Logic generateContent from Node in the ai-probes request shape (GoogleAI backend, ${MODEL}) with no X-Firebase-AppCheck header, a malformed header, the web SDK placeholder token, an Admin-minted token with one signature character changed, and a valid Admin-minted token. The enforcementMode read for firebaseml.googleapis.com just before the capture is recorded in behavior.`,
      { appCheckEnforcementModeAtCapture: input.enforcementMode, ...behavior }, 'admin');
  } catch (error) {
    failures.push('app-check-ai-gate-wire');
    console.error(`failed app-check-ai-gate-wire: ${redactText(String(error), secrets)}`);
  }
}
