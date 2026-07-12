import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import type { Denial } from '../../../src/rules/index.js';

export const NOTES_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow read: if true;
      allow update: if request.auth.uid == resource.data.owner;
    }
  }
}`;

/**
 * Build a `Denial` by actually running the simulator — no hand-authored
 * trace. This is the same shape `useDenialTrace` produces, so the
 * component tests render REAL trace data.
 */
export function buildDenial(opts: {
  rules: string;
  method: Denial['method'];
  path: string;
  auth: Denial['auth'];
  requestData?: Record<string, unknown>;
  resourceData?: Record<string, unknown> | null;
  lens?: Denial['lens'];
}): Denial {
  const h = new SimulateFirestoreRulesHandler();
  const result = h.simulate(opts.rules, [
    {
      description: 'fixture',
      expectation: 'DENY',
      method: opts.method,
      path: opts.path,
      auth: opts.auth,
      ...(opts.requestData ? { data: opts.requestData } : {}),
      ...(opts.resourceData != null ? { resource: opts.resourceData } : {}),
    },
  ]);
  if (!result.success) throw new Error(`simulate failed: ${result.error.message}`);
  const r = result.data.results[0];
  return {
    method: opts.method,
    path: opts.path,
    auth: opts.auth,
    ...(opts.lens ? { lens: opts.lens } : {}),
    ...(opts.requestData ? { requestData: opts.requestData } : {}),
    ...(opts.resourceData != null ? { resourceData: opts.resourceData } : {}),
    at: 1781672601000,
    rulesSource: opts.rules,
    decision: 'DENY',
    evaluation: r.trace,
    ...(r.pathResolution ? { pathResolution: r.pathResolution } : {}),
  };
}

/** The canonical "alice edits bob's note" denial — the c-debug.html case. */
export function aliceDeniedUpdate(): Denial {
  return buildDenial({
    rules: NOTES_RULES,
    method: 'update',
    path: 'notes/3agHoZHZ',
    auth: { uid: 'alice', token: {} },
    requestData: { title: 'edited', owner: 'bob' },
    resourceData: { title: 'orig', owner: 'bob' },
    lens: { as: 'alice' },
  });
}

/** A no-match (default-deny) denial — path resolution, empty evaluation. */
export function noMatchDenial(): Denial {
  return buildDenial({
    rules: NOTES_RULES,
    method: 'get',
    path: 'widgets/x/sub/y',
    auth: { uid: 'alice', token: {} },
  });
}
