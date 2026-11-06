/**
 * What the live-ai row knows about `firebase/ai`: which calls reach
 * production, where a call's app, project and model sit on the SDK's own
 * objects, how production's token counts are read from what the SDK parsed,
 * how its errors spell production's status, and which parts of the SDK live
 * mode refuses.
 *
 * The row observes instances, not prototypes. The GenerativeModel
 * `getGenerativeModel` returns gets own-property wrappers for
 * `generateContent`, `generateContentStream` and `countTokens`, and for
 * `startChat`, which does the same to the ChatSession it returns
 * (`sendMessage` and `sendMessageStream`, recorded as `chat.sendMessage` and
 * `chat.sendMessageStream`). The exported `GenerativeModel` and `ChatSession`
 * are construct-trap proxies of the SDK's classes that observe each instance
 * the same way, so `new GenerativeModel(ai, params)` is observed and
 * `instanceof` holds. The SDK's prototypes stay untouched, so a second wrap
 * of one SDK copy never records a call twice, and the SDK's internal calls (a
 * chat calling its internal `generateContent`) never reach a wrapper.
 *
 * A model or chat has no path to its app, so the row notes the AI instance
 * each one was made from, and a record reads its app from there: the project
 * from `app.options.projectId` and the account from the app's Auth. A model
 * made without a noted AI instance reads its project from
 * `this._apiSettings.project` and records no account.
 *
 * A record carries the model, production's token counts and, when the SDK
 * kept it, the `modelVersion` production reported. Never a prompt, a part,
 * response text, a function call or a header.
 *
 * Reading never calls the app's code and never throws. This file imports no
 * Firebase SDK.
 */
import { observedCall, UNOBSERVED, type CallContext, type LiveAiRecord, type LiveAiUsage, type ObservedSite, type ResultReading } from './observe.js';
import type { RefusalCheck } from './modules.js';
import type { RefusedCall } from './refusal.js';

type Callback = (this: unknown, ...values: unknown[]) => unknown;
type Fields = Record<string, unknown>;
type Site = Omit<ObservedSite, 'name'>;

/** The AI instance each model and chat was made from, as the row saw it made. */
const AI_BY_OWNER = new WeakMap<object, object>();

/** Every model and chat the row has observed, so none is observed twice. */
const OBSERVED = new WeakSet<object>();

/** The model names a host takes: the SDK's normalized resource, `models/gemini-flash-lite-latest`. */
const MODEL_NAME = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * The model a record names when the SDK's model is unread or a host would
 * refuse it (a Vertex versioned id with `@`), so the call still reaches
 * Traffic.
 */
export const UNREAD_MODEL = 'models/model-not-read-from-the-sdk';

const MODEL_CALLS = ['generateContent', 'generateContentStream', 'countTokens'] as const;
const CHAT_CALLS = ['sendMessage', 'sendMessageStream'] as const;
const CHAT_PREFIX = 'chat.';
const STREAM_CALLS: ReadonlySet<string> = new Set(['generateContentStream', `${CHAT_PREFIX}sendMessageStream`]);

/** The SDK's `InferenceMode.ONLY_ON_DEVICE` and `InferenceSource.ON_DEVICE`: answers production never gave. */
const ONLY_ON_DEVICE = 'only_on_device';
const ON_DEVICE = 'on_device';

const USAGE_COUNTS = ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount'] as const;

function isObject(value: unknown): value is Fields {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current !== '' ? current : undefined;
}

