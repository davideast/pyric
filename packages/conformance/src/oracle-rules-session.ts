/**
 * The oracle harness's security-rules deployments, paired with their
 * restoration.
 *
 * The harness probes run against a production project, so they need a
 * `pyric_oracle/*` namespace that an authenticated client may read and write.
 * `OracleRulesSession.deploy` merges that block into the release's current
 * source and activates the merged ruleset. Before it writes anything it records
 * which ruleset the release points to. `restoreAll` points every touched
 * release back at its recorded ruleset and reads each release back to confirm
 * it, or deletes a release the session created. A restore that cannot be
 * confirmed throws an error that names the release and the ruleset to restore
 * by hand, so the process exits non-zero instead of leaving the project's rules
 * modified without notice.
 *
 * RTDB rules live on the database itself, not in a Rules API release.
 * `deployRtdb` records the database's rules source verbatim before it writes,
 * and `restoreAll` writes that source back and reads it back to confirm it.
 *
 * Every rules call waits out a 429 with back-off (`fetchWithRateLimitRetry`),
 * because the rules endpoints throttle a project for minutes after a burst,
 * and a restore that threw on a 429 would leave the oracle block in place.
 */
import { fetchWithRateLimitRetry, rateLimitDeps, type RateLimitDeps } from './rtdb-rules-rate-limit.ts';
import { RequestBudget } from './storage-stdlib-real-budget.ts';
import { restoreRulesRelease } from './storage-stdlib-real-rules.ts';

const RULES_API = 'https://firebaserules.googleapis.com/v1';

export type OracleRulesOutcome = 'fresh' | 'merged' | 'already-configured';

/** One RTDB instance's rules endpoint and the token source it accepts. */
export interface OracleRtdbRulesTarget {
  /** The database URL, such as `https://<instance>.firebaseio.com`. */
  databaseUrl: string;
  /**
   * Returns a token with the `firebase.database` and `userinfo.email` scopes,
   * which the rules endpoint requires. Called again when the restore starts.
   */
  accessToken: () => Promise<string>;
}

/** The RTDB target for one database. */
export function rtdbOracleTarget(databaseUrl: string, accessToken: () => Promise<string>): OracleRtdbRulesTarget {
  return { databaseUrl, accessToken };
}

const ORACLE_RTDB_NAMESPACE_KEY = 'pyric_oracle';

// Grants the harness read and write under `/pyric_oracle/*`. The `.indexOn`
// at `$run/$probe/list` lets the query probes (orderByChild, equalTo) run:
// RTDB rejects queries on unindexed fields. The indexed fields are the union of
// what the modular-SDK query probes use.
const ORACLE_RTDB_BLOCK = {
  '.read': 'auth != null',
  '.write': 'auth != null',
  $run: {
    $probe: {
      list: {
        '.indexOn': ['pos', 'group'],
      },
    },
  },
};

type RtdbRulesMerge = { outcome: 'already-configured' } | { outcome: 'fresh' | 'merged'; next: string };

/**
 * Merge the oracle block into an RTDB rules source. Every other top-level key
 * is kept. A block whose shape has drifted from `ORACLE_RTDB_BLOCK` is
 * replaced, so a new indexed field is deployed on the next run.
 */
