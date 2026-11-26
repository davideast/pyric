/**
 * Stateless read-only deployed Security Rules readers for Live mode (`#2363`).
 *
 * Covers:
 * - Firestore: Firebase Rules REST API
 *   `projects/{project}/releases/cloud.firestore` (and named database releases
 *   `projects/{project}/releases/cloud.firestore/{database}`) -> ruleset source.
 * - Cloud Storage: Firebase Rules REST API
 *   `projects/{project}/releases/firebase.storage/{bucket}` -> ruleset source.
 * - Realtime Database: read-only `GET <databaseUrl>/.settings/rules.json`,
 *   reusing `parseRtdbRulesText` and `diffRtdbRules`.
 *
 * Every release lookup validates `rulesetName` against the requested
 * `projectId` (`^projects/<projectId>/rulesets/[A-Za-z0-9_-]+$`) so a response
 * can never steer the second GET to another project.
 */
import { parseRtdbRulesText } from '../../rtdb/rules-json.js';
import { rulesHashOf } from '../rules.js';
import type {
  DeployedRulesAuthSource,
  DeployedRulesTokenProvider,
} from './deployed-rules-auth.js';
import {
  compareRtdbRulesDrift,
  compareTextRulesDrift,
  type RulesDriftReport,
} from './deployed-rules-drift.js';
import {
  FIREBASE_RULES_API_ORIGIN,
  readOnlyRulesGet,
  resolveAllowedRtdbRulesUrl,
  validateFirestoreDatabaseId,
  validateProjectId,
  validateRulesetResourceName,
  validateStorageBucketId,
  type DeployedRulesFetchError,
} from './deployed-rules-http.js';

export type DeployedRulesService = 'firestore' | 'rtdb' | 'storage';

export interface DeployedRulesSourceFile {
  readonly name: string;
  readonly content: string;
}

export interface DeployedFirestoreRulesSnapshot {
  readonly service: 'firestore';
  readonly projectId: string;
  readonly databaseId: string;
  readonly releaseName: string;
  readonly rulesetName: string;
  readonly rulesetId: string;
  readonly source: string;
  readonly files: readonly DeployedRulesSourceFile[];
  readonly hash: string;
  readonly fetchedAt: number;
  readonly authSource: DeployedRulesAuthSource;
  readonly drift: RulesDriftReport;
}

export interface DeployedStorageRulesSnapshot {
  readonly service: 'storage';
  readonly projectId: string;
  readonly bucket: string;
  readonly releaseName: string;
  readonly rulesetName: string;
  readonly rulesetId: string;
  readonly source: string;
  readonly files: readonly DeployedRulesSourceFile[];
  readonly hash: string;
  readonly fetchedAt: number;
  readonly authSource: DeployedRulesAuthSource;
  readonly drift: RulesDriftReport;
}

export interface DeployedRtdbRulesSnapshot {
  readonly service: 'rtdb';
  readonly databaseUrl: string;
  readonly instance: string;
  readonly source: string;
  readonly parsed: { readonly rules: Record<string, unknown> };
  readonly hash: string;
  readonly fetchedAt: number;
  readonly authSource: DeployedRulesAuthSource;
  readonly drift: RulesDriftReport;
}

export type DeployedRulesReadResult<T> =
  | { readonly ok: true; readonly snapshot: T }
  | { readonly ok: false; readonly disabled: true }
  | { readonly ok: false; readonly disabled?: false; readonly error: DeployedRulesFetchError };

export interface ReadDeployedFirestoreRulesInput {
  readonly projectId: string;
  readonly databaseId?: string;
  readonly localRulesText?: string | null;
  readonly tokenProvider: DeployedRulesTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface ReadDeployedStorageRulesInput {
  readonly projectId: string;
  readonly bucket?: string;
  readonly localRulesText?: string | null;
  readonly tokenProvider: DeployedRulesTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface ReadDeployedRtdbRulesInput {
  readonly databaseUrlOrInstance: string;
  readonly localRulesText?: string | null;
  readonly tokenProvider: DeployedRulesTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export const DEFAULT_FIRESTORE_DATABASE = '(default)';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonBody(
  text: string,
  label: string,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: DeployedRulesFetchError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        error: { code: 'parse-error', message: `Deployed ${label} response was not valid JSON.` },
      };
    }
    throw error;
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: { code: 'parse-error', message: `Deployed ${label} response was not a JSON object.` },
    };
  }
  return { ok: true, value: parsed };
}

