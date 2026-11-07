// The Auth user-management calls the Admin SDK (`firebase-admin/auth`)
// sends, answered from `admin-auth` exchanges (`format.ts`). With
// `FIREBASE_AUTH_EMULATOR_HOST` set, the SDK sends each call to
// `http://<host>/identitytoolkit.googleapis.com/v1/projects/<project>/...`
// with `Authorization: Bearer owner`: `accounts` (createUser),
// `accounts:lookup` (getUser, getUserByEmail, getUsers, and verifyIdToken
// with checkRevoked), `accounts:update` (updateUser, setCustomUserClaims,
// revokeRefreshTokens), `accounts:delete`, `accounts:batchDelete`,
// `accounts:batchGet` (listUsers, a GET whose query carries `maxResults`)
// and `accounts:query`.
//
// A call matches an exchange when its method, path, query and JSON body
// equal the recorded ones, with placeholders. The first matching exchange
// not yet used answers it, or the last matching one when all are used, so a
// `getUser` before a `deleteUser` and the same call after it each get their
// own answer. A call no exchange holds gets Auth's error shape with the
// message `PYRIC_REPLAY_NO_RECORDING`, which the SDK surfaces as
// `auth/internal-error`, and is listed in `unmatched`.
//
// Only a call that sends `Bearer owner` reaches this answerer, so a client
// SDK's Auth calls never get an Admin answer (`server.ts`).
import type { IncomingMessage } from 'node:http';
import type { AdminAuthExchange, Json, JsonObject } from './format.ts';
import type { ReplayState } from './firestore.ts';
import { fill, matches } from './values.ts';

export const ADMIN_AUTH_HOST = 'identitytoolkit.googleapis.com';

export interface AdminAuthRequest {
  method: string;
  /** The path under the Auth host, without its query. */
  path: string;
  query: JsonObject;
  body: JsonObject | undefined;
}

/** Whether a request to the Auth host came from the Admin SDK in emulator mode, which always sends `Bearer owner`. */
export function isAdminAuthCall(request: IncomingMessage): boolean {
  return request.headers.authorization === 'Bearer owner';
}

export class AdminAuth {
  private readonly used = new Set<string>();

  constructor(private readonly state: ReplayState) {}

  /** Status and JSON body for one Admin Auth call. */
  answer(request: AdminAuthRequest): { status: number; body: JsonObject } {
    const logged = loggedRequest(request);
    this.state.received.push({ rpc: 'auth', as: null, message: logged });
    const exchange = this.take(request);
    if (!exchange) {
      this.state.unmatched.push({ rpc: 'auth', as: null, request: logged });
      return { status: 400, body: { error: { code: 400, message: 'PYRIC_REPLAY_NO_RECORDING', errors: [] } } };
    }
    return { status: exchange.response.status, body: fill(exchange.response.body, this.state.context()) as JsonObject };
  }

  private take(request: AdminAuthRequest): AdminAuthExchange | null {
    const candidates = this.state.recordings
      .flatMap((recording) => recording.exchanges)
      .filter((exchange): exchange is AdminAuthExchange => exchange.kind === 'admin-auth' && fits(exchange, request));
    const chosen = candidates.find((exchange) => !this.used.has(exchange.id)) ?? candidates.at(-1) ?? null;
    if (chosen) this.used.add(chosen.id);
    return chosen;
  }
}

function fits(exchange: AdminAuthExchange, request: AdminAuthRequest): boolean {
  const recorded = exchange.request;
  const sameCall = recorded.method === request.method && recorded.path === request.path;
  return sameCall && matches(recorded.query ?? {}, request.query) && matches(recorded.body, request.body);
}

/** A request as `received` and `unmatched` list it: the query only when it has one. */
function loggedRequest(request: AdminAuthRequest): JsonObject {
  const hasQuery = Object.keys(request.query).length > 0;
  const logged: Record<string, Json> = { method: request.method, path: request.path };
  if (hasQuery) logged.query = request.query;
  logged.body = request.body ?? null;
  return logged;
}
