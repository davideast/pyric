/** HTTP REST adapters on `pyric serve` for Auth Identity Toolkit, Secure Token, and sharded RTDB (`/<path>.json`). */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sandbox as authSandbox, type Auth, type MintedSession } from 'pyric/auth';
import { normalizeTenantScope, resolveCustomTokenIdentity } from 'pyric/auth/internal';
import { get as rawRtdbGet, getAdminDatabase as pyricGetAdminDatabase, getDatabase as pyricGetDatabase, ref as rtdbRef, remove as rawRtdbRemove, set as rawRtdbSet, update as rawRtdbUpdate, type Database } from 'pyric/database';
import type { AuthState } from 'pyric/sandbox';
import { authAccountsFor, checkIdToken, getClock, resolveDatabaseInstance, rulesTokenFromIdToken, SANDBOX_PROJECT_ID, sdkActivity, utf8FromBase64url } from 'pyric/sandbox/internal';
import { answerAndClose, collectRawBody, isBodyTooLarge } from '../bridge/server/peer.js';
import type { PyricWriteRefusal } from './hosted/own-writes.js';
import { getHeader } from './loopback-guard.js';
import { ensureAuth } from './worker/host-auth.js';
import { bestEffortFlush, hostProjectId, type HostCtx, type HostRtdbInstance } from './worker/host-context.js';
import { remintSessionWithClaims, resolveOAuthCredentialUser, type OAuthCredentialPayload } from './worker/host/auth-session-seeder.js';
import { rtdbInstance } from './worker/host/rtdb-instances.js';
import type { ResolvedIdentity } from './worker/protocol.js';

const AUTH_BODY_LIMIT_BYTES = 64 * 1024;
const RTDB_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const SECURETOKEN_ISSUER_PREFIX = 'https://securetoken.google.com/';
const EXPIRES_IN_SECONDS = '3600';
const AUTH_REST_ERROR_LABELS: Readonly<Record<string, string>> = {
  'auth/invalid-custom-token': 'INVALID_CUSTOM_TOKEN', 'auth/custom-token-mismatch': 'CREDENTIAL_MISMATCH',
  'auth/user-disabled': 'USER_DISABLED', 'auth/operation-not-allowed': 'OPERATION_NOT_ALLOWED',
  'auth/tenant-id-mismatch': 'TENANT_ID_MISMATCH', 'auth/invalid-email': 'INVALID_EMAIL',
};

export type RestAuthRtdbHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
export interface RestAuthRtdbOptions { readonly ctx: HostCtx; readonly ownWriteRefusal?: PyricWriteRefusal; readonly stagedIdentities?: ReadonlyMap<string, ResolvedIdentity>; }
type RestRoute = { readonly kind: 'signInWithIdp' } | { readonly kind: 'signInWithCustomToken' } | { readonly kind: 'tokenRefresh' } | { readonly kind: 'rtdb'; readonly rawPath: string };
interface IdpProfile { readonly subjectUid: string; readonly email: string | null; readonly displayName: string | null; readonly photoURL: string | null; readonly emailVerified: boolean | undefined; }

const refreshSessionsByCtx = new WeakMap<HostCtx, Map<string, MintedSession>>();
const hostedRestBySession = new Map<string, RestAuthRtdbHandler>();

export function matchesRestAuthRtdbPathname(pathname: string): boolean { return classifyRestRoute(pathname) !== null; }
export function hasExplicitRtdbRestSelector(req: IncomingMessage, url: URL): boolean {
  if (url.searchParams.has('ns') || url.searchParams.has('auth')) return true;
  if (getHeader(req, 'x-pyric-database-instance') !== undefined) return true;
  return getHeader(req, 'authorization') !== undefined;
}
export function registerHostedRestHandler(sessionToken: string | undefined, options: RestAuthRtdbOptions) {
  const handler = createRestAuthRtdbHandler(options);
  const hasToken = typeof sessionToken === 'string' && sessionToken.length > 0;
  if (hasToken) hostedRestBySession.set(sessionToken, handler);
  return { handler, unregister() { if (hasToken && hostedRestBySession.get(sessionToken) === handler) hostedRestBySession.delete(sessionToken); } };
}
export function hostedRestHandlerForSession(sessionToken: string | undefined): RestAuthRtdbHandler | undefined {
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) return undefined;
  return hostedRestBySession.get(sessionToken);
}