function defineOwn(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

/** Gives `target` an own observed wrapper for each method, recorded as `<prefix><method>`. */
function observeMethods(target: Fields, methods: readonly string[], prefix: string, site: Site): void {
  for (const method of methods) {
    const real = target[method];
    if (typeof real !== 'function') continue;
    defineOwn(target, method, observedCall({ ...site, name: `${prefix}${method}` }, real as Callback));
  }
}

/** Marks an instance observed and notes its AI instance, or says it was already observed. */
function claim(owner: unknown, ai: unknown): owner is Fields {
  if (!isObject(owner) || OBSERVED.has(owner)) return false;
  OBSERVED.add(owner);
  if (isObject(ai)) AI_BY_OWNER.set(owner, ai);
  return true;
}

/** Observes one ChatSession's calls. A chat the row cannot observe is still the SDK's own. */
function observeChat(chat: unknown, ai: unknown, site: Site): void {
  try {
    if (claim(chat, ai)) observeMethods(chat, CHAT_CALLS, CHAT_PREFIX, site);
  } catch {
    // The app's chat is unchanged.
  }
}

/** Observes one GenerativeModel's calls, and the chats its `startChat` returns. */
function observeModel(model: unknown, ai: unknown, site: Site): void {
  try {
    if (!claim(model, ai)) return;
    observeMethods(model, MODEL_CALLS, '', site);
    const startChat = model.startChat;
    if (typeof startChat !== 'function') return;
    defineOwn(model, 'startChat', function startChatObserved(this: unknown, ...args: unknown[]): unknown {
      const chat = Reflect.apply(startChat as Callback, this, args);
      observeChat(chat, isObject(this) ? AI_BY_OWNER.get(this) : undefined, site);
      return chat;
    });
  } catch {
    // The app's model is unchanged.
  }
}

/** The row's `getGenerativeModel`: the SDK's model, observed, noted as made from its first argument. */
export function observedGetGenerativeModel(real: Callback, site: Site): Callback {
  return function getGenerativeModel(this: unknown, ...args: unknown[]): unknown {
    const model = Reflect.apply(real, this, args);
    observeModel(model, args[0], site);
    return model;
  };
}

/** A construct trap over the SDK's class that observes each instance it builds. Calls and statics are the SDK's own. */
function observedClass(real: Callback, observe: (instance: unknown, args: readonly unknown[]) => void): Callback {
  return new Proxy(real, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target as unknown as new (...values: unknown[]) => object, args, newTarget) as object;
      observe(instance, args);
      return instance;
    },
  });
}

/** The row's `GenerativeModel`: `new GenerativeModel(ai, params)` is observed, noted as made from `ai`. */
export function observedModelClass(real: Callback, site: Site): Callback {
  return observedClass(real, (model, args) => observeModel(model, args[0], site));
}

/** The row's `ChatSession`: `new ChatSession(apiSettings, model)` is observed. It names no AI instance. */
export function observedChatClass(real: Callback, site: Site): Callback {
  return observedClass(real, (chat) => observeChat(chat, undefined, site));
}

/** The model a model or chat asked for, or the unread model when a host would refuse its name. */
function modelOf(owner: Fields): string {
  const model = stringAt(owner, ['model']);
  return model !== undefined && MODEL_NAME.test(model) ? model : UNREAD_MODEL;
}

/**
 * The record context of one call on a model or chat (`this`): its app, which
 * names the account, its project and its model, and when it started. A model
 * whose on-device adapter runs only on device makes no record, since
 * production never answers it.
 */
export function aiContext(_name: string, _args: readonly unknown[], self: unknown): CallContext | typeof UNOBSERVED {
  const startedAt = Date.now();
  if (!isObject(self)) return { ai: { model: UNREAD_MODEL }, startedAt };
  const isOnlyOnDevice = stringAt(self, ['chromeAdapter', 'mode']) === ONLY_ON_DEVICE;
  if (isOnlyOnDevice) return UNOBSERVED;
  const ai = AI_BY_OWNER.get(self);
  const app = isObject(ai) ? ai.app : undefined;
  const projectId = stringAt(app, ['options', 'projectId']) ?? stringAt(self, ['_apiSettings', 'project']);
  return {
    ...(isObject(app) ? { subject: app } : {}),
    ...(projectId === undefined ? {} : { projectId }),
    ai: { model: modelOf(self) },
    startedAt,
  };
}

/** Production's status for each HTTP status, as its canonical name, lowercase. */
const STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'invalid_argument',
  401: 'unauthenticated',
  403: 'permission_denied',
  404: 'not_found',
  429: 'resource_exhausted',
  500: 'internal',
  503: 'unavailable',
  504: 'deadline_exceeded',
};

const AI_CODE_PREFIX = 'AI/';

