/**
 * Rule probes built from a decoded ID token, shared by the production capture
 * (`capture-auth-request-auth.ts`, RTDB deployed), the Rules Test API capture
 * (`capture-auth-request-auth-rules-test-api.ts`, Firestore and Storage) and
 * the pyric replays. Each probe is one boolean expression on `auth` (RTDB) or
 * `request.auth` (Firestore and Storage) that holds in production when the
 * rules see that claim with that value.
 */

export type Claims = Record<string, unknown>;
export type Verdict = 'ALLOW' | 'DENY';
type Segment = string | number;

export interface Probe {
  label: string;
  /** RTDB `.read` expression on `auth`, or null when RTDB cannot express it. */
  rtdb: string | null;
  /** Firestore and Storage expression on `request.auth`, or null. */
  cel: string | null;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A claim path as an expression on `root` (`auth.token` or `request.auth.token`). */
export function access(root: string, path: Segment[]): string {
  return path.reduce<string>((expr, seg) => {
    if (typeof seg === 'number') return `${expr}[${seg}]`;
    return IDENT.test(seg) ? `${expr}.${seg}` : `${expr}[${JSON.stringify(seg)}]`;
  }, root);
}

function pathLabel(path: Segment[]): string {
  return path.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('').slice(1);
}

export function literal(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

export function leaves(value: unknown, path: Segment[] = []): { path: Segment[]; value: unknown }[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, [...path, i]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [{ path, value }];
}

export function has(claims: Claims, path: string[]): boolean {
  let cur: unknown = claims;
  for (const seg of path) {
    if (!cur || typeof cur !== 'object' || !(seg in (cur as object))) return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return true;
}

/** Claim names a rules author might read, probed for absence when the token does not carry them. */
const ABSENCE_CANDIDATES: string[][] = [
  ['uid'], ['provider_id'], ['email'], ['email_verified'], ['name'], ['picture'], ['phone_number'],
  ['sign_in_provider'], ['isAnonymous'], ['is_anonymous'], ['tenant'], ['user_id'], ['sub'], ['aud'], ['iss'],
  ['iat'], ['exp'], ['auth_time'], ['admin'], ['firebase', 'tenant'], ['firebase', 'sign_in_second_factor'],
  ['firebase', 'second_factor_identifier'], ['firebase', 'identities', 'email'], ['firebase', 'identities', 'phone'],
];

/**
 * The probes for one session. `uid` and `claims` are null for a signed-out
 * session. Every probe is expected to hold in production when the rules see
 * the decoded token, so a production DENY is itself a finding.
 */
export function probesFor(uid: string | null, claims: Claims | null, signInProvider: string | null): Probe[] {
  const probes: Probe[] = [];
  const add = (label: string, rtdb: string | null, cel: string | null) => probes.push({ label, rtdb, cel });
  if (uid === null || claims === null) {
    add('auth is null', 'auth == null', 'request.auth == null');
    return probes;
  }
  add('auth is not null', 'auth != null', 'request.auth != null');
  add('uid equals the session uid', `auth.uid == ${literal(uid)}`, `request.auth.uid == ${literal(uid)}`);
  add('rtdb auth.provider equals the sign-in provider', `auth.provider == ${literal(signInProvider)}`, null);
  add('rtdb auth.provider equals token firebase.sign_in_provider', 'auth.provider == auth.token.firebase.sign_in_provider', null);
  add('token.sub equals uid', 'auth.token.sub == auth.uid', 'request.auth.token.sub == request.auth.uid');
  add('token.user_id equals uid', 'auth.token.user_id == auth.uid', 'request.auth.token.user_id == request.auth.uid');
  add('token.iss is securetoken plus token.aud', "auth.token.iss == 'https://securetoken.google.com/' + auth.token.aud", "request.auth.token.iss == 'https://securetoken.google.com/' + request.auth.token.aud");
  add('token.exp minus token.iat is 3600', 'auth.token.exp - auth.token.iat == 3600', 'request.auth.token.exp - request.auth.token.iat == 3600');
  add('token.auth_time is at or before token.iat', 'auth.token.auth_time <= auth.token.iat', 'request.auth.token.auth_time <= request.auth.token.iat');
  add('token.iat is in the past', 'auth.token.iat * 1000 <= now', null);
  // The capture deploys and waits at least 8 s after every sign-in before it
  // reads, so a token minted at sign-in is more than 5 s old at evaluation.
  add('token.auth_time is more than 5 s before evaluation', 'auth.token.auth_time * 1000 < now - 5000', null);
  for (const { path, value } of leaves(claims)) {
    const hasIndex = path.some((s) => typeof s === 'number');
    add(`token.${pathLabel(path)} equals the decoded value`,
      hasIndex ? null : `${access('auth.token', path)} == ${literal(value)}`,
      `${access('request.auth.token', path)} == ${literal(value)}`);
  }
  for (const path of ABSENCE_CANDIDATES) {
    if (has(claims, path)) continue;
    add(`token.${path.join('.')} is absent (reads null)`, `${access('auth.token', path)} == null`, null);
  }
  // CEL type checks: how production types the token's JSON values.
  for (const [name, type] of [['iat', 'int'], ['exp', 'int'], ['auth_time', 'int'], ['email_verified', 'bool'], ['sub', 'string'], ['level', 'int'], ['ratio', 'float'], ['tags', 'list'], ['nested', 'map']] as const) {
    if (has(claims, [name])) add(`token.${name} is ${type}`, null, `request.auth.token.${name} is ${type}`);
  }
  add('token.firebase is map', null, 'request.auth.token.firebase is map');
  add('token.firebase.identities is map', null, 'request.auth.token.firebase.identities is map');
  if (has(claims, ['firebase', 'identities', 'email'])) {
    add('token.firebase.identities.email is list', null, 'request.auth.token.firebase.identities.email is list');
    add('token.firebase.identities.email[0] equals token.email', null, 'request.auth.token.firebase.identities.email[0] == request.auth.token.email');
  }
  return probes;
}

/** Replace identifying strings with placeholders, and numbers with `<int>` or `<float>`. */
export function redactor(secrets: Map<string, string>) {
  const redactString = (s: string): string => {
    let out = s;
    for (const [secret, placeholder] of [...secrets].sort((a, b) => b[0].length - a[0].length)) out = out.split(secret).join(placeholder);
    return out;
  };
  const shape = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isInteger(v) ? '<int>' : '<float>';
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(shape);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Claims)[k])]));
    return v;
  };
  return { redactString, shape };
}
