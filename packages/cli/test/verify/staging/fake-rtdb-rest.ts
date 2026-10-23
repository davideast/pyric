/**
 * A Realtime Database REST endpoint backed by a pyric sandbox, for testing
 * the staging engine without credentials: the data paths with
 * `auth_variable_override`, query parameters, `shallow`, and the rules
 * endpoint with `dryRun`. It is a test double for plumbing (which requests
 * the engine sends, what it restores, what it refuses); the live staging
 * test is the evidence for production's verdicts.
 */
import { parse as parseJsonc } from 'jsonc-parser';
import {
  endAt,
  equalTo,
  get,
  getAdminDatabase,
  getDatabase,
  limitToFirst,
  limitToLast,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  query,
  ref,
  remove,
  set,
  setPriority,
  startAt,
  update,
  sandbox as rtdbSandbox,
  type QueryConstraint,
} from 'pyric/database';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';

import type { FetchLike } from '../../../src/verify/staging/rest.js';

export interface FakeRtdbRest {
  fetch: FetchLike;
  sandbox: Sandbox;
  /** Every request, as `METHOD path?query`. */
  requests: string[];
  rulesText(): string;
  /** Force a response for matching requests, as production disagreeing with the sandbox would. */
  force(match: (method: string, path: string) => boolean, status: number): void;
  /** Fail the next rules deploy that is not a dry run. */
  failNextRulesDeploy(): void;
  /** Refuse every rules deploy, dry run included, with `message`, as production refuses rules it will not deploy. */
  refuseRules(message: string): void;
}

export function fakeRtdbRest(options: { rulesText: string; data?: Record<string, unknown> }): FakeRtdbRest {
  const sandbox = initializeSandbox();
  let rulesText = options.rulesText;
  rtdbSandbox.setRules(getDatabase(sandbox), parseJsonc(rulesText));
  if (options.data) rtdbSandbox.setData(getAdminDatabase(sandbox), options.data);
  const requests: string[] = [];
  const forced: Array<{ match: (method: string, path: string) => boolean; status: number }> = [];
  let failDeploy = false;
  let refusal: string | undefined;

  const respond = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });

  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname.replace(/\.json$/, '')) || '/';
    requests.push(`${init.method} ${path}${parsed.search}`);
    if (path === '/.settings/rules') {
      if (init.method === 'GET') return { status: 200, text: async () => rulesText };
      const source = init.body ?? '';
      if (refusal !== undefined && !source.includes('pyric verify staging')) return respond(400, { error: refusal });
      const json = parseJsonc(source);
      const rejection = json && typeof json === 'object' ? rtdbRulesSourceRejection(json) : { message: 'not JSON' };
      if (rejection) return respond(400, { error: rejection.message });
      if (parsed.searchParams.get('dryRun') === 'true') return respond(200, { status: 'ok' });
      if (failDeploy) {
        failDeploy = false;
        return respond(503, { error: 'unavailable' });
      }
      rulesText = source;
      rtdbSandbox.setRules(getDatabase(sandbox), json);
      return respond(200, { status: 'ok' });
    }
    const hit = forced.find((entry) => entry.match(init.method, path));
    if (hit) return respond(hit.status, { error: 'forced' });

    const override = parsed.searchParams.get('auth_variable_override');
    const db = override === null
      ? getAdminDatabase(sandbox)
      : getDatabase(sandbox.withAuth(JSON.parse(override) as never));
    try {
      if (init.method === 'GET') {
        const constraints = constraintsOf(parsed.searchParams);
        const snap = await get(constraints.length > 0 ? query(ref(db, path), ...constraints) : ref(db, path));
        const value = snap.val();
        if (parsed.searchParams.get('shallow') === 'true' && value !== null && typeof value === 'object') {
          return respond(200, Object.fromEntries(Object.keys(value).map((key) => [key, true])));
        }
        return respond(200, value);
      }
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      if (path.endsWith('/.priority')) {
        await setPriority(ref(db, path.slice(0, -'/.priority'.length)), body as never);
      } else if (init.method === 'PUT') {
        await set(ref(db, path), body);
      } else if (init.method === 'PATCH') {
        await update(ref(db, path), body as Record<string, unknown>);
      } else if (init.method === 'DELETE') {
        await remove(ref(db, path));
      }
      return respond(200, body ?? null);
    } catch (error) {
      if ((error as { code?: string }).code === 'PERMISSION_DENIED') return respond(401, { error: 'Permission denied' });
      return respond(400, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    fetch,
    sandbox,
    requests,
    rulesText: () => rulesText,
    force: (match, status) => forced.push({ match, status }),
    failNextRulesDeploy: () => { failDeploy = true; },
    refuseRules: (message) => { refusal = message; },
  };
}

function constraintsOf(params: URLSearchParams): QueryConstraint[] {
  const constraints: QueryConstraint[] = [];
  const orderBy = params.get('orderBy');
  if (orderBy !== null) {
    const order = JSON.parse(orderBy) as string;
    if (order === '$key') constraints.push(orderByKey());
    else if (order === '$value') constraints.push(orderByValue());
    else if (order === '$priority') constraints.push(orderByPriority());
    else constraints.push(orderByChild(order));
  }
  for (const [name, build] of [['startAt', startAt], ['endAt', endAt], ['equalTo', equalTo]] as const) {
    const value = params.get(name);
    if (value !== null) constraints.push(build(JSON.parse(value)));
  }
  const first = params.get('limitToFirst');
  if (first !== null) constraints.push(limitToFirst(Number(first)));
  const last = params.get('limitToLast');
  if (last !== null) constraints.push(limitToLast(Number(last)));
  return constraints;
}