function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && Array.isArray(value) === false; }
function extractErrorCode(error: unknown): string | undefined {
  if (isPlainObject(error) && typeof error.code === 'string') return error.code;
  return undefined;
}
function nonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}
function nullableString(record: Record<string, unknown>, key: string): string | null {
  if (typeof record[key] === 'string') return record[key] as string;
  return null;
}
function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
function firstPresent(primary: string | null, fallback: string | null): string {
  if (primary !== null) return primary;
  if (fallback !== null) return fallback;
  return '';
}
function resolveTargetProjectId(ctx: HostCtx): string {
  const configured = hostProjectId(ctx);
  if (configured !== undefined) return configured;
  return SANDBOX_PROJECT_ID;
}
function sendJson(res: ServerResponse, status: number, payload: unknown, allowHeader?: string): void {
  const headers: Record<string, string> = { 'content-type': JSON_CONTENT_TYPE, 'cache-control': 'no-store' };
  if (allowHeader !== undefined) headers.allow = allowHeader;
  res.writeHead(status, headers).end(JSON.stringify(payload));
}
function sendAuthRestError(res: ServerResponse, status: number, message: string, statusText?: string): void {
  const errorBody: Record<string, unknown> = { code: status, message };
  if (statusText !== undefined) errorBody.status = statusText;
  sendJson(res, status, { error: errorBody });
}

function isReservedServePathname(pathname: string): boolean {
  if (pathname === '/__pyric' || pathname.startsWith('/__pyric/') || pathname.startsWith('/__/')) return true;
  return pathname === '/mcp' || pathname === '/health';
}
function classifyRestRoute(pathname: string): RestRoute | null {
  if (isReservedServePathname(pathname)) return null;
  let authPath = pathname;
  if (authPath.startsWith('/identitytoolkit.googleapis.com/')) authPath = authPath.slice('/identitytoolkit.googleapis.com'.length);
  else if (authPath.startsWith('/securetoken.googleapis.com/')) authPath = authPath.slice('/securetoken.googleapis.com'.length);
  if (/^\/v1\/(?:projects\/[^/]+\/)?accounts:signInWithIdp$/.test(authPath)) return { kind: 'signInWithIdp' };
  if (/^\/v1\/(?:projects\/[^/]+\/)?accounts:signInWithCustomToken$/.test(authPath)) return { kind: 'signInWithCustomToken' };
  if (authPath === '/v1/token') return { kind: 'tokenRefresh' };
  if (pathname.endsWith('.json') && pathname.startsWith('/v1/') === false) return { kind: 'rtdb', rawPath: pathname.slice(0, pathname.length - 5) };
  return null;
}

