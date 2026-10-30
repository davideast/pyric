/**
 * Firebase AI Logic probes — the first `ai-*` observations.
 *
 * Captures what production Firebase AI Logic (the firebasevertexai.googleapis.com
 * proxy in front of the Gemini Developer API) actually does, in the house
 * observation format, using the web app config provisioned in wayfinder
 * ticket #93.
 *
 * The surface is nondeterministic in its payload, so these probes freeze only
 * deterministic facts as claims: error envelopes, SSE framing, envelope shape,
 * field presence, and countTokens behavior. Generated text is never a claim.
 * Each observation still carries the full raw envelope under `behavior.raw`
 * as a corpus sample for the scripted answer engine; raw values are samples,
 * the distilled facts are the observation.
 *
 * Transport is raw fetch replicating the installed SDK's request shape
 * (URL construction and headers from @firebase/ai requests/request.ts), NOT
 * the SDK itself: the SDK decorates responses client-side (adds candidate
 * `index`, `inferenceSource`) and would contaminate wire truth. `fbSdkVersion`
 * records the installed umbrella `firebase` version (the convention the
 * observation version guard enforces); the @firebase/ai request shape these
 * probes replicate is that umbrella's pinned ai subpackage.
 *
 * rowIds come from the registry rows that cite each capture, so a re-capture
 * keeps the links those rows hold.
 *
 * App Check: AI Logic on the oracle project answers 403 to any request without
 * a valid App Check token (#1199), so every request carries one minted with
 * firebase-admin createToken. Error-envelope probes send it too, so they reach
 * the error they pin. The token is never printed or written.
 *
 * Function responses ride under role `user`: production refuses the role
 * `function` that @firebase/ai 2.12.0's ChatSession sends (#1410), and
 * `ai-error-function-role-refused` pins that refusal.
 *
 * Requires: PYRIC_AI_FIREBASE_CONFIG (single-line JSON web app config) and
 * an oracle credential for the same project: PYRIC_ORACLE_SA_PATH, or
 * PYRIC_ORACLE_PROJECT_ID with Application Default Credentials.
 * Run: bun --env-file=<repo>/.env packages/conformance/src/ai-probes.ts [--only=<name>,<name>]
 * `--only` runs just the named probes, so a re-capture spends only the
 * requests it needs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { resolvedFirebaseVersion } from './package-version.ts';
import { loadOracleServiceAccount, oracleCredentialConfigured } from './oracle-credential.ts';
import { mintWithRetry } from './capture/app-check/mint.ts';
import { citingRowIds } from './capture/app-check/observation-writer.ts';
import { aiLogicHeaders, tokenNeedsRemint, type MintedToken } from './capture/ai/request-headers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// ai-* observations belong to the 'ai' surface.
const OBS_DIR = join(HERE, '..', 'observations', 'ai');

const rawConfig = process.env.PYRIC_AI_FIREBASE_CONFIG;
if (!rawConfig || !oracleCredentialConfigured(process.env)) {
  console.error('✗ PYRIC_AI_FIREBASE_CONFIG and PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID are required; nothing was run.');
  process.exit(1);
}
const config = JSON.parse(rawConfig) as { apiKey: string; appId: string; projectId: string };
const { apiKey, appId, projectId } = config;
const serviceAccount = loadOracleServiceAccount();
if (serviceAccount.project_id !== projectId) {
  console.error('✗ PYRIC_AI_FIREBASE_CONFIG and the oracle credential name different projects; nothing was run.');
  process.exit(1);
}

const adminApp = initializeApp(
  { credential: serviceAccount.credential, projectId },
  `ai-probes-${Date.now().toString(36)}`,
);
const appCheck = getAppCheck(adminApp);
let current: (MintedToken & { token: string }) | null = null;

/** The App Check token for the next request, minted again near expiry. */
async function appCheckToken(): Promise<string> {
  if (current && !tokenNeedsRemint(current, Date.now())) return current.token;
  const mintedAtMs = Date.now();
  const minted = await mintWithRetry(appCheck, appId);
  current = { token: minted.token, ttlMillis: minted.ttlMillis, mintedAtMs };
  return current.token;
}