export function mergeOracleRtdbRules(source: string): RtdbRulesMerge {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`parse RTDB rules failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const current = (parsed ?? {}) as { rules?: Record<string, unknown> };
  const currentRules = current.rules ?? {};
  const existing = currentRules[ORACLE_RTDB_NAMESPACE_KEY];
  const blockMatches = JSON.stringify(existing) === JSON.stringify(ORACLE_RTDB_BLOCK);
  if (existing !== undefined && blockMatches) return { outcome: 'already-configured' };
  const isEmpty = Object.keys(currentRules).length === 0;
  const rules = isEmpty
    ? { '.read': false, '.write': false, [ORACLE_RTDB_NAMESPACE_KEY]: ORACLE_RTDB_BLOCK }
    : { ...currentRules, [ORACLE_RTDB_NAMESPACE_KEY]: ORACLE_RTDB_BLOCK };
  return { outcome: isEmpty ? 'fresh' : 'merged', next: JSON.stringify({ rules }) };
}

/** One service's release, the block merged into it, and the source for a release that does not exist yet. */
export interface OracleRulesTarget {
  /** Service name used in log lines and error messages. */
  service: 'Firestore' | 'Storage';
  /** The release name after `projects/{project}/releases/`. */
  release: string;
  /** The file name of the ruleset source created for this release. */
  rulesFileName: string;
  /** Text whose presence in the current source means the block is already merged. */
  marker: string;
  /** The complete source deployed when the release does not exist. */
  freshRules: string;
  /** The block that the merge is inserted after. */
  insertAfter: RegExp;
  /** Names `insertAfter` in the error raised when the current source lacks it. */
  insertAfterDescription: string;
  /** The text inserted immediately after the `insertAfter` match. */
  block: string;
}

const FIRESTORE_BLOCK = `      // @pyric/oracle - read/write under pyric_oracle/* for the conformance oracle harness
      match /pyric_oracle/{run}/{anything=**} {
        allow read, write: if request.auth != null;
      }`;

const STORAGE_MARKER = '@pyric/oracle/storage';

/** The Firestore target: the `pyric_oracle` match inserted at the top of the documents block. */
export function firestoreOracleTarget(): OracleRulesTarget {
  return {
    service: 'Firestore',
    release: 'cloud.firestore',
    rulesFileName: 'firestore.rules',
    marker: '@pyric/oracle',
    freshRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${FIRESTORE_BLOCK}
  }
}
`,
    insertAfter: /(match\s+\/databases\/\{database\}\/documents\s*\{)/,
    insertAfterDescription: '`match /databases/{database}/documents`',
    block: `\n${FIRESTORE_BLOCK}\n`,
  };
}

