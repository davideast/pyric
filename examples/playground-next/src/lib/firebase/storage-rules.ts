/**
 * Browser-side Firebase Storage Rules client. Fetches the user's
 * currently-deployed storage ruleset for the chosen project, merges
 * in a `pyric_sessions/{userId}/{sessionId}` rule, and writes the
 * result back via the Rules API.
 *
 * Storage rules live at the same `firebaserules.googleapis.com/v1`
 * endpoint as Firestore rules, but under the `firebase.storage`
 * release name (vs `cloud.firestore`). The rest of the flow
 * mirrors `firestore-rules.ts` exactly — fetch release → fetch
 * ruleset → merge → create new ruleset → update release.
 *
 * The path-keyed ownership model (`pyric_sessions/{userId}/{sessionId}`)
 * makes the rule trivial: Firebase Auth UID must match the first path
 * segment. No field-based check, no resource.data inspection.
 */

const RULES_API = 'https://firebaserules.googleapis.com/v1';

/**
 * Release name for the project's Storage rules. Firebase Storage uses
 * per-bucket releases — `firebase.storage/{bucketId}` — for actual
 * rule application. The project-wide `firebase.storage` release exists
 * as a legacy alias but isn't bound to any bucket in modern projects;
 * deploying to it has no effect on enforcement.
 */
function storageReleaseName(bucketId: string): string {
  return `firebase.storage/${bucketId}`;
}

/**
 * The canonical `pyric_sessions/{userId}/{sessionId}` rules. Owner-
 * read enforced by Firebase Auth UID — every authenticated user can
 * read/write the legacy single-object path and nested export artifacts
 * under their own UID prefix, no other paths. UID-keyed (not email-keyed)
 * so the `@` and `.` in emails don't trip up path-segment matching.
 */
export const PYRIC_SESSIONS_RULE = `    match /pyric_sessions/{userId}/{sessionId} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;
    }
    match /pyric_sessions/{userId}/{sessionId}/{rest=**} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;
    }`;

const PYRIC_RULE_MARKER = 'match /pyric_sessions/';

const FRESH_RULESET = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${PYRIC_SESSIONS_RULE}
  }
}
`;

export class RulesApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, message: string) {
    super(message);
    this.name = 'RulesApiError';
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}… (truncated)`;
}

interface ReleaseResp { name: string; rulesetName: string }
interface RulesetResp { name: string; source: { files: { name: string; content: string }[] } }

/**
 * Fetch the project's currently-deployed Storage rules source.
 * Returns null when no Storage bucket / no rules release exists yet
 * — the caller should write a fresh ruleset in that case.
 */
export async function fetchCurrentRules(accessToken: string, projectId: string, bucketId: string): Promise<string | null> {
  const releaseRes = await fetch(
    `${RULES_API}/projects/${encodeURIComponent(projectId)}/releases/${storageReleaseName(bucketId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (releaseRes.status === 404) return null;
  if (!releaseRes.ok) {
    throw new RulesApiError(releaseRes.status, await releaseRes.text(), `Failed to read release: ${releaseRes.status}`);
  }
  const release = await releaseRes.json() as ReleaseResp;

  const rulesetRes = await fetch(
    `${RULES_API}/${release.rulesetName}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!rulesetRes.ok) {
    throw new RulesApiError(rulesetRes.status, await rulesetRes.text(), `Failed to read ruleset: ${rulesetRes.status}`);
  }
  const ruleset = await rulesetRes.json() as RulesetResp;
  const file = ruleset.source.files.find((f) => f.name.endsWith('.rules')) ?? ruleset.source.files[0];
  if (!file) throw new RulesApiError(0, '', 'Ruleset has no source files');
  return file.content;
}

/**
 * Inject the canonical `pyric_sessions` rule into a storage rules
 * source. Replaces an existing pyric_sessions block (any variant)
 * with the canonical one; inserts at the top of the
 * `match /b/{bucket}/o { … }` block when no rule exists. Returns
 * null when the canonical rule is already present byte-for-byte.
 */