function refreshMapFor(ctx: HostCtx): Map<string, MintedSession> {
  let map = refreshSessionsByCtx.get(ctx);
  if (map === undefined) { map = new Map<string, MintedSession>(); refreshSessionsByCtx.set(ctx, map); }
  return map;
}
function issueRefreshToken(ctx: HostCtx, session: MintedSession): string {
  const token = randomBytes(24).toString('base64url');
  refreshMapFor(ctx).set(token, session);
  return token;
}
function decodeBase64JsonSegment(segment: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(utf8FromBase64url(segment.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')));
  if (isPlainObject(parsed)) return parsed;
  return null;
}
function decodeOidcJwtClaims(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length !== 2 && segments.length !== 3) return null;
  const [rawHeader, rawPayload] = segments;
  if (rawHeader === undefined || rawPayload === undefined || rawHeader.length === 0 || rawPayload.length === 0) return null;
  try {
    if (decodeBase64JsonSegment(rawHeader) === null) return null;
    return decodeBase64JsonSegment(rawPayload);
  } catch { return null; }
}
function authErrorLabel(error: unknown, fallback: string): string {
  const code = extractErrorCode(error);
  if (code !== undefined && AUTH_REST_ERROR_LABELS[code] !== undefined) return AUTH_REST_ERROR_LABELS[code] as string;
  return fallback;
}

async function readUtf8Body(req: IncomingMessage, res: ServerResponse, limitBytes: number): Promise<string | null> {
  try { return new TextDecoder('utf-8').decode(await collectRawBody(req, limitBytes)); } catch (error) {
    if (isBodyTooLarge(error)) { answerAndClose(req, res, 413, { 'content-type': JSON_CONTENT_TYPE }, JSON.stringify({ error: 'Request payload too large.' })); return null; }
    sendJson(res, 400, { error: 'Failed to read request body.' });
    return null;
  }
}
function requirePostAuthGuard(req: IncomingMessage, res: ServerResponse, refusal: PyricWriteRefusal | undefined, action: string): boolean {
  if (req.method !== 'POST') { sendJson(res, 405, { error: { code: 405, message: 'METHOD_NOT_ALLOWED' } }, 'POST'); return false; }
  if (refusal !== undefined) { sendJson(res, 403, { error: refusal({ action, writer: 'page' }).message }); return false; }
  return true;
}
async function readJsonObjectBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const rawText = await readUtf8Body(req, res, AUTH_BODY_LIMIT_BYTES);
  if (rawText === null) return null;
  try { const parsed: unknown = JSON.parse(rawText); if (isPlainObject(parsed)) return parsed; } catch { /* reported below */ }
  sendAuthRestError(res, 400, 'INVALID_JSON_PAYLOAD');
  return null;
}
function resolveFederatedUid(auth: Auth, subjectUid: string, email: string | null, tenantId: string | null): string {
  if (email === null) return subjectUid;
  const lower = email.toLowerCase();
  const scope = normalizeTenantScope(tenantId);
  for (const record of authSandbox.listUsers(auth)) {
    if (typeof record.email === 'string' && record.email.toLowerCase() === lower && normalizeTenantScope(record.tenantId) === scope) return record.uid;
  }
  return subjectUid;
}
function extractIdpProfile(idTokenParam: string | null, staged: ResolvedIdentity | undefined): IdpProfile | string {
  if (idTokenParam !== null && idTokenParam.length > 0) {
    const claims = decodeOidcJwtClaims(idTokenParam);
    if (claims === null) return 'INVALID_IDP_RESPONSE';
    const subject = nonEmptyString(claims, 'sub');
    if (subject === null || subject.trim().length === 0) return 'INVALID_IDP_RESPONSE';
    return { subjectUid: subject, email: nonEmptyString(claims, 'email'), displayName: nullableString(claims, 'name'), photoURL: nullableString(claims, 'picture'), emailVerified: optionalBoolean(claims, 'email_verified') };
  }
  if (staged !== undefined && staged.uid.length > 0) {
    return { subjectUid: staged.uid, email: staged.email ?? null, displayName: staged.displayName ?? null, photoURL: staged.photoURL ?? null, emailVerified: staged.emailVerified };
  }
  return 'MISSING_OR_INVALID_ID_TOKEN';
}

