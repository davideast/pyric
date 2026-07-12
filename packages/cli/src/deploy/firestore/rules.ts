/**
 * Firestore rules deploy primitives. Pure-fetch over the
 * `firebaserules.googleapis.com/v1` API. Every public function
 * takes a `ProjectScope` per F3 and resolves the token per F4.
 *
 * Primitives (`fetch`, `deploy`) throw `AdminApiError` on non-2xx.
 * Orchestrators (`ensure`, `check`) return outcome types so the
 * caller's UI can branch each path explicitly.
 */

import { AdminApiError, type ProjectScope } from '../scope.js';

const RULES_API = 'https://firebaserules.googleapis.com/v1';

interface ReleaseResp { name: string; rulesetName: string }
interface RulesetResp { name: string; source: { files: { name: string; content: string }[] } }

/**
 * Fetch the Firestore rules source the project currently has
 * deployed (the `cloud.firestore` release). Returns `null` when no
 * release exists yet (greenfield project / Firestore not yet
 * initialized) — callers should write a fresh ruleset in that case.
 *
 * Throws `AdminApiError` on transport / auth failures so callers
 * can branch (e.g. show a permission-denied toast).
 */
export async function fetchCurrentRules(scope: ProjectScope): Promise<string | null> {
  const token = await scope.resolveToken();
  const releaseRes = await fetch(
    `${RULES_API}/projects/${encodeURIComponent(scope.projectId)}/releases/cloud.firestore`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (releaseRes.status === 404) return null;
  if (!releaseRes.ok) {
    throw new AdminApiError(
      releaseRes.status,
      await releaseRes.text(),
      `Failed to read release: ${releaseRes.status}`,
    );
  }
  const release = (await releaseRes.json()) as ReleaseResp;

  const rulesetRes = await fetch(`${RULES_API}/${release.rulesetName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!rulesetRes.ok) {
    throw new AdminApiError(
      rulesetRes.status,
      await rulesetRes.text(),
      `Failed to read ruleset: ${rulesetRes.status}`,
    );
  }
  const ruleset = (await rulesetRes.json()) as RulesetResp;
  const file =
    ruleset.source.files.find((f) => f.name.endsWith('.rules')) ??
    ruleset.source.files[0];
  if (!file) throw new AdminApiError(0, '', 'Ruleset has no source files');
  return file.content;
}

/**
 * Deploy a rules source to the `cloud.firestore` release. Two-step
 * server flow: create a new ruleset, then PATCH the release to
 * point at its name.
 */
export async function deploy(scope: ProjectScope, source: string): Promise<void> {
  const token = await scope.resolveToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const createRes = await fetch(
    `${RULES_API}/projects/${encodeURIComponent(scope.projectId)}/rulesets`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: { files: [{ name: 'firestore.rules', content: source }] },
      }),
    },
  );
  if (!createRes.ok) {
    throw new AdminApiError(
      createRes.status,
      await createRes.text(),
      `Failed to create ruleset: ${createRes.status}`,
    );
  }
  const created = (await createRes.json()) as { name: string };

  const releaseName = `projects/${scope.projectId}/releases/cloud.firestore`;
  // Try PATCH first (common case: release already exists from a prior
  // deploy). On 404 the release hasn't been created yet — happens on
  // any project that has never deployed Firestore rules via the API
  // (a fresh project, or one whose only prior rules came from the
  // Firebase Console's separate path). Fall back to POST against the
  // releases collection to create it.
  const patchRes = await fetch(`${RULES_API}/${releaseName}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      release: { name: releaseName, rulesetName: created.name },
    }),
  });
  if (patchRes.ok) return;
  if (patchRes.status !== 404) {
    throw new AdminApiError(
      patchRes.status,
      await patchRes.text(),
      `Failed to update release: ${patchRes.status}`,
    );
  }
  const createReleaseRes = await fetch(
    `${RULES_API}/projects/${encodeURIComponent(scope.projectId)}/releases`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: releaseName,
        rulesetName: created.name,
      }),
    },
  );
  if (!createReleaseRes.ok) {
    throw new AdminApiError(
      createReleaseRes.status,
      await createReleaseRes.text(),
      `Failed to create release: ${createReleaseRes.status}`,
    );
  }
}

/**
 * Inject a rule snippet into an existing rules source.
 *
 * Strategy: locate `match /databases/{database}/documents {` and
 * insert the snippet on the next line. Handles the common shape
 * (Firebase Console default + every example in the docs) without
 * parsing.
 *
 * - Returns the new source when the snippet is added.
 * - Returns `null` when `marker` is already present (no-op).
 * - Throws when the `documents { … }` block can't be located.
 */
export function inject(
  currentSource: string,
  snippet: string,
  marker: string,
): string | null {
  if (currentSource.includes(marker)) return null;

  const matchLineRe = /(match\s+\/databases\/\{database\}\/documents\s*\{)/;
  const m = matchLineRe.exec(currentSource);
  if (!m) {
    throw new Error(
      'Could not locate the `match /databases/{database}/documents` block in the current rules. ' +
        'Paste the rule snippet manually instead.',
    );
  }
  const insertAt = m.index + m[0].length;
  return (
    currentSource.slice(0, insertAt) +
    '\n' +
    snippet +
    '\n' +
    currentSource.slice(insertAt)
  );
}

export type RuleCheckResult =
  | { state: 'configured' }
  | { state: 'not-configured' }
  | { state: 'no-rules-yet' }
  | { state: 'check-failed'; message: string };

/**
 * Read-only probe: does the project's currently-deployed Firestore
 * ruleset already contain `marker`? Used by UIs to decide whether
 * to surface a "Configure rule" button.
 */
export async function check(
  scope: ProjectScope,
  marker: string,
): Promise<RuleCheckResult> {
  try {
    const current = await fetchCurrentRules(scope);
    if (current === null) return { state: 'no-rules-yet' };
    return current.includes(marker)
      ? { state: 'configured' }
      : { state: 'not-configured' };
  } catch (e) {
    return {
      state: 'check-failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export type EnsureRuleOutcome =
  | { ok: true; status: 'already-configured' | 'merged' | 'fresh' }
  | {
      ok: false;
      code: 'permission-denied' | 'merge-failed' | 'unknown';
      message: string;
    };

/**
 * Idempotent rule installer. Three branches:
 *
 *   - Project has no Firestore rules yet → deploy `freshTemplate`.
 *   - Rules exist and contain `marker` → no-op (`already-configured`).
 *   - Rules exist but lack `marker` → inject `snippet` and deploy.
 */
export async function ensure(
  scope: ProjectScope,
  config: { marker: string; snippet: string; freshTemplate: string },
): Promise<EnsureRuleOutcome> {
  try {
    const current = await fetchCurrentRules(scope);
    if (current === null) {
      await deploy(scope, config.freshTemplate);
      return { ok: true, status: 'fresh' };
    }
    const merged = inject(current, config.snippet, config.marker);
    if (merged === null) return { ok: true, status: 'already-configured' };
    await deploy(scope, merged);
    return { ok: true, status: 'merged' };
  } catch (e) {
    if (
      e instanceof AdminApiError &&
      (e.status === 401 || e.status === 403)
    ) {
      return { ok: false, code: 'permission-denied', message: e.message };
    }
    if (e instanceof Error && e.message.includes('Could not locate')) {
      return { ok: false, code: 'merge-failed', message: e.message };
    }
    return {
      ok: false,
      code: 'unknown',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