/**
 * Production's status for an AI Logic error. The SDK drops the status string
 * production sent and keeps the HTTP status in `customErrorData.status`, so
 * the code is that status's canonical name, or `http_<n>` for any other. With
 * no HTTP status it is the SDK's code without an `AI/` prefix
 * (`fetch-error`, `parse-failed`), else the error's name (`AbortError`).
 */
export function aiCode(error: unknown): string {
  try {
    if (!isObject(error)) return 'unknown';
    const data = error.customErrorData;
    const status = isObject(data) ? data.status : undefined;
    if (typeof status === 'number' && Number.isSafeInteger(status)) return STATUS_CODES[status] ?? `http_${status}`;
    const code = stringAt(error, ['code']);
    if (code !== undefined) return code.startsWith(AI_CODE_PREFIX) ? code.slice(AI_CODE_PREFIX.length) : code;
    return stringAt(error, ['name']) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The token counts in a `usageMetadata`, numbers only, or nothing when it holds none. */
function usageOf(metadata: unknown): Pick<LiveAiRecord, 'usage'> {
  if (!isObject(metadata)) return {};
  const usage: { -readonly [K in keyof LiveAiUsage]: number } = {};
  for (const key of USAGE_COUNTS) {
    const count = metadata[key];
    if (isCount(count)) usage[key] = count;
  }
  return Object.keys(usage).length === 0 ? {} : { usage };
}

/** The `modelVersion` production reported, when the SDK kept it and a host takes it. */
function reportedOf(response: unknown): Pick<LiveAiRecord, 'reportedModel'> {
  const reportedModel = stringAt(response, ['modelVersion']);
  return reportedModel !== undefined && MODEL_NAME.test(reportedModel) ? { reportedModel } : {};
}

function isOnDevice(response: unknown): boolean {
  return stringAt(response, ['inferenceSource']) === ON_DEVICE;
}

/** The record of a `generateContent` or `chat.sendMessage` result, or none for an answer made on device. */
function responseReading(model: string, response: unknown): ResultReading {
  if (isOnDevice(response)) return UNOBSERVED;
  return { ai: { model, ...reportedOf(response), ...usageOf(isObject(response) ? response.usageMetadata : undefined) } };
}

/** The record of a `countTokens` result: its `totalTokens` only. */
function countReading(model: string, value: unknown): ResultReading {
  const totalTokens = isObject(value) ? value.totalTokens : undefined;
  return { ai: { model, ...(isCount(totalTokens) ? { usage: { totalTokens } } : {}) } };
}

/** The stream's chunks as the row read them from the SDK: those so far, and how it ended. */
interface Drained {
  readonly chunks: unknown[];
  ended: boolean;
  failure?: { readonly error: unknown };
  /** Resolves when a chunk arrives or the stream ends. */
  changed: Promise<void>;
  /** Settles when the stream ends, either way. */
  finished: Promise<void>;
}

/**
 * Reads the SDK's chunk stream to its end as it arrives, so the last chunk's
 * usage is known whether or not the app reads the stream. Production's
 * usage is on the chunks only: the SDK's aggregated response keeps none.
 */
function drain(stream: AsyncIterable<unknown>): Drained {
  let wake = (): void => undefined;
  const next = (): Promise<void> => new Promise<void>((resolve) => {
    wake = resolve;
  });
  const drained: Drained = { chunks: [], ended: false, changed: next(), finished: Promise.resolve() };
  const notify = (): void => {
    const woken = wake;
    drained.changed = next();
    woken();
  };
  const read = async (): Promise<void> => {
    try {
      for await (const chunk of stream) {
        drained.chunks.push(chunk);
        notify();
      }
    } catch (error) {
      drained.failure = { error };
    }
    drained.ended = true;
    notify();
  };
  drained.finished = read();
  return drained;
}

/** The app's stream: the same chunks, in order, then the same end or error the SDK's stream gave. */
async function* replayed(drained: Drained): AsyncGenerator<unknown> {
  let index = 0;
  while (true) {
    if (index < drained.chunks.length) {
      yield drained.chunks[index++];
      continue;
    }
    if (drained.failure !== undefined) throw drained.failure.error;
    if (drained.ended) return;
    await drained.changed;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isObject(value) && typeof Reflect.get(value, Symbol.asyncIterator) === 'function';
}

/** Whether `target` has a writable own data property `key`, as the SDK's plain result objects do. */
function isWritable(target: unknown, key: string): target is Fields {
  if (!isObject(target)) return false;
  return Object.getOwnPropertyDescriptor(target, key)?.writable === true;
}

/** The last chunk that carried usage, which holds production's counts for the whole stream. */
function lastWithUsage(chunks: readonly unknown[]): unknown {
  for (let index = chunks.length - 1; index >= 0; index--) {
    const chunk = chunks[index];
    if (isObject(chunk) && isObject(chunk.usageMetadata)) return chunk;
  }
  return chunks.at(-1);
}

/**
 * Follows a stream call's result, `{ stream, response }`, before the app
 * gets it. The method resolving is not production's answer: the record is
 * made when the SDK's `response` settles and its stream has ended, ok with
 * the last chunk's usage and `firstChunkMs`, or the error. The app gets a
 * `response` that follows the SDK's, so a rejection the app never handles is
 * still unhandled, and a stream that yields the SDK's own chunks.
 */
function streamReading(site: ObservedSite, model: string, value: unknown): ResultReading | Promise<ResultReading> {
  const firstChunkMs = site.startedAt === undefined ? undefined : Math.max(0, Date.now() - site.startedAt);
  const timing = firstChunkMs === undefined ? {} : { firstChunkMs };
  const response = isObject(value) ? value.response : undefined;
  const stream = isObject(value) ? value.stream : undefined;
  const canFollow = response instanceof Promise && isAsyncIterable(stream) && isWritable(value, 'stream') && isWritable(value, 'response');
  // A result the row cannot follow is the SDK's own, recorded as it resolved, without usage.
  if (!canFollow) return { ai: { model, ...timing } };
  const drained = drain(stream);
  value.stream = replayed(drained);
  value.response = Promise.prototype.then.call(response, (aggregated: unknown) => aggregated, (error: unknown) => {
    throw error;
  });
  return Promise.prototype.then.call(response, async (aggregated: unknown): Promise<ResultReading> => {
    await drained.finished;
    if (isOnDevice(aggregated)) return UNOBSERVED;
    const last = lastWithUsage(drained.chunks);
    const usage = usageOf(isObject(last) ? last.usageMetadata : undefined);
    const reported = { ...reportedOf(aggregated), ...reportedOf(last) };
    return { ai: { model, ...reported, ...usage, ...timing } };
  }) as Promise<ResultReading>;
}

/** What a resolved AI Logic call adds to its record: the model's token counts, read per call. */
export function aiResult(site: ObservedSite, value: unknown): ResultReading | Promise<ResultReading> {
  const model = site.ai?.model ?? UNREAD_MODEL;
  if (STREAM_CALLS.has(site.name)) return streamReading(site, model, value);
  if (site.name === 'countTokens') return countReading(model, value);
  return responseReading(model, isObject(value) ? value.response : undefined);
}

/** What live mode serves of `firebase/ai`, which each refusal names. */
const AI_SERVES = 'only GenerativeModel and ChatSession calls (generateContent, generateContentStream, countTokens, sendMessage and sendMessageStream)';

function always(call: string, reaches: string): RefusalCheck {
  const refused: RefusedCall = { call, reaches, serves: AI_SERVES };
  return () => refused;
}

/**
 * The parts of `firebase/ai` live mode does not observe. Each throws live
 * mode's refusal before any request leaves. Imagen's exports are gone from
 * firebase 12.19, and an export the installed SDK lacks stays absent.
 */
export const AI_REFUSED_CALLS: Readonly<Record<string, RefusalCheck>> = {
  getLiveGenerativeModel: always('getLiveGenerativeModel', 'the Gemini Live API'),
  startAudioConversation: always('startAudioConversation', 'a Gemini Live API audio conversation'),
  getTemplateGenerativeModel: always('getTemplateGenerativeModel', 'Firebase AI Logic server prompt templates'),
  getImagenModel: always('getImagenModel', 'Imagen image generation'),
  getTemplateImagenModel: always('getTemplateImagenModel', 'Firebase AI Logic server prompt templates for Imagen'),
};