const fbSdkVersion = resolvedFirebaseVersion();

const API_VERSION = 'v1beta';
const BASE = `https://firebasevertexai.googleapis.com/${API_VERSION}/projects/${projectId}`;
const MODEL = 'gemini-flash-lite-latest';

interface RawResult {
  status: number;
  body: unknown;
  text: string;
}

async function post(path: string, payload: unknown, overrideKey?: string): Promise<RawResult> {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: aiLogicHeaders(overrideKey ?? apiKey, await appCheckToken()),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

function writeObservation(name: string, description: string, behavior: Record<string, unknown>): void {
  const obs = {
    name,
    matrixRow: '',
    rowIds: citingRowIds(name),
    description,
    observedAt: new Date().toISOString(),
    fbSdkVersion,
    projectId,
    apiVersion: API_VERSION,
    model: MODEL,
    behavior,
  };
  writeFileSync(join(OBS_DIR, `${name}.json`), JSON.stringify(obs, null, 2) + '\n');
  console.log(`✓ ${name}`);
}

const sortedKeys = (o: unknown): string[] => (o && typeof o === 'object' ? Object.keys(o as object).sort() : []);

const userTurn = (text: string) => ({ role: 'user', parts: [{ text }] });
const MINIMAL = { contents: [userTurn('Reply with exactly the word: pyric')] };

type ErrorEnvelope = { error?: { code?: number; message?: string; status?: string; details?: unknown[] } };

function errorFacts(r: RawResult) {
  const err = (r.body as ErrorEnvelope)?.error;
  return {
    httpStatus: r.status,
    isJson: r.body !== null,
    errorKeySet: sortedKeys(err),
    errorCode: err?.code,
    errorStatus: err?.status,
    detailTypes: Array.isArray(err?.details)
      ? [...new Set(err.details.map((d) => (d as { '@type'?: string })['@type'] ?? 'unknown'))].sort()
      : [],
    messageText: err?.message,
  };
}

const onlyArg = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const onlyProbes = onlyArg ? new Set(onlyArg.split(',').filter((name) => name.length > 0)) : null;

let failures = 0;
async function probe(name: string, fn: () => Promise<void>): Promise<void> {
  if (onlyProbes && !onlyProbes.has(name)) return;
  onlyProbes?.delete(name);
  try {
    await fn();
  } catch (e) {
    failures++;
    console.error(`✗ ${name}: ${e}`);
  }
}

// 1. Minimal generateContent: the raw success envelope shape.
await probe('ai-generate-minimal-envelope', async () => {
  const r = await post(`models/${MODEL}:generateContent`, MINIMAL);
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${r.text}`);
  const body = r.body as Record<string, unknown>;
  const candidate = (body.candidates as Record<string, unknown>[])[0]!;
  const content = candidate.content as Record<string, unknown>;
  const usage = body.usageMetadata as Record<string, unknown>;
  writeObservation(
    'ai-generate-minimal-envelope',
    'Raw wire envelope of a minimal generateContent on the GoogleAI backend. Facts are the key sets and enum values; generated text in raw is a nondeterministic sample. Note: candidate `index` and `inferenceSource` are ABSENT on the wire (the SDK adds them client-side), and usageMetadata carries `serviceTier`, which the SDK typings do not declare.',
    {
      topLevelKeySet: sortedKeys(body),
      candidateKeySet: sortedKeys(candidate),
      candidateHasIndexOnWire: 'index' in candidate,
      contentRole: content.role,
      contentKeySet: sortedKeys(content),
      finishReason: candidate.finishReason,
      usageKeySet: sortedKeys(usage),
      usageServiceTierPresent: 'serviceTier' in usage,
      modelVersionPresent: 'modelVersion' in body,
      modelVersion: body.modelVersion ?? null,
      responseIdPresent: 'responseId' in body,
      raw: body,
    },
  );
});

// 2. Streaming: raw SSE framing of streamGenerateContent.
await probe('ai-generate-stream-framing', async () => {
  const r = await post(`models/${MODEL}:streamGenerateContent?alt=sse`, {
    contents: [userTurn('Count from 1 to 10, digits separated by spaces.')],
  });
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${r.text}`);
  const rawText = r.text;
  const usesCrlf = rawText.includes('\r\n\r\n');
  const events = rawText.split(usesCrlf ? '\r\n\r\n' : '\n\n').filter((e) => e.trim().length > 0);
  const allDataPrefixed = events.every((e) => e.startsWith('data: '));
  const parsed = events.map((e) => JSON.parse(e.slice('data: '.length)) as Record<string, unknown>);
  const finishChunks = parsed
    .map((p, i) => ({ i, c: (p.candidates as Record<string, unknown>[] | undefined)?.[0] }))
    .filter((x) => x.c && 'finishReason' in x.c)
    .map((x) => x.i);
  const usageChunks = parsed.map((p, i) => ('usageMetadata' in p ? i : -1)).filter((i) => i >= 0);
  writeObservation(
    'ai-generate-stream-framing',
    'Raw SSE framing of streamGenerateContent?alt=sse. Every event is `data: <complete GenerateContentResponse JSON>`; separator and which chunks carry finishReason/usageMetadata are the framing contract a mirror must reproduce.',
    {
      httpStatus: r.status,
      eventCount: parsed.length,
      allEventsDataPrefixed: allDataPrefixed,
      separatorIsCrlfCrlf: usesCrlf,
      everyEventParsesAsJson: true,
      everyEventHasCandidatesOrUsage: parsed.every((p) => 'candidates' in p || 'usageMetadata' in p),
      finishReasonChunkIndexes: finishChunks,
      finishReasonOnlyOnLastChunk: finishChunks.length === 1 && finishChunks[0] === parsed.length - 1,
      usageMetadataChunkIndexes: usageChunks,
      rawFrames: rawText,
    },
  );
});