async function handleSignInWithIdp(req: IncomingMessage, res: ServerResponse, options: RestAuthRtdbOptions): Promise<void> {
  if (requirePostAuthGuard(req, res, options.ownWriteRefusal, 'auth.signInWithIdp') === false) return;
  const body = await readJsonObjectBody(req, res);
  if (body === null) return;
  if (typeof body.postBody !== 'string' || body.postBody.trim().length === 0) { sendAuthRestError(res, 400, 'MISSING_POST_BODY'); return; }
  const postParams = new URLSearchParams(body.postBody);
  let providerId = postParams.get('providerId');
  if (providerId === null) providerId = nonEmptyString(body, 'providerId');
  if (providerId === null || providerId.trim().length === 0) { sendAuthRestError(res, 400, 'MISSING_PROVIDER_ID'); return; }
  const profile = extractIdpProfile(postParams.get('id_token'), options.stagedIdentities?.get(providerId));
  if (typeof profile === 'string') { sendAuthRestError(res, 400, profile); return; }
  const tenantId = nonEmptyString(body, 'tenantId');
  try {
    const auth = ensureAuth(options.ctx);
    const resolvedUid = resolveFederatedUid(auth, profile.subjectUid, profile.email, tenantId);
    const credentialInput: OAuthCredentialPayload = { providerId, uid: resolvedUid, email: profile.email, displayName: profile.displayName, photoURL: profile.photoURL, emailVerified: profile.emailVerified, tenantId };
    const { uid, isNewUser } = resolveOAuthCredentialUser(auth, credentialInput);
    const session = authSandbox.mintSession(auth, { kind: 'provider', uid, providerId, tenantId });
    await bestEffortFlush(options.ctx, 'auth.acceptIdentity');
    const tokenResult = await session.user.getIdTokenResult(true);
    const refreshToken = issueRefreshToken(options.ctx, session);
    const responseBody = {
      kind: 'identitytoolkit#VerifyAssertionResponse', federatedId: profile.subjectUid, providerId, localId: session.user.uid, emailVerified: session.user.emailVerified,
      email: session.user.email ?? '', displayName: session.user.displayName ?? '', photoUrl: session.user.photoURL ?? '',
      idToken: tokenResult.token, refreshToken, expiresIn: EXPIRES_IN_SECONDS, isNewUser, registered: true,
    };
    sendJson(res, 200, responseBody);
  } catch (error) { sendAuthRestError(res, 400, authErrorLabel(error, 'INVALID_IDP_RESPONSE')); }
}
async function handleSignInWithCustomToken(req: IncomingMessage, res: ServerResponse, options: RestAuthRtdbOptions): Promise<void> {
  if (requirePostAuthGuard(req, res, options.ownWriteRefusal, 'auth.signInWithCustomToken') === false) return;
  const body = await readJsonObjectBody(req, res);
  if (body === null) return;
  const customToken = nonEmptyString(body, 'token');
  if (customToken === null) { sendAuthRestError(res, 400, 'INVALID_CUSTOM_TOKEN'); return; }
  const tenantId = nonEmptyString(body, 'tenantId');
  try {
    const auth = ensureAuth(options.ctx);
    const { user, isNewUser } = resolveCustomTokenIdentity(auth, customToken, tenantId);
    const session = authSandbox.mintSession(auth, { kind: 'custom', uid: user.uid, tenantId });
    await bestEffortFlush(options.ctx, 'auth.signInWithCustomToken');
    const tokenResult = await session.user.getIdTokenResult(true);
    const refreshToken = issueRefreshToken(options.ctx, session);
    const responseBody = { kind: 'identitytoolkit#VerifyCustomTokenResponse', idToken: tokenResult.token, refreshToken, expiresIn: EXPIRES_IN_SECONDS, isNewUser };
    sendJson(res, 200, responseBody);
  } catch (error) { sendAuthRestError(res, 400, authErrorLabel(error, 'INVALID_CUSTOM_TOKEN')); }
}
function parseTokenRefreshPayload(rawText: string, contentType: string | undefined): { grantType: string; refreshToken: string } | null {
  const trimmed = rawText.trim();
  const hasJsonHeader = contentType !== undefined && contentType.toLowerCase().includes('application/json');
  if (hasJsonHeader || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isPlainObject(parsed) === false) return null;
      return { grantType: firstPresent(nonEmptyString(parsed, 'grant_type'), nonEmptyString(parsed, 'grantType')), refreshToken: firstPresent(nonEmptyString(parsed, 'refresh_token'), nonEmptyString(parsed, 'refreshToken')) };
    } catch { return null; }
  }
  const params = new URLSearchParams(rawText);
  return { grantType: firstPresent(params.get('grant_type'), params.get('grantType')), refreshToken: firstPresent(params.get('refresh_token'), params.get('refreshToken')) };
}
async function handleSecureTokenRefresh(req: IncomingMessage, res: ServerResponse, options: RestAuthRtdbOptions): Promise<void> {
  if (requirePostAuthGuard(req, res, options.ownWriteRefusal, 'auth.tokenRefresh') === false) return;
  const rawText = await readUtf8Body(req, res, AUTH_BODY_LIMIT_BYTES);
  if (rawText === null) return;
  const parsedFields = parseTokenRefreshPayload(rawText, getHeader(req, 'content-type'));
  if (parsedFields === null) { sendAuthRestError(res, 400, 'INVALID_JSON_PAYLOAD', 'INVALID_ARGUMENT'); return; }
  if (parsedFields.grantType !== 'refresh_token') { sendAuthRestError(res, 400, 'INVALID_GRANT_TYPE', 'INVALID_ARGUMENT'); return; }
  if (parsedFields.refreshToken.length === 0) { sendAuthRestError(res, 400, 'MISSING_REFRESH_TOKEN', 'INVALID_ARGUMENT'); return; }
  const map = refreshMapFor(options.ctx);
  const existing = map.get(parsedFields.refreshToken);
  if (existing === undefined) { sendAuthRestError(res, 400, 'INVALID_REFRESH_TOKEN', 'INVALID_ARGUMENT'); return; }
  try {
    const refreshed = remintSessionWithClaims(ensureAuth(options.ctx), existing);
    map.delete(parsedFields.refreshToken);
    const nextRefreshToken = issueRefreshToken(options.ctx, refreshed);
    const tokenResult = await refreshed.user.getIdTokenResult(true);
    const projectId = resolveTargetProjectId(options.ctx);
    const responseBody = { access_token: tokenResult.token, expires_in: EXPIRES_IN_SECONDS, token_type: 'Bearer', refresh_token: nextRefreshToken, id_token: tokenResult.token, user_id: refreshed.user.uid, project_id: projectId };
    sendJson(res, 200, responseBody);
  } catch {
    map.delete(parsedFields.refreshToken);
    sendAuthRestError(res, 400, 'INVALID_REFRESH_TOKEN', 'INVALID_ARGUMENT');
  }
}

