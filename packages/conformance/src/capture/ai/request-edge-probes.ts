/**
 * AI Logic generateContent request-edge captures: role-less contents, a
 * top-level string systemInstruction, and the model name gemini-pro. Raw fetch
 * in the installed @firebase/ai request shape against the GoogleAI backend,
 * with an App Check token minted by firebase-admin. Exactly one request per
 * case in REQUEST_EDGE_CASES, three in all.
 */
import { REQUEST_EDGE_CASES, type RequestEdgeCase } from './request-edge-cases.ts';
import { API_VERSION, responseFacts, writeEdgeObservation, type EdgeObservationContext, type RawResult } from './request-edge-observation.ts';
import { redactText } from '../app-check/redact.ts';

export interface RequestEdgeInput {
  context: EdgeObservationContext;
  apiKey: string;
  appCheckToken: string;
}

/**
 * The headers @firebase/ai sends on generateContent with App Check on.
 * Reuse aiLogicHeaders from src/capture/ai/request-headers.ts once #1412 lands.
 */
function requestHeaders(input: RequestEdgeInput): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': input.apiKey, 'X-Firebase-AppCheck': input.appCheckToken };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function generateContent(input: RequestEdgeInput, testCase: RequestEdgeCase): Promise<RawResult> {
  const base = `https://firebasevertexai.googleapis.com/${API_VERSION}/projects/${input.context.projectId}`;
  const response = await fetch(`${base}/models/${testCase.model}:generateContent`, {
    method: 'POST',
    headers: requestHeaders(input),
    body: JSON.stringify(testCase.body),
  });
  return { status: response.status, body: parseJson(await response.text()) };
}

async function captureCase(input: RequestEdgeInput, testCase: RequestEdgeCase): Promise<void> {
  const result = await generateContent(input, testCase);
  writeEdgeObservation(input.context, testCase, {
    request: { model: testCase.model, body: testCase.body, headerNames: Object.keys(requestHeaders(input)) },
    appCheckTokenSource: 'firebase-admin createToken(appId)',
    ...responseFacts(result),
  });
}

export async function runRequestEdgeProbes(input: RequestEdgeInput, failures: string[]): Promise<void> {
  for (const testCase of REQUEST_EDGE_CASES) {
    try {
      await captureCase(input, testCase);
    } catch (error) {
      failures.push(testCase.name);
      console.error(`failed ${testCase.name}: ${redactText(String(error), input.context.secrets)}`);
    }
  }
}