function extractRulesetFiles(
  rulesetBody: Record<string, unknown>,
  preferredFileName: string,
  serviceDirective: string,
): { readonly source: string; readonly files: readonly DeployedRulesSourceFile[] } | null {
  const source = rulesetBody.source;
  if (!isPlainObject(source) || !Array.isArray(source.files)) {
    return null;
  }
  const files: DeployedRulesSourceFile[] = [];
  for (const file of source.files) {
    if (isPlainObject(file) && typeof file.content === 'string') {
      const name = typeof file.name === 'string' && file.name.trim().length > 0 ? file.name.trim() : preferredFileName;
      files.push({ name, content: file.content });
    }
  }
  const firstFile = files[0];
  if (firstFile === undefined) {
    return null;
  }
  if (files.length === 1) {
    return { source: firstFile.content, files };
  }
  const byName = files.find((file) => file.name === preferredFileName || file.name.endsWith(`/${preferredFileName}`));
  if (byName !== undefined) {
    return { source: byName.content, files };
  }
  const byDirective = files.find((file) => file.content.includes(serviceDirective));
  if (byDirective !== undefined) {
    return { source: byDirective.content, files };
  }
  return { source: firstFile.content, files };
}

function authErrorToFetchError(
  code: 'unauthenticated' | 'token-expired' | 'redirect-blocked' | 'token-exchange-failed',
  message: string,
): DeployedRulesFetchError {
  if (code === 'token-expired') {
    return { code: 'token-expired', message };
  }
  if (code === 'redirect-blocked') {
    return { code: 'redirect-blocked', message };
  }
  return { code: 'unauthenticated', message };
}

async function fetchFirebaseRulesRelease(input: {
  readonly projectId: string;
  readonly releasePath: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly serviceLabel: string;
  readonly preferredFileName: string;
  readonly serviceDirective: string;
}): Promise<
  | {
      readonly ok: true;
      readonly releaseName: string;
      readonly rulesetName: string;
      readonly rulesetId: string;
      readonly source: string;
      readonly files: readonly DeployedRulesSourceFile[];
    }
  | { readonly ok: false; readonly error: DeployedRulesFetchError }
> {
  const releaseUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/${input.releasePath}`;
  const releaseRes = await readOnlyRulesGet({
    url: releaseUrl,
    token: input.token,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
  });
  if (!releaseRes.ok) {
    return releaseRes;
  }

  const releaseJson = parseJsonBody(releaseRes.text, `${input.serviceLabel} release`);
  if (!releaseJson.ok) {
    return releaseJson;
  }

  const rawRulesetName = releaseJson.value.rulesetName;
  if (typeof rawRulesetName !== 'string') {
    return {
      ok: false,
      error: {
        code: 'parse-error',
        message: `Deployed ${input.serviceLabel} release did not include a rulesetName.`,
      },
    };
  }
  const rulesetName = validateRulesetResourceName(rawRulesetName, input.projectId);
  if (rulesetName === null) {
    return {
      ok: false,
      error: {
        code: 'invalid-target',
        message: `Deployed ${input.serviceLabel} release returned an invalid or cross-project ruleset resource name.`,
      },
    };
  }

  const rulesetUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/${rulesetName}`;
  const rulesetRes = await readOnlyRulesGet({
    url: rulesetUrl,
    token: input.token,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
  });
  if (!rulesetRes.ok) {
    return rulesetRes;
  }

  const rulesetJson = parseJsonBody(rulesetRes.text, `${input.serviceLabel} ruleset`);
  if (!rulesetJson.ok) {
    return rulesetJson;
  }

  const extracted = extractRulesetFiles(rulesetJson.value, input.preferredFileName, input.serviceDirective);
  if (extracted === null) {
    return {
      ok: false,
      error: {
        code: 'parse-error',
        message: `Deployed ${input.serviceLabel} ruleset contained no rules source files.`,
      },
    };
  }

  const parts = rulesetName.split('/');
  const rulesetId = parts[parts.length - 1] ?? rulesetName;
  const expectedReleasePrefix = `projects/${input.projectId}/releases/`;
  let releaseName = input.releasePath;
  if (
    typeof releaseJson.value.name === 'string' &&
    releaseJson.value.name.startsWith(expectedReleasePrefix) &&
    !releaseJson.value.name.includes('..')
  ) {
    releaseName = releaseJson.value.name;
  }
  return {
    ok: true,
    releaseName,
    rulesetName,
    rulesetId,
    source: extracted.source,
    files: extracted.files,
  };
}