export function injectPyricRule(currentSource: string): string | null {
  if (currentSource.includes(PYRIC_SESSIONS_RULE)) return null;

  if (currentSource.includes(PYRIC_RULE_MARKER)) {
    return replacePyricBlock(currentSource);
  }

  const matchLineRe = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;
  const m = matchLineRe.exec(currentSource);
  if (!m) {
    throw new Error(
      'Could not locate the `match /b/{bucket}/o` block in the current Storage rules. ' +
      'Paste the rule snippet manually instead.',
    );
  }
  const insertAt = m.index + m[0].length;
  return currentSource.slice(0, insertAt) + '\n' + PYRIC_SESSIONS_RULE + '\n' + currentSource.slice(insertAt);
}

/**
 * Find an existing `match /pyric_sessions/{...} { … }` block and
 * replace it with the canonical content. Brace counting is aware
 * of path-variable `{var}` patterns so a `{sessionId}` doesn't
 * confuse depth tracking.
 */
function replacePyricBlock(source: string): string {
  const matchIdx = source.indexOf(PYRIC_RULE_MARKER);
  if (matchIdx === -1) {
    throw new Error('replacePyricBlock called without an existing rule — caller bug');
  }
  let blockStart = matchIdx;
  while (blockStart > 0 && source[blockStart - 1] !== '\n') blockStart--;
  if (blockStart >= 1) {
    const prevLineEnd = blockStart - 1;
    let prevLineStart = prevLineEnd;
    while (prevLineStart > 0 && source[prevLineStart - 1] !== '\n') prevLineStart--;
    const prevLine = source.slice(prevLineStart, prevLineEnd).trimStart();
    if (prevLine.startsWith('//') && prevLine.toLowerCase().includes('pyric_sessions')) {
      blockStart = prevLineStart;
    }
  }

  let i = matchIdx;
  while (i < source.length) {
    if (source[i] === '{') {
      if (i > 0 && source[i - 1] === '/') {
        // Path variable — skip to its closing `}`.
        while (i < source.length && source[i] !== '}') i++;
        i++;
        continue;
      }
      break;
    }
    i++;
  }
  if (i >= source.length || source[i] !== '{') {
    throw new Error('Malformed pyric_sessions block — no opening brace');
  }
  const openIdx = i;

  let depth = 1;
  i = openIdx + 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === '{') {
      if (i > 0 && source[i - 1] === '/') {
        while (i < source.length && source[i] !== '}') i++;
        i++;
        continue;
      }
      depth++;
    } else if (c === '}') {
      depth--;
    }
    i++;
  }
  if (depth !== 0) throw new Error('Malformed pyric_sessions block — unmatched braces');

  let blockEnd = i;
  if (source[blockEnd] === '\n') blockEnd++;

  return source.slice(0, blockStart) + PYRIC_SESSIONS_RULE + '\n' + source.slice(blockEnd);
}

