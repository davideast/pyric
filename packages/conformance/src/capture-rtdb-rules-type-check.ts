#!/usr/bin/env bun
/**
 * Capture which RTDB rule expressions production's rules compiler accepts and
 * which it rejects, with the verbatim rejection message.
 *
 * Every probe submits one ruleset to `PUT /.settings/rules.json?dryRun=true`,
 * the validation request `firebase deploy` makes before it deploys database
 * rules. A dry run compiles and type-checks the ruleset without installing it,
 * so the database's active rules never change. The capture reads the active
 * rules before the first probe and after the last one and fails unless they
 * are byte-identical.
 *
 * Each probe places one expression at `/p/$id` under the rule kind it names,
 * so `$id` is the only declared path variable.
 *
 * Output: packages/pyric/test/rules/rtdb/grammar/fixtures/type-check/captures.json
 *
 * Credentials: the same contract as `run-rules-rtdb.ts`.
 *   PYRIC_ORACLE_FIREBASE_CONFIG  Web SDK config JSON with databaseURL.
 *   PYRIC_ORACLE_SA_PATH          service-account JSON path for the rules token.
 *
 * Usage:
 *   bun --env-file=.env run packages/conformance/src/capture-rtdb-rules-type-check.ts
 */
import { createSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT_DIR = join(REPO_ROOT, 'packages', 'pyric', 'test', 'rules', 'rtdb', 'grammar', 'fixtures', 'type-check');
const OUT = join(OUT_DIR, 'captures.json');

export type RtdbProbeKind = 'read' | 'write' | 'validate';

export interface RtdbTypeProbe {
  name: string;
  kind: RtdbProbeKind;
  expression: string;
}

const r = (name: string, expression: string): RtdbTypeProbe => ({ name, kind: 'read', expression });
const w = (name: string, expression: string): RtdbTypeProbe => ({ name, kind: 'write', expression });
const v = (name: string, expression: string): RtdbTypeProbe => ({ name, kind: 'validate', expression });

const NAMED_PROBES: readonly RtdbTypeProbe[] = [
  // Identifier scope.
  r('declared-path-variable', '$id == auth.uid'),
  r('undeclared-path-variable', '$other == auth.uid'),
  r('unknown-identifier', 'foo == 1'),
  r('newdata-in-read', 'newData.exists()'),
  w('query-in-write', 'query.limitToFirst <= 10'),
  r('query-in-read', 'query.limitToFirst <= 10'),
  r('now-in-read', 'now > 0'),
  v('root-in-validate', "root.child('a').exists()"),

  // The type of the whole rule.
  r('rule-string-member', 'auth.uid'),
  r('rule-number', '1'),
  r('rule-string-literal', "'a'"),
  r('rule-null', 'null'),
  r('rule-snapshot', 'data'),
  r('rule-auth', 'auth'),
  r('rule-val', 'data.val()'),
  r('rule-arithmetic', 'now + 1'),
  r('rule-ternary-number', 'auth != null ? 1 : 2'),
  r('rule-ternary-boolean', 'auth != null ? true : false'),
  r('rule-token-claim', 'auth.token.admin'),
  r('rule-not-string', '!auth.uid'),
  r('rule-and-string', 'auth.uid && true'),
  r('rule-or-number', 'true || 1'),
  r('rule-regex', '/a/'),
  r('rule-array', "['a']"),

  // Member access.
  r('snapshot-member', 'data.foo == 1'),
  r('snapshot-method-as-property', 'data.exists == true'),
  r('string-length-property', 'auth.uid.length > 0'),
  r('string-length-call', 'auth.uid.length() > 0'),
  w('val-length-call', 'newData.val().length() > 0'),
  w('val-length-property', 'newData.val().length > 0'),
  w('val-member', 'newData.val().foo == 1'),
  w('val-index', "newData.val()['kind'] == 'a'"),
  r('auth-unknown-property', 'auth.foo == 1'),
  r('auth-provider', "auth.provider == 'password'"),
  r('auth-index', "auth['uid'] == 'a'"),
  r('token-index', "auth.token['admin'] == true"),
  r('token-nested-claim', "auth.token.firebase.sign_in_provider == 'password'"),
  r('now-member', 'now.foo == 1'),
  r('query-unknown-property', 'query.foo == 1'),
  r('query-order-by-child', "query.orderByChild == 'a'"),
  r('path-variable-length', '$id.length > 0'),
  r('path-variable-method', "$id.beginsWith('a')"),
  r('path-variable-val', "$id.val() == 'a'"),
  r('string-literal-method', "'abc'.contains('a')"),
  r('snapshot-two-unknown-members', 'data.foo == 1 && data.bar == 2'),

  // Methods on the wrong receiver.
  r('auth-exists', 'auth.exists()'),
  r('string-val', "auth.uid.val() == 'a'"),
  r('snapshot-contains', "data.contains('a')"),
  r('string-literal-val', "'s'.val() == 's'"),
  r('number-val', 'now.val() > 0'),
  r('number-contains', "now.contains('a')"),
  r('snapshot-unknown-method', 'data.foo()'),
  r('string-unknown-method', 'auth.uid.foo()'),
  w('val-unknown-method', 'newData.val().foo()'),
  w('val-child', "newData.val().child('a').exists()"),
  w('val-string-method', "newData.val().contains('a')"),
  r('string-to-upper-case', "auth.uid.toUpperCase() == 'A'"),
  r('auth-token-exists', 'auth.token.exists()'),
  r('query-method', 'query.exists()'),

  // Method arity.
  r('child-no-argument', 'data.child().exists()'),
  r('child-two-arguments', "data.child('a', 'b').exists()"),
  r('has-child-no-argument', 'data.hasChild()'),
  r('exists-argument', 'data.exists(1)'),
  r('val-argument', "data.val('a') == 1"),
  r('has-children-no-argument', 'data.hasChildren()'),
  r('has-children-list', "data.hasChildren(['a', 'b'])"),
  r('has-children-two-lists', "data.hasChildren(['a'], ['b'])"),
  r('is-string-argument', 'data.isString(1)'),
  r('parent-argument', "data.parent('a').exists()"),
  r('get-priority-argument', 'data.getPriority(1) == null'),
  r('contains-no-argument', 'auth.uid.contains()'),
  r('replace-one-argument', "auth.uid.replace('a') == 'b'"),
  r('to-lower-case-argument', "auth.uid.toLowerCase('a') == 'b'"),
  r('matches-no-argument', 'auth.uid.matches()'),

  // Argument types.
  r('child-number', 'data.child(1).exists()'),
  r('child-path-variable', 'data.child($id).exists()'),
  r('child-auth-uid', 'data.child(auth.uid).exists()'),
  w('child-val', 'data.child(newData.val()).exists()'),
  r('child-concatenation', "root.child('a/' + $id).exists()"),
  r('child-snapshot', 'data.child(data).exists()'),
  r('child-boolean', 'data.child(true).exists()'),
  r('has-child-number', 'data.hasChild(1)'),
  r('has-children-string', "data.hasChildren('a')"),
  r('has-children-number-list', 'data.hasChildren([1])'),
  w('has-children-val', 'data.hasChildren(newData.val())'),
  r('matches-string', "auth.uid.matches('a')"),
  r('matches-regex-flags', 'auth.uid.matches(/a/i)'),
  r('contains-number', 'auth.uid.contains(1)'),
  r('contains-regex', 'auth.uid.contains(/a/)'),
  r('begins-with-snapshot', 'auth.uid.beginsWith(data)'),
  r('replace-regex', "auth.uid.replace(/a/, 'b') == 'b'"),
  r('replace-number', "auth.uid.replace('a', 1) == 'b'"),

  // Operators.
  r('snapshot-greater-than', 'data > 1'),
  r('snapshot-equals-null', 'data == null'),
  r('snapshot-not-equals-string', "data != 'locked'"),
  r('snapshot-strict-equals-snapshot', 'data === data'),
  w('snapshot-plus', 'newData + 1 > 0'),
  r('snapshot-not', '!data'),
  r('snapshot-negate', '-data > 0'),
  r('snapshot-and', 'data && true'),
  r('auth-equals-null', 'auth == null'),
  r('auth-greater-than', 'auth > 1'),
  r('auth-plus', 'auth + 1 == 1'),
  r('token-equals-null', 'auth.token == null'),
  r('string-minus', 'auth.uid - 1 == 0'),
  r('string-times', "'a' * 2 == 'aa'"),
  r('string-plus-number', "auth.uid + 1 == 'a1'"),
  r('string-greater-than-number', 'auth.uid > 1'),
  r('string-equals-number', 'auth.uid == 1'),
  r('number-plus-string', "now + 'a' == 'a'"),
  r('negate-string', '-auth.uid == 1'),
  r('not-number', '!now'),
  r('boolean-plus', 'true + 1 == 2'),
  r('boolean-greater-than', 'true > false'),
  r('null-plus', 'null + 1 == 1'),
  r('regex-equals', '/a/ == /a/'),
  r('array-equals', "['a'] == ['a']"),
  w('val-plus', 'newData.val() + 1 > 0'),
  w('val-not', '!newData.val()'),
  w('val-and', 'newData.val() && true'),
  r('ternary-string-condition', 'auth.uid ? true : false'),
  r('ternary-mixed-branches', 'auth != null ? true : 1'),
  r('boolean-equals-comparison', '(1 < 2) == true'),
  r('string-plus-snapshot', "'a' + data == 'a'"),
  r('path-variable-greater-than-number', '$id > 1'),
  r('string-strict-equals-null', 'auth.uid === null'),
  r('number-strict-equals-string', "now === 'a'"),
  r('modulo-string', "now % 'a' == 0"),
  r('divide-number', 'now / 2 > 0'),

  // Operand rules for each operator, both sides.
  r('snapshot-strict-not-equals', "data !== 'a'"),
  r('equals-right-snapshot', '1 == data'),
  r('not-equals-right-snapshot', '1 != data'),
  r('greater-than-right-snapshot', '1 > data'),
  r('less-than-left-boolean', 'true < 1'),
  r('less-equals-right-boolean', '1 <= true'),
  r('greater-equals-null', 'null >= 1'),
  r('number-greater-than-string', "now > 'a'"),
  r('string-less-than-string', "'a' < 'b'"),
  r('minus-left-string', "'a' - 1 == 0"),
  r('minus-right-snapshot', '1 - data == 0'),
  r('times-right-string', "1 * 'a' == 0"),
  r('divide-left-boolean', 'true / 1 == 0'),
  r('modulo-left-null', 'null % 1 == 0'),
  r('plus-numbers', '1 + 2 == 3'),
  w('plus-string-val', "'a' + newData.val() == 'ab'"),
  r('plus-right-boolean', '1 + true == 2'),
  r('negate-string-literal', "-'a' == 1"),
  r('negate-boolean', '-true == 1'),
  r('negate-number', '-now < 0'),
  r('not-comparison', '!(auth != null)'),
  r('not-snapshot-method', '!data.exists()'),
  r('or-left-string', "'a' || true"),
  r('and-right-snapshot', 'true && data'),
  r('ternary-snapshot-condition', 'data ? true : false'),
  r('ternary-string-branches', "(auth != null ? 'a' : 'b') == 'a'"),
  r('ternary-mixed-branches-compared', "(auth != null ? 'a' : 1) == 'a'"),
  r('ternary-snapshot-branches-compared', '(auth != null ? data : data) == 1'),
  w('ternary-val-branch', 'auth != null ? newData.val() : true'),
  r('boolean-method-greater-than', 'data.exists() > 1'),
  r('boolean-method-plus', 'data.exists() + 1 == 2'),
  r('strict-equals-string-number', "'a' === 1"),
  r('val-strict-equals-null', 'data.val() === null'),
  r('val-equals-val', 'data.val() == data.val()'),
  r('token-claim-equals-true', 'auth.token.admin == true'),
  r('token-claim-strict-equals-true', 'auth.token.admin === true'),
  r('auth-not-equals-null', 'auth != null'),
  r('auth-and', 'auth && true'),

  // Member access on each receiver type.
  r('boolean-member', '(true).foo == 1'),
  r('null-member', 'null.foo == 1'),
  r('number-length', 'now.length == 1'),
  r('regex-member', '/a/.foo == 1'),
  r('array-member', "['a'].length == 1"),
  r('snapshot-index', "data['a'] == 1"),
  r('string-index', "'abc'[0] == 'a'"),
  r('path-variable-index', "$id[0] == 'a'"),
  w('val-index-variable', 'newData.val()[$id] == 1'),
  r('auth-uid-index', "auth.uid[0] == 'a'"),
  r('snapshot-index-variable', 'data[$id] == 1'),
  r('number-index', 'now[0] == 1'),
  r('query-index-literal', "query['orderByKey']"),
  r('string-index-length', "'abc'['length'] > 0"),
  r('auth-index-variable', 'auth[$id] == 1'),
  w('val-index-length', "newData.val()['length'] > 0"),
  r('snapshot-index-method-name', "data['exists']() == true"),
  r('auth-uid-string-method', "auth.uid.contains('a')"),
  r('auth-uid-length', 'auth.uid.length > 0'),
  r('auth-uid-nested-property', "auth.uid.foo == 'a'"),
  r('auth-nested-claim-index', "auth.token.firebase.identities['google.com'] != null"),
  r('auth-call', 'auth() == null'),
  r('val-length-read', 'data.val().length > 0'),
  r('val-matches', 'data.val().matches(/a/)'),
  r('val-to-lower-case', "data.val().toLowerCase() == 'a'"),
  r('child-val-string-method', "data.child('a').val().contains('x')"),
  r('path-variable-contains', "$id.contains('a')"),
  r('path-variable-plus', "$id + 'x' == 'ax'"),
  r('get-priority-equals-null', 'data.getPriority() == null'),
  r('get-priority-greater-than', 'data.getPriority() > 1'),
  r('get-priority-length', 'data.getPriority().length > 1'),
  r('parent-child-exists', "data.parent().child('x').exists()"),
  r('child-child-path-variable', "data.child('a').child($id).exists()"),
  r('snapshot-method-as-property-member', 'data.exists.foo == 1'),
  r('string-length-member', "auth.uid.length.foo == 1"),
  r('val-length-call-read', 'data.val().length() > 0'),
  r('number-call', 'now() > 0'),
  r('snapshot-call', 'data() == null'),
  r('string-literal-call', "'a'() == null"),

  // query in each rule kind, and query property types.
  v('query-in-validate', 'query.limitToFirst <= 10'),
  r('query-order-by-key-rule', 'query.orderByKey'),
  r('query-order-by-value-rule', 'query.orderByValue'),
  r('query-order-by-priority-rule', 'query.orderByPriority'),
  r('query-limit-to-first-rule', 'query.limitToFirst'),
  r('query-limit-to-last-compared', 'query.limitToLast <= 10'),
  r('query-start-at-compared', 'query.startAt == 1'),
  r('query-end-at-compared', "query.endAt == 'a'"),
  r('query-equal-to-compared', "query.equalTo == 'a'"),
  r('query-order-by-key-not', '!query.orderByKey'),
  r('query-order-by-child-member', "query.orderByChild.length > 1"),
  r('query-limit-to-first-call', 'query.limitToFirst() <= 10'),
  r('query-rule', 'query'),
  r('query-equals-null', 'query == null'),
  w('query-in-write-boolean-property', 'query.orderByKey'),

  // Arity and argument types for every method.
  r('has-child-two-arguments', "data.hasChild('a', 'b')"),
  r('has-child-path-variable', 'data.hasChild($id)'),
  r('has-child-val', 'data.hasChild(data.val())'),
  r('has-children-empty-list', 'data.hasChildren([])'),
  r('has-children-path-variable-list', 'data.hasChildren([$id])'),
  r('has-children-auth-list', 'data.hasChildren([auth.uid])'),
  r('has-children-val-list', 'data.hasChildren([data.val()])'),
  r('has-children-snapshot-list', 'data.hasChildren([data])'),
  r('is-number-argument', 'data.isNumber(1)'),
  r('is-boolean-argument', 'data.isBoolean(1)'),
  r('begins-with-no-argument', 'auth.uid.beginsWith()'),
  r('begins-with-two-arguments', "auth.uid.beginsWith('a', 'b')"),
  r('ends-with-no-argument', 'auth.uid.endsWith()'),
  r('ends-with-number', 'auth.uid.endsWith(1)'),
  r('ends-with-val', "auth.uid.endsWith(data.val())"),
  r('contains-two-arguments', "auth.uid.contains('a', 'b')"),
  r('replace-three-arguments', "auth.uid.replace('a', 'b', 'c') == 'b'"),
  r('replace-val-arguments', "auth.uid.replace(data.val(), data.val()) == 'b'"),
  r('to-upper-case-argument', "auth.uid.toUpperCase('a') == 'b'"),
  r('matches-two-arguments', 'auth.uid.matches(/a/, /b/)'),
  r('matches-val', 'auth.uid.matches(data.val())'),
  r('matches-number', 'auth.uid.matches(1)'),
  r('array-argument-to-child', "data.child(['a']).exists()"),
  r('regex-argument-to-child', 'data.child(/a/).exists()'),
  r('regex-argument-to-has-children', 'data.hasChildren(/a/)'),
  r('array-in-ternary', "(true ? ['a'] : ['b']) == 1"),

  // A ternary whose branches differ in type.
  r('mixed-ternary-not', '!(true ? true : 1)'),
  r('mixed-ternary-and', '(true ? true : 1) && true'),
  r('mixed-ternary-condition', '(true ? true : 1) ? true : false'),
  r('mixed-ternary-member', '(true ? data : 1).foo == 1'),
  r('mixed-ternary-method', '(true ? data : 1).exists()'),
  r('mixed-ternary-minus', "(true ? 'a' : 1) - 1 == 0"),
  r('mixed-ternary-child-argument', "data.child(true ? 'a' : 1).exists()"),
  r('boolean-ternary-rule', '(true ? true : false)'),
];

/** One expression of each static type, valid in a .read rule under /p/$id. */
export const TYPE_SAMPLES: Readonly<Record<string, string>> = {
  boolean: 'true',
  number: '1',
  now: 'now',
  string: "'a'",
  'path-variable': '$id',
  null: 'null',
  regex: '/a/',
  snapshot: 'data',
  'snapshot-method': 'data.exists',
  val: 'data.val()',
  priority: 'data.getPriority()',
  auth: 'auth',
  'auth-property': 'auth.uid',
  query: 'query',
  'query-flag': 'query.orderByKey',
  'query-value': 'query.limitToFirst',
  array: "['a']",
};

/** Each position a typed operand can take; `@` stands for the parenthesized sample. */
export const TYPE_POSITIONS: Readonly<Record<string, string>> = {
  rule: '@',
  not: '!@',
  negate: '-@ == 1',
  'and-left': '@ && true',
  'and-right': 'true && @',
  'or-left': '@ || true',
  'or-right': 'true || @',
  'ternary-condition': '@ ? true : false',
  'ternary-same-branches': '(true ? @ : @) == 1',
  'ternary-mixed-branches': '(true ? @ : 1) == 1',
  'equals-left': '@ == 1',
  'equals-right': '1 == @',
  'not-equals-left': '@ != 1',
  'not-equals-right': '1 != @',
  'strict-equals-left': '@ === 1',
  'strict-not-equals-right': '1 !== @',
  'greater-left': '@ > 1',
  'greater-right': '1 > @',
  'less-equals-left': '@ <= 1',
  'plus-left': '@ + 1 == 1',
  'plus-right': "'a' + @ == 1",
  'minus-left': '@ - 1 == 1',
  'minus-right': '1 - @ == 1',
  'times-left': '@ * 1 == 1',
  'modulo-right': '1 % @ == 1',
  'member-unknown': '@.foo == 1',
  'member-length': '@.length > 0',
  'index-variable': '@[$id] == 1',
  'index-literal': "@['foo'] == 1",
  'call-string-method': "@.contains('a')",
  'call-snapshot-method': '@.exists()',
  'child-argument': 'data.child(@).exists()',
  'has-child-argument': 'data.hasChild(@)',
  'has-children-argument': 'data.hasChildren(@)',
  'has-children-element': 'data.hasChildren([@])',
  'contains-argument': "'a'.contains(@)",
  'replace-first-argument': "'a'.replace(@, 'b') == 'b'",
  'replace-second-argument': "'a'.replace('a', @) == 'b'",
  'matches-argument': "'a'.matches(@)",
};

/** Every sample in every position: production's verdict for each static type at each operand slot. */
const MATRIX_PROBES: readonly RtdbTypeProbe[] = Object.entries(TYPE_POSITIONS).flatMap(([position, template]) =>
  Object.entries(TYPE_SAMPLES).map(([type, sample]) =>
    r(`${position}:${type}`, template.replaceAll('@', `(${sample})`)),
  ),
);

export const PROBES: readonly RtdbTypeProbe[] = [...NAMED_PROBES, ...MATRIX_PROBES];

export interface RtdbTypeProbeRecord extends RtdbTypeProbe {
  rules: { rules: Record<string, unknown> };
  status: number;
  accepted: boolean;
  /** The rejection text with production's leading `line:column: ` position removed. */
  message?: string;
}

/** The ruleset a probe submits. */
export function probeRules(probe: RtdbTypeProbe): { rules: Record<string, unknown> } {
  return { rules: { p: { $id: { [`.${probe.kind}`]: probe.expression } } } };
}

interface FirebaseWebConfig { projectId: string; databaseURL?: string }
interface ServiceAccount { client_email: string; private_key: string; project_id: string; token_uri?: string }

async function mintToken(sa: ServiceAccount, scope: string): Promise<string> {
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: sa.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600 }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(sa.private_key).toString('base64url');
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Production's rejection text without its `line:column: ` prefix and trailing newline. */
export function rejectionMessage(body: string): string {
  let text = body;
  try {
    text = String((JSON.parse(body) as { error?: unknown }).error ?? body);
  } catch {
    // Not JSON; keep the raw body.
  }
  return text.trim().replace(/^\d+:\d+: /, '');
}

async function main(): Promise<void> {
  const rawConfig = process.env.PYRIC_ORACLE_FIREBASE_CONFIG;
  if (!rawConfig) throw new Error('PYRIC_ORACLE_FIREBASE_CONFIG is not set.');
  const config = JSON.parse(rawConfig) as FirebaseWebConfig;
  if (!config.databaseURL) throw new Error('PYRIC_ORACLE_FIREBASE_CONFIG has no databaseURL.');
  const saPath = process.env.PYRIC_ORACLE_SA_PATH ? resolve(process.env.PYRIC_ORACLE_SA_PATH) : join(REPO_ROOT, 'ignored', 'service-account.json');
  if (!existsSync(saPath)) throw new Error(`service account not found at ${saPath}. Set PYRIC_ORACLE_SA_PATH.`);
  const sa = JSON.parse(readFileSync(saPath, 'utf8')) as ServiceAccount;
  if (sa.project_id !== config.projectId) {
    throw new Error(`service account project ${sa.project_id} does not match config project ${config.projectId}.`);
  }

  const token = await mintToken(
    sa,
    'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
  );
  const rulesUrl = `${config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(token)}`;
  const readActive = async (): Promise<string> => {
    const res = await fetch(rulesUrl);
    if (!res.ok) throw new Error(`read rules failed: ${res.status}`);
    return res.text();
  };

  const before = await readActive();
  const probes: RtdbTypeProbeRecord[] = [];
  for (const probe of PROBES) {
    const rules = probeRules(probe);
    const res = await fetch(`${rulesUrl}&dryRun=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rules),
    });
    const body = await res.text();
    if (res.status !== 200 && res.status !== 400) {
      throw new Error(`probe ${probe.name}: unexpected status ${res.status}`);
    }
    const record: RtdbTypeProbeRecord = { ...probe, rules, status: res.status, accepted: res.ok };
    if (!res.ok) record.message = rejectionMessage(body);
    probes.push(record);
    console.log(`  ${probe.name.padEnd(36)} ${record.accepted ? 'accepted' : 'REJECTED'} ${record.message ?? ''}`);
  }
  const after = await readActive();
  if (after !== before) {
    throw new Error('the active rules changed during the dry-run capture; inspect the database rules.');
  }
  console.log('[rtdb-type-check] active rules read back byte-identical to the pre-run read.');

  mkdirSync(OUT_DIR, { recursive: true });
  const fixture = {
    schema: 'pyric.rtdb-rules-type-check.v1',
    capturedAt: new Date().toISOString(),
    projectId: config.projectId,
    method:
      'PUT /.settings/rules.json?dryRun=true, the validation request firebase deploy makes, one ruleset per probe from PROBES in packages/conformance/src/capture-rtdb-rules-type-check.ts; status 200 accepts, status 400 rejects with the recorded message. Active rules read back unchanged.',
    calls: probes.length,
    probes,
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`[rtdb-type-check] ${probes.length} dry-run validations; wrote ${OUT}`);
}

if (import.meta.main) {
  await main();
}