/**
 * Reads the active deployed Firestore Security Rules release via Firebase
 * Rules REST API (`projects/{project}/releases/cloud.firestore` or
 * `projects/{project}/releases/cloud.firestore/{database}`).
 */
export async function readDeployedFirestoreRules(
  input: ReadDeployedFirestoreRulesInput,
): Promise<DeployedRulesReadResult<DeployedFirestoreRulesSnapshot>> {
  const projectId = validateProjectId(input.projectId);
  if (projectId === null) {
    return {
      ok: false,
      error: { code: 'invalid-target', message: 'Invalid Firebase project ID for deployed Firestore rules lookup.' },
    };
  }
  const databaseId = validateFirestoreDatabaseId(input.databaseId ?? DEFAULT_FIRESTORE_DATABASE);
  if (databaseId === null) {
    return {
      ok: false,
      error: { code: 'invalid-target', message: 'Invalid Firestore database ID for deployed rules lookup.' },
    };
  }

  const tokenResult = await input.tokenProvider.resolveToken();
  if (!tokenResult.ok) {
    return { ok: false, error: authErrorToFetchError(tokenResult.code, tokenResult.message) };
  }

  let releasePath = `projects/${encodeURIComponent(projectId)}/releases/cloud.firestore`;
  if (databaseId !== DEFAULT_FIRESTORE_DATABASE) {
    releasePath = `${releasePath}/${encodeURIComponent(databaseId)}`;
  }

  const fetched = await fetchFirebaseRulesRelease({
    projectId,
    releasePath,
    token: tokenResult.token,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    serviceLabel: 'Firestore',
    preferredFileName: 'firestore.rules',
    serviceDirective: 'service cloud.firestore',
  });
  if (!fetched.ok) {
    return fetched;
  }

  const drift = compareTextRulesDrift(fetched.source, input.localRulesText, 'Firestore');
  return {
    ok: true,
    snapshot: {
      service: 'firestore',
      projectId,
      databaseId,
      releaseName: fetched.releaseName,
      rulesetName: fetched.rulesetName,
      rulesetId: fetched.rulesetId,
      source: fetched.source,
      files: fetched.files,
      hash: drift.deployedHash,
      fetchedAt: (input.now ?? Date.now)(),
      authSource: tokenResult.source,
      drift,
    },
  };
}

/**
 * Reads the active deployed Cloud Storage Security Rules release via Firebase
 * Rules REST API (`projects/{project}/releases/firebase.storage/{bucket}`).
 * When `bucket` is omitted, tries `{projectId}.firebasestorage.app` and falls
 * back to `{projectId}.appspot.com` on 404.
 */