// 3. countTokens: envelope shape plus determinism across two identical calls.
await probe('ai-counttokens-envelope', async () => {
  const payload = { contents: [userTurn('The quick brown fox jumps over the lazy dog.')] };
  const a = await post(`models/${MODEL}:countTokens`, payload);
  const b = await post(`models/${MODEL}:countTokens`, payload);
  if (a.status !== 200 || b.status !== 200) throw new Error(`expected 200/200, got ${a.status}/${b.status}`);
  const bodyA = a.body as Record<string, unknown>;
  const bodyB = b.body as Record<string, unknown>;
  writeObservation(
    'ai-counttokens-envelope',
    'countTokens raw envelope on the GoogleAI backend, called twice with an identical payload to record whether token counting is deterministic.',
    {
      topLevelKeySet: sortedKeys(bodyA),
      totalTokens: bodyA.totalTokens,
      deterministicAcrossTwoCalls: JSON.stringify(bodyA) === JSON.stringify(bodyB),
      raw: bodyA,
    },
  );
});

// 4-8. Error envelopes: deterministic rejection shapes.
await probe('ai-error-unknown-model', async () => {
  const r = await post('models/not-a-real-model:generateContent', MINIMAL);
  if (r.status === 200) throw new Error('expected an error');
  writeObservation(
    'ai-error-unknown-model',
    'Error envelope for a model name production has never served.',
    { ...errorFacts(r), raw: r.body },
  );
});

await probe('ai-error-retired-model', async () => {
  const r = await post('models/gemini-1.5-flash:generateContent', MINIMAL);
  if (r.status === 200) throw new Error('expected an error');
  writeObservation(
    'ai-error-retired-model',
    'Error envelope for a retired model family (Gemini 1.5, retired 2025-09-24 per the message text). Distinct from unknown-model: production distinguishes never-existed from retired.',
    { ...errorFacts(r), raw: r.body },
  );
});

