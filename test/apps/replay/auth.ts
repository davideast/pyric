// The Auth REST calls a sign-in makes (`identitytoolkit.googleapis.com` and
// `securetoken.googleapis.com`), answered from recorded exchanges. A request
// matches on its method, host, path and body, where `{ "$": "any" }` matches
// any value and `{ "$": "idToken", "uid": ... }` an ID token this server
// minted for that uid. A call no recording holds gets Auth's own error shape with the
// message `PYRIC_REPLAY_NO_RECORDING`, which the SDK surfaces as an
// `auth/internal-error` naming it.
import type { AuthExchange, JsonObject } from './format.ts';
import type { ReplayState } from './firestore.ts';
import { fill, matches } from './values.ts';

export const AUTH_HOSTS = ['identitytoolkit.googleapis.com', 'securetoken.googleapis.com'];

export interface AuthRequest {
  method: string;
  host: string;
  path: string;
  body: JsonObject | undefined;
}

/** A REST body as an object: JSON, or the form encoding a token refresh sends. */
export function parseRestBody(text: string): JsonObject | undefined {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as JsonObject;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

/** Status and JSON body for one Auth REST call. */
export function answerAuth(state: ReplayState, request: AuthRequest): { status: number; body: JsonObject } {
  state.received.push({ rpc: 'auth', as: null, message: { method: request.method, host: request.host, path: request.path, body: request.body ?? null } });
  const exchange = state.recordings
    .flatMap((recording) => recording.exchanges)
    .find((candidate): candidate is AuthExchange => candidate.kind === 'auth' && fits(candidate, request, state));
  if (!exchange) {
    state.unmatched.push({ rpc: 'auth', as: null, request: { method: request.method, host: request.host, path: request.path, body: request.body ?? null } });
    return { status: 400, body: { error: { code: 400, message: 'PYRIC_REPLAY_NO_RECORDING', errors: [] } } };
  }
  return { status: exchange.response.status, body: fill(exchange.response.body, state.context()) as JsonObject };
}

function fits(exchange: AuthExchange, request: AuthRequest, state: ReplayState): boolean {
  const recorded = exchange.request;
  const sameCall = recorded.method === request.method && recorded.host === request.host && recorded.path === request.path;
  return sameCall && (recorded.body === undefined || matches(recorded.body, request.body, state.tokens));
}