export async function readDeployedStorageRules(
  input: ReadDeployedStorageRulesInput,
): Promise<DeployedRulesReadResult<DeployedStorageRulesSnapshot>> {
  const projectId = validateProjectId(input.projectId);
  if (projectId === null) {
    return {
      ok: false,
      error: { code: 'invalid-target', message: 'Invalid Firebase project ID for deployed Storage rules lookup.' },
    };
  }

  const rawBucket = input.bucket?.trim();
  const candidateBuckets: string[] = [];
  if (rawBucket !== undefined && rawBucket.length > 0) {
    const validated = validateStorageBucketId(rawBucket);
    if (validated === null) {
      return {
        ok: false,
        error: { code: 'invalid-target', message: 'Invalid Storage bucket name for deployed rules lookup.' },
      };
    }
    candidateBuckets.push(validated);
  } else {
    const modernDefault = validateStorageBucketId(`${projectId.toLowerCase()}.firebasestorage.app`);
    const legacyDefault = validateStorageBucketId(`${projectId.toLowerCase()}.appspot.com`);
    if (modernDefault !== null) candidateBuckets.push(modernDefault);
    if (legacyDefault !== null) candidateBuckets.push(legacyDefault);
  }

  if (candidateBuckets.length === 0) {
    return {
      ok: false,
      error: { code: 'invalid-target', message: 'Could not determine a valid Storage bucket for deployed rules lookup.' },
    };
  }

  const tokenResult = await input.tokenProvider.resolveToken();
  if (!tokenResult.ok) {
    return { ok: false, error: authErrorToFetchError(tokenResult.code, tokenResult.message) };
  }

  let lastError: DeployedRulesFetchError = {
    code: 'not-found',
    message: 'No active deployed Storage rules release was found.',
  };

  for (const bucket of candidateBuckets) {
    const releasePath = `projects/${encodeURIComponent(projectId)}/releases/firebase.storage/${encodeURIComponent(bucket)}`;
    const fetched = await fetchFirebaseRulesRelease({
      projectId,
      releasePath,
      token: tokenResult.token,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      serviceLabel: 'Storage',
      preferredFileName: 'storage.rules',
      serviceDirective: 'service firebase.storage',
    });
    if (fetched.ok) {
      const drift = compareTextRulesDrift(fetched.source, input.localRulesText, 'Storage');
      return {
        ok: true,
        snapshot: {
          service: 'storage',
          projectId,
          bucket,
          releaseName: fetched.releaseName,
          rulesetName: fetched.rulesetName,
          rulesetId: fetched.rulesetId,
          source: fetched.source,
          files: fetched.files,
          hash: drift.deployedHash,
          fetchedAt: (input.now ?? Date.now)(),
          authSource: tokenResult.source,
          drift,
        },
      };
    }
    lastError = fetched.error;
    if (fetched.error.code !== 'not-found') {
      return { ok: false, error: fetched.error };
    }
  }

  return { ok: false, error: lastError };
}

function rtdbInstanceFromAllowedUrl(allowedRulesUrl: string): { readonly databaseUrl: string; readonly instance: string } {
  const parsed = new URL(allowedRulesUrl);
  const host = parsed.hostname.toLowerCase();
  const instance = host.split('.')[0] ?? host;
  return { databaseUrl: `https://${host}`, instance };
}

/**
 * Reads the deployed Realtime Database rules with a single read-only GET of
 * `<databaseUrl>/.settings/rules.json` and diffs them against local rules.
 */
export async function readDeployedRtdbRules(
  input: ReadDeployedRtdbRulesInput,
): Promise<DeployedRulesReadResult<DeployedRtdbRulesSnapshot>> {
  const rulesUrl = resolveAllowedRtdbRulesUrl(input.databaseUrlOrInstance);
  if (rulesUrl === null) {
    return {
      ok: false,
      error: {
        code: 'invalid-host',
        message: 'Refused Realtime Database rules lookup: target must be an allowlisted Firebase RTDB URL or instance name.',
      },
    };
  }

  const tokenResult = await input.tokenProvider.resolveToken();
  if (!tokenResult.ok) {
    return { ok: false, error: authErrorToFetchError(tokenResult.code, tokenResult.message) };
  }

  const response = await readOnlyRulesGet({
    url: rulesUrl,
    token: tokenResult.token,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
  });
  if (!response.ok) {
    return response;
  }

  let parsed: { rules: Record<string, unknown> };
  try {
    parsed = parseRtdbRulesText(response.text, (reason) => reason);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        code: 'parse-error',
        message: `Deployed Realtime Database rules are not a valid rules document: ${reason}`,
      },
    };
  }

  const deployedHash = rulesHashOf(JSON.stringify(parsed));
  const drift = compareRtdbRulesDrift(parsed.rules, deployedHash, input.localRulesText);
  const { databaseUrl, instance } = rtdbInstanceFromAllowedUrl(rulesUrl);

  return {
    ok: true,
    snapshot: {
      service: 'rtdb',
      databaseUrl,
      instance,
      source: response.text,
      parsed,
      hash: deployedHash,
      fetchedAt: (input.now ?? Date.now)(),
      authSource: tokenResult.source,
      drift,
    },
  };
}