await probe('ai-error-bad-api-key', async () => {
  const r = await post(`models/${MODEL}:generateContent`, MINIMAL, 'not-a-real-key');
  if (r.status === 200) throw new Error('expected an error');
  writeObservation(
    'ai-error-bad-api-key',
    'Error envelope for an invalid API key. detailTypes is recorded as a set: the messaging effort found details ordering is not stable across cases.',
    { ...errorFacts(r), raw: r.body },
  );
});

await probe('ai-error-empty-contents', async () => {
  const r = await post(`models/${MODEL}:generateContent`, { contents: [] });
  if (r.status === 200) throw new Error('expected an error');
  writeObservation(
    'ai-error-empty-contents',
    'Error envelope when contents is an empty array.',
    { ...errorFacts(r), raw: r.body },
  );
});

await probe('ai-error-bad-role', async () => {
  const r = await post(`models/${MODEL}:generateContent`, {
    contents: [{ role: 'banana', parts: [{ text: 'hi' }] }],
  });
  if (r.status === 200) throw new Error('expected an error');
  writeObservation(
    'ai-error-bad-role',
    'Error envelope for an invalid content role.',
    { ...errorFacts(r), raw: r.body },
  );
});

// Roles `system` and `assistant` inside `contents`: the bad-role text lists
// MODEL, USER, while the function refusal lists both of these. Each probe
// records whatever production answers, acceptance or refusal.
function roleOutcome(r: RawResult): Record<string, unknown> {
  if (r.status !== 200) return { accepted: false, ...errorFacts(r), raw: r.body };
  const body = r.body as Record<string, unknown>;
  const candidate = (body.candidates as Record<string, unknown>[] | undefined)?.[0];
  const parts = (candidate?.content as { parts?: Record<string, unknown>[] } | undefined)?.parts ?? [];
  return {
    accepted: true,
    httpStatus: r.status,
    finishReason: candidate?.finishReason,
    answerHasTextPart: parts.some((p) => typeof p.text === 'string'),
    topLevelKeySet: sortedKeys(body),
    raw: body,
  };
}

await probe('ai-contents-role-system', async () => {
  const r = await post(`models/${MODEL}:generateContent`, {
    contents: [
      { role: 'system', parts: [{ text: 'You only ever reply with the word: pyric' }] },
      userTurn('Say anything.'),
    ],
  });
  writeObservation(
    'ai-contents-role-system',
    'A generateContent whose contents opens with a turn under role system, followed by a user turn. No tools. Records whether production accepts role system inside contents (the top-level systemInstruction is a separate field, see ai-system-instruction-accepted).',
    roleOutcome(r),
  );
});

await probe('ai-contents-role-assistant', async () => {
  const r = await post(`models/${MODEL}:generateContent`, {
    contents: [
      userTurn('Reply with exactly the word: pyric'),
      { role: 'assistant', parts: [{ text: 'pyric' }] },
      userTurn('Reply with exactly the word: pyric'),
    ],
  });
  writeObservation(
    'ai-contents-role-assistant',
    'A generateContent whose contents carries a prior answer under role assistant between two user turns. No tools. Records whether production accepts role assistant inside contents.',
    roleOutcome(r),
  );
});

// The model turn from ai-function-call-shape: this run's response when that
// probe ran, otherwise the committed capture. Its request is the same one the
// round trip needs first, so threading it back saves a request per run.
let capturedFunctionCallTurn: unknown = null;

function functionCallTurn(): unknown {
  if (capturedFunctionCallTurn !== null) return capturedFunctionCallTurn;
  const capture = JSON.parse(readFileSync(join(OBS_DIR, 'ai-function-call-shape.json'), 'utf8')) as {
    behavior: { raw: { candidates: { content: unknown }[] } };
  };
  return capture.behavior.raw.candidates[0]!.content;
}

