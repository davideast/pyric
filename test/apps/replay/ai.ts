// Firebase AI Logic's GenerativeService, answered from the committed AI Logic
// observations: `generateContent`, `streamGenerateContent?alt=sse` and
// `countTokens` on the GoogleAI backend, the path the `firebase/ai` SDK
// builds when a model's `baseUrl` is the replay server's origin
// (`/v1beta/projects/<project>/models/<model>:<task>`).
//
// The bodies are production's `raw` envelopes and `rawFrames`, played as
// captured whatever the request asked. A request with no
// `x-firebase-appcheck` header gets the 401 captured on a project that
// enforces App Check; any header passes, since the replay cannot verify a
// token. A model no observation served gets the captured 404, with the
// requested model named in its message as production names it. Answers are
// not consumed, so one server answers every plane that calls it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Json, JsonObject } from './format.ts';

const OBSERVATIONS = fileURLToPath(new URL('../../../packages/conformance/observations/', import.meta.url));

/** The observations each answer comes from. */
export const AI_OBSERVATIONS = {
  generate: 'ai/ai-generate-minimal-envelope.json',
  stream: 'ai/ai-generate-stream-framing.json',
  countTokens: 'ai/ai-counttokens-envelope.json',
  unknownModel: 'ai/ai-error-unknown-model.json',
  appCheckGate: 'app-check/app-check-ai-gate-wire.json',
} as const;

/** The model the unknown-model observation asked for, which its message names. */
const CAPTURED_UNKNOWN_MODEL = 'models/not-a-real-model';

const AI_PATH = /^\/v1beta\/projects\/([^/]+)\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/;

export type AiTask = 'generateContent' | 'streamGenerateContent' | 'countTokens';

/** One AI Logic request the server answered. It names the call, never the prompt. */
export interface AiReceived {
  rpc: 'ai';
  as: null;
  message: { project: string; model: string; task: AiTask; appCheck: boolean };
}

export interface AiError {
  status: number;
  body: JsonObject;
}

/** What the observations hold, read once. */
export interface AiAnswers {
  /** Every model an envelope observation was captured on. */
  servedModels: string[];
  generate: JsonObject;
  countTokens: JsonObject;
  /** The SSE body, CRLF-separated `data:` events, as production framed it. */
  streamFrames: string;
  unauthenticated: AiError;
  unknownModel: AiError;
}

interface Observation {
  model?: string;
  behavior: JsonObject;
}

function readObservation(path: string): Observation {
  return JSON.parse(readFileSync(`${OBSERVATIONS}${path}`, 'utf8')) as Observation;
}

function captured(behavior: JsonObject): AiError {
  return { status: behavior.httpStatus as number, body: behavior.raw as JsonObject };
}

let answers: AiAnswers | null = null;

export function aiAnswers(): AiAnswers {
  answers ??= loadAnswers();
  return answers;
}

function loadAnswers(): AiAnswers {
  const generate = readObservation(AI_OBSERVATIONS.generate);
  const stream = readObservation(AI_OBSERVATIONS.stream);
  const countTokens = readObservation(AI_OBSERVATIONS.countTokens);
  const gate = readObservation(AI_OBSERVATIONS.appCheckGate);
  const models = [generate, stream, countTokens].map((observation) => observation.model).filter((model): model is string => typeof model === 'string');
  return {
    servedModels: [...new Set(models)],
    generate: generate.behavior.raw as JsonObject,
    countTokens: countTokens.behavior.raw as JsonObject,
    streamFrames: stream.behavior.rawFrames as string,
    unauthenticated: captured(gate.behavior.noHeader as JsonObject),
    unknownModel: captured(readObservation(AI_OBSERVATIONS.unknownModel).behavior),
  };
}

/**
 * The project, model and task an AI Logic request URL names, or null for any
 * other URL. A stream is answered only as SSE (`alt=sse`), the framing the
 * observation captured.
 */
export function aiCallOf(requestUrl: string): { project: string; model: string; task: AiTask } | null {
  const url = new URL(requestUrl, 'http://replay.invalid');
  const match = AI_PATH.exec(url.pathname);
  if (!match) return null;
  const task = match[3] as AiTask;
  const sse = url.searchParams.get('alt') === 'sse';
  if ((task === 'streamGenerateContent') !== sse) return null;
  return { project: match[1]!, model: match[2]!, task };
}

/** How the server answers one AI Logic call. */
export type AiAnswer =
  | { kind: 'json'; status: number; body: JsonObject }
  | { kind: 'sse'; status: 200; body: string };

export function answerAi(task: AiTask, model: string, appCheck: boolean): AiAnswer {
  const known = aiAnswers();
  if (!appCheck) return { kind: 'json', ...known.unauthenticated };
  if (!known.servedModels.includes(model)) return { kind: 'json', status: known.unknownModel.status, body: namingModel(known.unknownModel.body, model) };
  if (task === 'streamGenerateContent') return { kind: 'sse', status: 200, body: known.streamFrames };
  if (task === 'countTokens') return { kind: 'json', status: 200, body: known.countTokens };
  return { kind: 'json', status: 200, body: known.generate };
}

function namingModel(body: JsonObject, model: string): JsonObject {
  const error = body.error as JsonObject;
  const message = (error.message as string).replace(CAPTURED_UNKNOWN_MODEL, `models/${model}`);
  return { error: { ...error, message } as Json } as JsonObject;
}
