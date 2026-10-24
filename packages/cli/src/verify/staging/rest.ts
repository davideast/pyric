/**
 * A minimal Realtime Database REST client for the staging engine: data reads
 * and writes as admin or as an application user (`auth_variable_override`),
 * and the rules endpoint (`/.settings/rules.json`).
 *
 * Production applies an `auth_variable_override` object as the rules `auth`
 * variable, `auth.token` claims included; the identity capture recorded in
 * `packages/conformance/observations/rtdb-staging/rtdb-staging-auth-override.json`
 * pins that for every field the engine passes.
 */

/** The rules `auth` variable a request runs as; `null` is signed out. Absent is admin. */
export type RtdbAuthOverride = Record<string, unknown> | null;

export interface RtdbRestResponse {
  status: number;
  /** Parsed JSON body, or the raw text when it is not JSON. */
  body: unknown;
  text: string;
  /** The `ETag` of the location, when the request asked for it (`etag: true`). */
  etag?: string;
}

export interface RtdbRestRequest {
  /** Run as this `auth`; absent runs as admin. */
  auth?: RtdbAuthOverride;
  /** REST query parameters (`orderBy`, `startAt`, ...), already JSON-encoded where REST requires it. */
  query?: Record<string, string>;
  /** `export` returns priorities as `.priority` keys. */
  format?: 'export';
  shallow?: boolean;
  /** Ask for the location's `ETag` (a read), for a later conditional write. */
  etag?: boolean;
  /** Write only if the location's `ETag` is still this one; production answers 412 otherwise. */
  ifMatch?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}>;

export class RtdbRestClient {
  readonly databaseUrl: string;

  constructor(
    databaseUrl: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    this.databaseUrl = databaseUrl.replace(/\/+$/, '');
  }

  get(path: string, request: RtdbRestRequest = {}): Promise<RtdbRestResponse> {
    return this.send('GET', path, undefined, request);
  }

  put(path: string, value: unknown, request: RtdbRestRequest = {}): Promise<RtdbRestResponse> {
    return this.send('PUT', path, JSON.stringify(value), request);
  }

  patch(path: string, value: unknown, request: RtdbRestRequest = {}): Promise<RtdbRestResponse> {
    return this.send('PATCH', path, JSON.stringify(value), request);
  }

  delete(path: string, request: RtdbRestRequest = {}): Promise<RtdbRestResponse> {
    return this.send('DELETE', path, undefined, request);
  }

  /** The deployed rules as stored, comments included. */
  async getRulesText(): Promise<string> {
    const res = await this.rules('GET');
    if (res.status !== 200) throw new Error(`reading the rules of ${this.databaseUrl} failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    return res.text;
  }

  /** Deploy `source` as the rules, or validate it without deploying (`dryRun`). */
  putRules(source: string, options: { dryRun?: boolean } = {}): Promise<RtdbRestResponse> {
    return this.rules('PUT', source, options.dryRun === true);
  }

  private async rules(method: 'GET' | 'PUT', body?: string, dryRun = false): Promise<RtdbRestResponse> {
    const url = `${this.databaseUrl}/.settings/rules.json${dryRun ? '?dryRun=true' : ''}`;
    return this.fetchResponse(url, method, body);
  }

  private async send(method: string, path: string, body: string | undefined, request: RtdbRestRequest): Promise<RtdbRestResponse> {
    const params = new URLSearchParams();
    if (request.auth !== undefined) params.set('auth_variable_override', JSON.stringify(request.auth));
    if (request.format) params.set('format', request.format);
    if (request.shallow) params.set('shallow', 'true');
    for (const [key, value] of Object.entries(request.query ?? {})) params.set(key, value);
    const query = params.toString();
    const url = `${this.databaseUrl}${restPath(path) || '/'}.json${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = {};
    if (request.etag) headers['X-Firebase-ETag'] = 'true';
    if (request.ifMatch !== undefined) headers['if-match'] = request.ifMatch;
    return this.fetchResponse(url, method, body, headers);
  }

  private async fetchResponse(url: string, method: string, body?: string, extra: Record<string, string> = {}): Promise<RtdbRestResponse> {
    const res = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body }),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: keep the text.
    }
    const etag = res.headers?.get('etag') ?? undefined;
    return { status: res.status, body: parsed, text, ...(etag ? { etag } : {}) };
  }
}

/** `/a/b` for any of `a/b`, `/a/b/`, `a//b`; the root is the empty string. */
export function restPath(path: string): string {
  const segments = path.split('/').filter(Boolean).map(encodeURIComponent);
  return segments.length === 0 ? '' : `/${segments.join('/')}`;
}

/** Whether a REST status is the rules denying the request. */
export function isRestDenial(status: number): boolean {
  return status === 401 || status === 403;
}