// 9. Function calling: the functionCall part shape under forced tool use.
await probe('ai-function-call-shape', async () => {
  const r = await post(`models/${MODEL}:generateContent`, {
    contents: [userTurn('What is the weather in Paris?')],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: {
              type: 'OBJECT',
              properties: { city: { type: 'STRING' } },
              required: ['city'],
            },
          },
        ],
      },
    ],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
  });
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${r.text}`);
  const body = r.body as Record<string, unknown>;
  const candidate = (body.candidates as Record<string, unknown>[])[0]!;
  const parts = (candidate.content as { parts: Record<string, unknown>[] }).parts;
  const fcPart = parts.find((p) => 'functionCall' in p) as { functionCall?: { name?: string; args?: unknown } };
  capturedFunctionCallTurn = candidate.content;
  writeObservation(
    'ai-function-call-shape',
    'functionCall part shape under toolConfig mode ANY. The fact that args arrives as a parsed JSON object (not a string) is the load-bearing difference from OpenAI-shaped tool_calls.',
    {
      httpStatus: r.status,
      functionCallPartPresent: fcPart !== undefined,
      functionCallKeySet: sortedKeys(fcPart?.functionCall),
      functionCallName: fcPart?.functionCall?.name,
      argsIsObjectNotString: typeof fcPart?.functionCall?.args === 'object',
      finishReason: candidate.finishReason,
      raw: body,
    },
  );
});

// 10a. Function round trip WITHOUT thoughtSignature: production rejects it.
// Found by accident on 2026-07-10: a hand-built model turn (what a naive
// mirror, translator, or replayed history would produce) is a 400.
const WEATHER_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: {
          type: 'OBJECT',
          properties: { city: { type: 'STRING' } },
          required: ['city'],
        },
      },
    ],
  },
];

const functionResponseTurn = (role: 'user' | 'function') => ({
  role,
  parts: [{ functionResponse: { name: 'get_weather', response: { temperature: '22C', sky: 'clear' } } }],
});

await probe('ai-error-fncall-missing-thought-signature', async () => {
  const r = await post(`models/${MODEL}:generateContent`, {
    contents: [
      userTurn('What is the weather in Paris?'),
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
      functionResponseTurn('user'),
    ],
    tools: WEATHER_TOOLS,
  });
  if (r.status === 200) throw new Error('expected an error');
  writeObservation(
    'ai-error-fncall-missing-thought-signature',
    'A function-calling round trip whose model functionCall turn lacks thoughtSignature is REJECTED 400 INVALID_ARGUMENT. The function response rides under role user, because production refuses role function (ai-error-function-role-refused) before it checks the signature. No SDK typing or reference doc states this; the error message cites ai.google.dev/gemini-api/docs/thought-signatures and names the call as `default_api:get_weather`. A mirror and any translation engine must mint and thread thought signatures through tool round trips.',
    { ...errorFacts(r), raw: r.body },
  );
});

// 10b. Function response round: accepted when the model turn is threaded
// verbatim from a real response (thoughtSignature preserved).
await probe('ai-function-response-round', async () => {
  const modelTurn = functionCallTurn();
  const r = await post(`models/${MODEL}:generateContent`, {
    contents: [userTurn('What is the weather in Paris?'), modelTurn, functionResponseTurn('user')],
    tools: WEATHER_TOOLS,
  });
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${r.text}`);
  const body = r.body as Record<string, unknown>;
  const candidate = (body.candidates as Record<string, unknown>[])[0]!;
  const parts = (candidate.content as { parts: Record<string, unknown>[] }).parts;
  writeObservation(
    'ai-function-response-round',
    'A full function-calling round trip is accepted when the model functionCall turn is threaded back verbatim from a real response, preserving thoughtSignature (see ai-error-fncall-missing-thought-signature for the rejection without it). The model turn is the one in ai-function-call-shape, and the function response rides under role user (see ai-error-function-role-refused).',
    {
      httpStatus: r.status,
      finishReason: candidate.finishReason,
      answerHasTextPart: parts.some((p) => typeof p.text === 'string'),
      answerHasFunctionCallPart: parts.some((p) => 'functionCall' in p),
      threadedModelTurnHadThoughtSignature: JSON.stringify(modelTurn).includes('thoughtSignature'),
      raw: body,
    },
  );
});