function extractRequestToken(req: IncomingMessage, url: URL): string | null | undefined {
  if (url.searchParams.has('auth')) {
    const queryToken = url.searchParams.get('auth') ?? '';
    if (queryToken.length === 0) return null;
    return queryToken;
  }
  const headerVal = getHeader(req, 'authorization');
  if (headerVal === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(headerVal.trim());
  if (match === null || match[1] === undefined) return null;
  return match[1];
}
function isIdTokenFreshAt(claims: Record<string, unknown>, nowSec: number): boolean {
  if (typeof claims.exp !== 'number' || nowSec >= claims.exp) return false;
  if (claims.nbf === undefined) return true;
  return typeof claims.nbf === 'number' && claims.nbf <= nowSec;
}
async function resolveRtdbAuthState(ctx: HostCtx, req: IncomingMessage, url: URL): Promise<{ ok: true; state: AuthState } | { ok: false }> {
  const rawToken = extractRequestToken(req, url);
  if (rawToken === null) return { ok: false };
  if (rawToken === undefined) return { ok: true, state: null };
  ensureAuth(ctx);
  const checked = await checkIdToken(rawToken);
  if (checked.ok === false || checked.header.alg !== 'RS256') return { ok: false };
  const claims = checked.claims as Record<string, unknown>;
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 128) return { ok: false };
  const expectedProject = resolveTargetProjectId(ctx);
  if (claims.aud !== expectedProject || claims.iss !== `${SECURETOKEN_ISSUER_PREFIX}${expectedProject}`) return { ok: false };
  const nowSec = Math.floor(getClock(ctx.sandbox).now() / 1000);
  if (isIdTokenFreshAt(claims, nowSec) === false) return { ok: false };
  if (authAccountsFor(ctx.sandbox)?.standing(sub).kind === 'disabled') return { ok: false };
  const rulesToken = rulesTokenFromIdToken(claims);
  const authState: NonNullable<AuthState> = { uid: sub, token: rulesToken };
  if (isPlainObject(rulesToken.firebase) && typeof rulesToken.firebase.tenant === 'string') authState.tenant = rulesToken.firebase.tenant;
  return { ok: true, state: authState };
}
function decodeRtdbTargetPath(rawPath: string): string | null {
  const decoded: string[] = [];
  for (const piece of rawPath.split('/')) {
    if (piece.length === 0) continue;
    try { decoded.push(decodeURIComponent(piece)); } catch { return null; }
  }
  if (decoded.length === 0) return '/';
  return `/${decoded.join('/')}`;
}
function shallowProjection(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const projected: Record<string, true> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) { if (child !== undefined) projected[key] = true; }
  return projected;
}
function databaseForAuthState(ctx: HostCtx, entry: HostRtdbInstance, state: AuthState): Database {
  if (state === null) {
    if (entry.anon === undefined) entry.anon = pyricGetDatabase(ctx.sandbox.withAuth(null), entry.selector);
    return entry.anon;
  }
  return pyricGetDatabase(ctx.sandbox.withAuth(state), entry.selector);
}
async function handleRtdbRest(req: IncomingMessage, res: ServerResponse, url: URL, rawPath: string, options: RestAuthRtdbOptions): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') { sendJson(res, 405, { error: 'Method not allowed.' }, 'GET, PUT, PATCH, DELETE'); return; }
  if (method !== 'GET' && options.ownWriteRefusal !== undefined) {
    sendJson(res, 403, { error: options.ownWriteRefusal({ action: `rtdb.rest.${method.toLowerCase()}`, writer: 'page' }).message });
    return;
  }
  const targetPath = decodeRtdbTargetPath(rawPath);
  if (targetPath === null) { sendJson(res, 400, { error: 'Invalid path.' }); return; }
  let instanceInput: string | undefined = url.searchParams.get('ns') ?? undefined;
  if (instanceInput === undefined) instanceInput = getHeader(req, 'x-pyric-database-instance');
  let entry: HostRtdbInstance;
  try { const resolvedInstance = resolveDatabaseInstance(instanceInput); entry = rtdbInstance(options.ctx, resolvedInstance?.name); } catch { sendJson(res, 400, { error: 'Invalid database instance.' }); return; }
  const authOutcome = await resolveRtdbAuthState(options.ctx, req, url);
  if (authOutcome.ok === false) { sendJson(res, 401, { error: 'Could not parse auth token.' }); return; }
  const db = databaseForAuthState(options.ctx, entry, authOutcome.state);
  try {
    const reference = rtdbRef(db, targetPath);
    if (method === 'GET') {
      const snapshot = await sdkActivity.silence(() => rawRtdbGet(reference));
      let result: unknown = snapshot.val();
      if (url.searchParams.get('shallow') === 'true') result = shallowProjection(result);
      sendJson(res, 200, result);
      return;
    }
    if (method === 'DELETE') { await sdkActivity.silence(() => rawRtdbRemove(reference)); await bestEffortFlush(options.ctx, 'rtdb.remove'); sendJson(res, 200, null); return; }
    const rawBody = await readUtf8Body(req, res, RTDB_BODY_LIMIT_BYTES);
    if (rawBody === null) return;
    let parsedValue: unknown;
    try { parsedValue = JSON.parse(rawBody); } catch { sendJson(res, 400, { error: 'Invalid JSON data.' }); return; }
    if (method === 'PATCH') {
      if (isPlainObject(parsedValue) === false) { sendJson(res, 400, { error: 'PATCH body must be a JSON object.' }); return; }
      await sdkActivity.silence(() => rawRtdbUpdate(reference, parsedValue));
      await bestEffortFlush(options.ctx, 'rtdb.update');
      sendJson(res, 200, parsedValue);
      return;
    }
    await sdkActivity.silence(() => rawRtdbSet(reference, parsedValue as never));
    await bestEffortFlush(options.ctx, 'rtdb.set');
    if (entry.admin === undefined) entry.admin = pyricGetAdminDatabase(options.ctx.sandbox, entry.selector);
    const savedSnapshot = await sdkActivity.silence(() => rawRtdbGet(rtdbRef(entry.admin as Database, targetPath)));
    sendJson(res, 200, savedSnapshot.val());
  } catch (error) {
    if (extractErrorCode(error) === 'PERMISSION_DENIED') { sendJson(res, 403, { error: 'Permission denied' }); return; }
    let message = 'Invalid Realtime Database request.';
    if (error instanceof Error) message = error.message;
    sendJson(res, 400, { error: message });
  }
}
export function createRestAuthRtdbHandler(options: RestAuthRtdbOptions): RestAuthRtdbHandler {
  return async (req, res, url) => {
    const route = classifyRestRoute(url.pathname);
    if (route === null) return false;
    if (route.kind === 'signInWithIdp') { await handleSignInWithIdp(req, res, options); return true; }
    if (route.kind === 'signInWithCustomToken') { await handleSignInWithCustomToken(req, res, options); return true; }
    if (route.kind === 'tokenRefresh') { await handleSecureTokenRefresh(req, res, options); return true; }
    await handleRtdbRest(req, res, url, route.rawPath, options);
    return true;
  };
}