export async function deployRules(accessToken: string, projectId: string, bucketId: string, source: string): Promise<void> {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  const createRes = await fetch(
    `${RULES_API}/projects/${encodeURIComponent(projectId)}/rulesets`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { files: [{ name: 'storage.rules', content: source }] } }),
    },
  );
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '');
    throw new RulesApiError(
      createRes.status,
      body,
      `Failed to create ruleset (${createRes.status}): ${truncate(body, 400)}`,
    );
  }
  const created = await createRes.json() as { name: string };

  const releaseName = `projects/${projectId}/releases/${storageReleaseName(bucketId)}`;

  // PATCH updates an existing release; if no release exists yet for
  // this project (e.g. brand-new Storage enablement, no rules ever
  // deployed), PATCH 404s. Fall back to POST `releases.create` to
  // mint the release the first time.
  const patchRes = await fetch(`${RULES_API}/${releaseName}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ release: { name: releaseName, rulesetName: created.name } }),
  });
  if (patchRes.ok) return;

  if (patchRes.status === 404) {
    const createReleaseRes = await fetch(
      `${RULES_API}/projects/${encodeURIComponent(projectId)}/releases`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: releaseName, rulesetName: created.name }),
      },
    );
    if (!createReleaseRes.ok) {
      const body = await createReleaseRes.text().catch(() => '');
      throw new RulesApiError(
        createReleaseRes.status,
        body,
        `Failed to create release (${createReleaseRes.status}): ${truncate(body, 400)}`,
      );
    }
    return;
  }

  const body = await patchRes.text().catch(() => '');
  throw new RulesApiError(patchRes.status, body, `Failed to update release: ${patchRes.status} ${truncate(body, 200)}`);
}

export type ConfigureRulesOutcome =
  | {
      ok: true;
      status: 'already-configured' | 'configured' | 'fresh';
      /** True when CORS was successfully applied. False when CORS failed; check `corsError`. */
      corsConfigured?: boolean;
      /** Error message from the CORS step. Only present when `corsConfigured` is false. */
      corsError?: string;
    }
  | { ok: false; code: 'permission-denied' | 'merge-failed' | 'unknown'; message: string };

export type RuleCheckResult =
  | { state: 'configured' }
  | { state: 'not-configured' }
  | { state: 'no-rules-yet' }
  | { state: 'check-failed'; message: string };

export async function checkPyricRuleConfigured(
  accessToken: string,
  projectId: string,
  bucketId: string,
): Promise<RuleCheckResult> {
  try {
    const current = await fetchCurrentRules(accessToken, projectId, bucketId);
    if (current === null) return { state: 'no-rules-yet' };
    if (current.includes(PYRIC_SESSIONS_RULE)) return { state: 'configured' };
    return { state: 'not-configured' };
  } catch (e) {
    return { state: 'check-failed', message: e instanceof Error ? e.message : String(e) };
  }
}

export async function ensurePyricRule(accessToken: string, projectId: string, bucketId: string): Promise<ConfigureRulesOutcome> {
  let rulesOutcome: ConfigureRulesOutcome;
  try {
    const current = await fetchCurrentRules(accessToken, projectId, bucketId);
    if (current === null) {
      await deployRules(accessToken, projectId, bucketId, FRESH_RULESET);
      rulesOutcome = { ok: true, status: 'fresh' };
    } else {
      const merged = injectPyricRule(current);
      if (merged === null) {
        rulesOutcome = { ok: true, status: 'already-configured' };
      } else {
        await deployRules(accessToken, projectId, bucketId, merged);
        rulesOutcome = { ok: true, status: 'configured' };
      }
    }
  } catch (e) {
    if (e instanceof RulesApiError && (e.status === 403 || e.status === 401)) {
      return { ok: false, code: 'permission-denied', message: e.message };
    }
    if (e instanceof Error && e.message.includes('Could not locate')) {
      return { ok: false, code: 'merge-failed', message: e.message };
    }
    return { ok: false, code: 'unknown', message: e instanceof Error ? e.message : String(e) };
  }

  // Rules deployed cleanly. Now ensure the bucket has CORS configured
  // for the playground's origin — without this, browser uploads
  // succeed but XHR downloads (the load-session path) fail with
  // "No 'Access-Control-Allow-Origin' header". Buckets created via
  // Cloud Console (vs Firebase Console) ship with no CORS by default;
  // applying our defaults idempotently is safe.
  try {
    const { setBucketCors, defaultPlaygroundCors } = await import('pyric/storage');
    await setBucketCors(accessToken, bucketId, defaultPlaygroundCors(window.location.origin));
    return { ...rulesOutcome, corsConfigured: true };
  } catch (e) {
    // Rules went through but CORS didn't. Report partial success so
    // the user knows rules are good but downloads may still 403/CORS.
    return {
      ...rulesOutcome,
      corsConfigured: false,
      corsError: e instanceof Error ? e.message : String(e),
    };
  }
}