// 10c. The same round trip with the function response under role `function`,
// the role @firebase/ai 2.12.0's ChatSession sends: production refuses it.
await probe('ai-error-function-role-refused', async () => {
  const r = await post(`models/${MODEL}:generateContent`, {
    contents: [userTurn('What is the weather in Paris?'), functionCallTurn(), functionResponseTurn('function')],
    tools: WEATHER_TOOLS,
  });
  if (r.status === 200) throw new Error('expected an error');
  writeObservation(
    'ai-error-function-role-refused',
    'The accepted round trip of ai-function-response-round, with the function response under role function instead of user, is refused 400 INVALID_ARGUMENT. @firebase/ai 2.12.0 ChatSession sends role function for function responses, so a real SDK chat with tools fails here. The message names the refused role and lists a longer role vocabulary than ai-error-bad-role.',
    { ...errorFacts(r), raw: r.body },
  );
});

// 11. Structured output: responseSchema constrains output to parseable JSON.
await probe('ai-structured-output-shape', async () => {
  const r = await post(`models/${MODEL}:generateContent`, {
    contents: [userTurn('Give me one English word for fire.')],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { word: { type: 'STRING' } }, required: ['word'] },
    },
  });
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${r.text}`);
  const body = r.body as Record<string, unknown>;
  const candidate = (body.candidates as Record<string, unknown>[])[0]!;
  const text = (candidate.content as { parts: { text?: string }[] }).parts[0]?.text ?? '';
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  writeObservation(
    'ai-structured-output-shape',
    'responseMimeType application/json plus responseSchema yields a text part that parses as JSON conforming to the schema key set.',
    {
      httpStatus: r.status,
      textParsesAsJson: parsed !== null,
      parsedKeySet: sortedKeys(parsed),
      finishReason: candidate.finishReason,
      raw: body,
    },
  );
});

// 12. Thinking: does includeThoughts surface thought parts on this model?
await probe('ai-thinking-thought-parts', async () => {
  const r = await post(`models/${MODEL}:generateContent`, {
    contents: [userTurn('A farmer has 17 sheep. All but 9 run away. How many are left?')],
    generationConfig: { thinkingConfig: { includeThoughts: true } },
  });
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${r.text}`);
  const body = r.body as Record<string, unknown>;
  const candidate = (body.candidates as Record<string, unknown>[])[0]!;
  const parts = (candidate.content as { parts: Record<string, unknown>[] }).parts;
  writeObservation(
    'ai-thinking-thought-parts',
    'Whether thinkingConfig.includeThoughts surfaces parts flagged thought:true, and whether thoughtSignature rides on parts, on the probe model.',
    {
      httpStatus: r.status,
      anyThoughtPart: parts.some((p) => p.thought === true),
      anyThoughtSignature: parts.some((p) => 'thoughtSignature' in p),
      usageHasThoughtsTokenCount: 'thoughtsTokenCount' in ((body.usageMetadata as object) ?? {}),
      partKeySets: parts.map((p) => sortedKeys(p)),
      raw: body,
    },
  );
});

// 13. systemInstruction is accepted at the top level of the request.
await probe('ai-system-instruction-accepted', async () => {
  const r = await post(`models/${MODEL}:generateContent`, {
    systemInstruction: { role: 'system', parts: [{ text: 'You only ever reply with the word: pyric' }] },
    contents: [userTurn('Say anything.')],
  });
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${r.text}`);
  const body = r.body as Record<string, unknown>;
  const candidate = (body.candidates as Record<string, unknown>[])[0]!;
  writeObservation(
    'ai-system-instruction-accepted',
    'A top-level systemInstruction rides the request unchanged and the response envelope shape is unaffected.',
    {
      httpStatus: r.status,
      finishReason: candidate.finishReason,
      topLevelKeySet: sortedKeys(body),
      raw: body,
    },
  );
});

for (const unknown of onlyProbes ?? []) {
  failures++;
  console.error(`✗ ${unknown}: no probe has that name`);
}
console.log(failures > 0 ? `\n${failures} probe(s) failed` : '\nall probes captured');
process.exit(failures > 0 ? 1 : 0);
