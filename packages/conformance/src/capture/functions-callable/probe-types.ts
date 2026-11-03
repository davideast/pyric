/**
 * The shapes every `probes/functions-callable/` record shares with the capture
 * harness and the local conformance suite. A probe owns its requests (or its
 * page scenario) and its projection; the harness runs it against production
 * and the suite runs the same probe against pyric, and both freeze or compare
 * what the projection returns.
 *
 * The request and response records are the functions-http ones (AGENTS.md
 * rule 4): a callable is an HTTP POST, so the same sender records it. What is
 * new here is the token a request carries, the callable JSON body, and the
 * server-sent event frames of a streaming call.
 */
import type { ProbeRequest, ProbeResponse } from '../functions-http/probe-types.ts';

export type { ProbeResponse, ProbeVia } from '../functions-http/probe-types.ts';

/**
 * The ID token a request carries in `Authorization: Bearer`. The runner mints
 * or derives it; a probe names only its kind, so no token value lives in a
 * probe or an observation.
 * - `valid`: a fresh ID token for the run's test user.
 * - `forged`: that token with its signature bytes altered.
 * - `expired`: an ID token past its `exp`.
 * - `garbage`: a value that is not a JWT.
 * - `basic`: `Authorization: Basic ...`, a scheme the SDK refuses.
 */
export type AuthTokenKind = 'valid' | 'forged' | 'expired' | 'garbage' | 'basic';

/**
 * The App Check token a request carries in `X-Firebase-AppCheck`.
 * - `valid`: a token minted for the web app from the run's debug token.
 * - `limited-use`: a limited-use token, minted fresh for this request.
 * - `limited-use-shared`: one limited-use token, minted once per probe and
 *   sent by every request that names this kind.
 * - `invalid`: a value that is not an App Check token.
 */
export type AppCheckTokenKind = 'valid' | 'limited-use' | 'limited-use-shared' | 'invalid';

export interface CallableTokens {
  auth?: AuthTokenKind;
  appCheck?: AppCheckTokenKind;
}

/** One raw HTTP request to a callable, with the tokens the runner attaches. */
export interface CallableProbeRequest extends ProbeRequest {
  tokens?: CallableTokens;
}

/** A probe that sends raw HTTP, as the client SDK would, and reads the wire answer. */
export interface FunctionsCallableWireProbe {
  kind: 'wire';
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  requests: CallableProbeRequest[];
  behavior(responses: Record<string, ProbeResponse>): Record<string, unknown>;
}

/**
 * The page scenarios of `CALLABLE_BROWSER_SOURCE`: each is a function on
 * `globalThis.functionsCallableProbes` that runs the real `firebase/functions`
 * (or the pyric mirror) and returns raw facts.
 */
export type ClientScenario =
  | 'encoding'
  | 'errors'
  | 'fromUrl'
  | 'customDomain'
  | 'limitedUse'
  | 'stream'
  | 'signedIn';

/** What the runner hands a page scenario besides the web app config. */
export interface ClientScenarioInput {
  /** The region the fixture deploys to. */
  region: string;
  /** Production URLs of a function, keyed by `cloudfunctions` and `run`, for `fromUrl`. */
  urls?: Record<string, string>;
  /** The origin `getFunctions(app, origin)` takes, for `customDomain`. */
  customDomain?: string;
  /** A custom token for the run's test user, for `signedIn`. */
  customToken?: string;
}

/** A probe that runs a page scenario and projects what the client SDK reported. */
export interface FunctionsCallableClientProbe {
  kind: 'client';
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  scenario: ClientScenario;
  /** Whether the page initializes App Check with the run's debug token first. */
  appCheck: boolean;
  behavior(result: Record<string, unknown>): Record<string, unknown>;
}

export type FunctionsCallableProbe = FunctionsCallableWireProbe | FunctionsCallableClientProbe;

/** What `pyricCallableEcho` and its siblings report about the call they served. */
export interface CallableReport {
  instanceId: string;
  dataType: string;
  data: unknown;
  auth: { present: boolean; [fact: string]: unknown };
  app: { present: boolean; [fact: string]: unknown };
  acceptsStreaming: boolean | null;
  rawRequest: { method: string; headerNames: string[] } | null;
}

/** One parsed server-sent event frame of a streaming call. */
export type SseFrame =
  | { kind: 'data'; json: unknown }
  | { kind: 'comment'; text: string }
  | { kind: 'unparsed'; text: string };

/** A JSON POST body for a callable: `{ data }`. */
export function callableBody(data: unknown): Pick<CallableProbeRequest, 'method' | 'headers' | 'body'> {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) };
}

/** Splits an event-stream body into frames: `data:` lines parsed as JSON, `:` lines as comments. */
export function parseSseFrames(body: string): SseFrame[] {
  return body
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block): SseFrame => {
      if (block.startsWith(':')) return { kind: 'comment', text: block.slice(1).trim() };
      if (!block.startsWith('data: ')) return { kind: 'unparsed', text: block };
      try {
        return { kind: 'data', json: JSON.parse(block.slice('data: '.length)) };
      } catch {
        return { kind: 'unparsed', text: block };
      }
    });
}

/** The callable answer of a non-streaming response: status, content type, and the `{result}` or `{error}` body. */
export function callableShape(response: ProbeResponse): Record<string, unknown> {
  return {
    status: response.status,
    contentType: response.headers['content-type'] ?? null,
    json: response.json,
    bodyWhenNotJson: response.json === null ? response.body : null,
    error: response.error,
  };
}

/** Keys whose values differ on every run (the serving process id), dropped before a fact is compared. */
const RUN_SCOPED_KEYS = new Set(['instanceId']);

/** A page scenario's facts with run-scoped values removed, at any depth. */
export function withoutRunValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRunValues);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !RUN_SCOPED_KEYS.has(key))
      .map(([key, inner]) => [key, withoutRunValues(inner)]),
  );
}

/** The report a successful call returned, or null. */
export function reportOf(response: ProbeResponse): CallableReport | null {
  const json = response.json as { result?: CallableReport } | null;
  return response.status === 200 && json?.result ? json.result : null;
}