/** The Storage target for one bucket: the `pyric_oracle` match inserted at the top of the object block. */
export function storageOracleTarget(bucketId: string): OracleRulesTarget {
  return {
    service: 'Storage',
    release: `firebase.storage/${bucketId}`,
    rulesFileName: 'storage.rules',
    marker: STORAGE_MARKER,
    freshRules: `rules_version = '2';
service firebase.storage {
  // ${STORAGE_MARKER} - read/write under pyric_oracle/* for the conformance oracle harness
  match /b/{bucket}/o {
    match /pyric_oracle/{run}/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}
`,
    insertAfter: /(match\s+\/b\/\{bucket\}\/o\s*\{)/,
    insertAfterDescription: '`match /b/{bucket}/o`',
    block: `\n    // ${STORAGE_MARKER} - read/write under pyric_oracle/* for the conformance oracle harness\n    match /pyric_oracle/{run}/{allPaths=**} {\n      allow read, write: if request.auth != null;\n    }\n`,
  };
}

export interface OracleRulesSessionOptions {
  projectId: string;
  /**
   * Returns an OAuth access token with the `firebase` scope. It is called when
   * a deployment starts and again when the restore starts, because a run can
   * outlast the one-hour life of a single token.
   */
  accessToken: () => Promise<string>;
  /** The HTTP client; tests supply an in-memory Rules API. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Waits out a 429's back-off; tests supply one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

interface ReleaseBaseline {
  kind: 'release';
  service: OracleRulesTarget['service'];
  releaseName: string;
  releaseUrl: string;
  /** The ruleset the release pointed to before the session wrote, or `null` when the release did not exist. */
  rulesetName: string | null;
}

interface RtdbBaseline {
  kind: 'rtdb';
  target: OracleRtdbRulesTarget;
  /** The rules source read before the session wrote, byte for byte. */
  source: string;
}

type Baseline = ReleaseBaseline | RtdbBaseline;

const RESTORE_ATTEMPTS = 3;

export class OracleRulesSession {
  private readonly projectId: string;
  private readonly accessToken: () => Promise<string>;
  private readonly rateLimit: RateLimitDeps;
  private headers: { auth: Record<string, string>; json: Record<string, string> } = { auth: {}, json: {} };
  private baselines: Baseline[] = [];

  constructor(options: OracleRulesSessionOptions) {
    this.projectId = options.projectId;
    this.accessToken = options.accessToken;
    this.rateLimit = rateLimitDeps({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
  }

  /** One rules call, sent again after each 429 until the back-off cap. */
  private send(url: string, init: RequestInit | undefined, label: string): Promise<Response> {
    return fetchWithRateLimitRetry(url, init, label, { deps: this.rateLimit, logPrefix: '[oracle:rules]' });
  }

  private async refreshHeaders(): Promise<void> {
    const auth = { Authorization: `Bearer ${await this.accessToken()}` };
    this.headers = { auth, json: { ...auth, 'Content-Type': 'application/json' } };
  }

  private async request<T>(url: string, init: RequestInit, label: string): Promise<T> {
    const response = await this.send(url, init, label);
    const text = await response.text();
    if (!response.ok) throw new Error(`${label} failed: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }

  /**
   * Merge the target's oracle block into its release and activate the result.
   * The release's current ruleset is recorded before any write, so `restoreAll`
   * undoes the deployment even when this call fails partway.
   */
  async deploy(target: OracleRulesTarget): Promise<OracleRulesOutcome> {
    const project = encodeURIComponent(this.projectId);
    const releaseName = `projects/${this.projectId}/releases/${target.release}`;
    const releaseUrl = `${RULES_API}/projects/${project}/releases/${target.release}`;
    const service = target.service;

    await this.refreshHeaders();
    const releaseResponse = await this.send(releaseUrl, { headers: this.headers.auth }, `read ${service} release`);
    let current: string | null = null;
    let rulesetName: string | null = null;
    if (releaseResponse.status !== 404) {
      const text = await releaseResponse.text();
      if (!releaseResponse.ok) throw new Error(`read ${service} release failed: ${releaseResponse.status} ${text}`);
      rulesetName = (JSON.parse(text) as { rulesetName: string }).rulesetName;
      const ruleset = await this.request<{ source: { files: { name: string; content: string }[] } }>(
        `${RULES_API}/${rulesetName}`,
        { headers: this.headers.auth },
        `fetch ${service} ruleset`,
      );
      const file = ruleset.source.files.find((f) => f.name.endsWith('.rules')) ?? ruleset.source.files[0];
      if (!file) throw new Error(`existing ${service} ruleset has no source files`);
      current = file.content;
    }

    let next: string;
    let outcome: OracleRulesOutcome;
    if (current === null) {
      next = target.freshRules;
      outcome = 'fresh';
    } else if (current.includes(target.marker)) {
      return 'already-configured';
    } else {
      const match = target.insertAfter.exec(current);
      if (!match) {
        throw new Error(`cannot locate ${target.insertAfterDescription} block in current ${service} rules`);
      }
      const insertAt = match.index + match[0].length;
      next = current.slice(0, insertAt) + target.block + current.slice(insertAt);
      outcome = 'merged';
    }

    // Recorded before the first write: a deployment that fails partway is still restored.
    this.baselines.push({ kind: 'release', service, releaseName, releaseUrl, rulesetName });

    const created = await this.request<{ name: string }>(
      `${RULES_API}/projects/${project}/rulesets`,
      {
        method: 'POST',
        headers: this.headers.json,
        body: JSON.stringify({ source: { files: [{ name: target.rulesFileName, content: next }] } }),
      },
      `create ${service} oracle ruleset`,
    );

    const patch = await this.send(releaseUrl, {
      method: 'PATCH',
      headers: this.headers.json,
      body: JSON.stringify({ release: { name: releaseName, rulesetName: created.name } }),
    }, `activate ${service} oracle ruleset`);
    if (patch.ok) return outcome;
    const patchText = await patch.text();
    if (patch.status !== 404) {
      throw new Error(`activate ${service} oracle ruleset failed: ${patch.status} ${patchText}`);
    }
    // A bucket with no release yet: create it.
    await this.request(
      `${RULES_API}/projects/${project}/releases`,
      {
        method: 'POST',
        headers: this.headers.json,
        body: JSON.stringify({ name: releaseName, rulesetName: created.name }),
      },
      `create ${service} oracle release`,
    );
    return outcome;
  }

  /**
   * Merge the oracle block into an RTDB instance's rules. The rules source is
   * recorded before the write, so `restoreAll` puts it back even when the
   * write fails partway.
   */
  async deployRtdb(target: OracleRtdbRulesTarget): Promise<OracleRulesOutcome> {
    const token = await target.accessToken();
    const source = await this.readRtdbRules(target.databaseUrl, token);
    const merge = mergeOracleRtdbRules(source);
    if (merge.outcome === 'already-configured') return merge.outcome;
    this.baselines.push({ kind: 'rtdb', target, source });
    await this.writeRtdbRules(target.databaseUrl, token, merge.next, 'deploy RTDB oracle rules');
    return merge.outcome;
  }

  private async readRtdbRules(databaseUrl: string, token: string): Promise<string> {
    const response = await this.send(rtdbRulesUrl(databaseUrl, token), undefined, 'read RTDB rules');
    const text = await response.text();
    if (!response.ok) throw new Error(`read RTDB rules failed: ${response.status} ${text}`);
    return text;
  }

  private async writeRtdbRules(databaseUrl: string, token: string, source: string, label: string): Promise<void> {
    // RTDB takes a full replacement; `print=silent` drops the echoed body.
    const response = await this.send(`${rtdbRulesUrl(databaseUrl, token)}&print=silent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: source,
    }, label);
    if (!response.ok) throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }

  /**
   * Point every release this session changed back at the ruleset recorded for
   * it and read each one back. Every release is attempted even when an earlier
   * one fails. Throws one error naming each release that could not be
   * confirmed.
   */
  async restoreAll(): Promise<void> {
    const pending = this.baselines;
    this.baselines = [];
    if (pending.length === 0) return;
    const failures: string[] = [];
    let tokenError: unknown;
    try {
      await this.refreshHeaders();
    } catch (error) {
      tokenError = error;
    }
    for (const baseline of pending) {
      try {
        if (baseline.kind === 'rtdb') {
          await this.restoreRtdb(baseline);
          continue;
        }
        if (tokenError) {
          throw new Error(
            `could not obtain an access token: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
          );
        }
        await this.restore(baseline);
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
        const detail = (error instanceof Error ? error.message : String(error)) + cause;
        failures.push(
          `${baselineLabel(baseline)}: ${detail}. ` +
          `The live rules may still contain the oracle block. Restore by hand: ${restoreByHand(baseline)}.`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(`ORACLE RULES RESTORE FAILED. ${failures.join(' ')}`);
    }
  }

  private async restoreRtdb(baseline: RtdbBaseline): Promise<void> {
    const { databaseUrl } = baseline.target;
    const token = await baseline.target.accessToken();
    for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
      const isLastAttempt = attempt === RESTORE_ATTEMPTS;
      try {
        await this.writeRtdbRules(databaseUrl, token, baseline.source, 'restore RTDB rules');
        const readBack = await this.readRtdbRules(databaseUrl, token);
        if (readBack === baseline.source) return;
        if (isLastAttempt) throw new Error('the rules read back after restoring do not match the rules recorded before the run');
      } catch (error) {
        if (isLastAttempt) throw error;
      }
    }
  }

  private async restore(baseline: ReleaseBaseline): Promise<void> {
    if (baseline.rulesetName === null) {
      await this.request(baseline.releaseUrl, { method: 'DELETE', headers: this.headers.auth }, 'delete oracle release');
      const after = await this.send(baseline.releaseUrl, { headers: this.headers.auth }, 'read deleted oracle release');
      if (after.status !== 404) {
        throw new Error(`the release created for the run still exists (status ${after.status})`);
      }
      return;
    }
    const restored = await restoreRulesRelease(
      this.headers,
      new RequestBudget({ storage: 0, firestoreWrite: 0, rules: 2 * RESTORE_ATTEMPTS, iam: 0 }),
      baseline.releaseUrl,
      baseline.releaseName,
      baseline.rulesetName,
      (url, init, label) => this.request(url, init, label),
      RESTORE_ATTEMPTS,
    );
    if (!restored) {
      throw new Error(`the release read back after restoring does not point to ${baseline.rulesetName}`);
    }
  }
}

function rtdbRulesUrl(databaseUrl: string, token: string): string {
  return `${databaseUrl}/.settings/rules.json?access_token=${encodeURIComponent(token)}`;
}

function baselineLabel(baseline: Baseline): string {
  if (baseline.kind === 'rtdb') return `RTDB (${baseline.target.databaseUrl})`;
  return `${baseline.service} (${baseline.releaseName})`;
}

function restoreByHand(baseline: Baseline): string {
  if (baseline.kind === 'rtdb') {
    return `PUT ${baseline.target.databaseUrl}/.settings/rules.json with the rules recorded before the run:\n${baseline.source}\n`;
  }
  if (baseline.rulesetName) return `PATCH ${baseline.releaseName} with rulesetName ${baseline.rulesetName}`;
  return `DELETE ${baseline.releaseName}`;
}

/**
 * Run `body` and restore the session's releases afterwards, whether or not the
 * body threw. A restore failure always reaches the caller; when the body also
 * failed, both errors are carried together.
 */
export async function runWithOracleRulesRestored<T>(
  session: OracleRulesSession,
  body: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (bodyError) {
    try {
      await session.restoreAll();
    } catch (restoreError) {
      const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new AggregateError([bodyError, restoreError], `${message} The run itself also failed.`);
    }
    throw bodyError;
  }
  await session.restoreAll();
  return result;
}
