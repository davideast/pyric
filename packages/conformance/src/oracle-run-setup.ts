/**
 * How the oracle harness (`run.ts`) gets its credential and web config, pins
 * RTDB operations to dedicated non-default oracle instances, and classifies
 * skip records.
 *
 * Without `--write` or `--capture`, `run.ts` stays in `'preview'` mode: zero
 * credentials read, zero network calls, zero files written.
 */
import { hasExplicitCaptureFlag } from './capture-mode-guard.ts';

export const MANUAL_CONFIG_FLAG = '--manual-config';

export type OracleRunMode = 'preview' | 'credential' | 'manual';

export function oracleRunMode(argv: readonly string[]): OracleRunMode {
  if (!hasExplicitCaptureFlag(argv)) {
    return 'preview';
  }
  if (argv.includes(MANUAL_CONFIG_FLAG)) {
    return 'manual';
  }
  return 'credential';
}

export interface OracleWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  databaseURL?: string;
}

/** The web config from `PYRIC_ORACLE_FIREBASE_CONFIG`, or undefined when unset. */
export function webConfigFromEnv(env: Record<string, string | undefined>): OracleWebConfig | undefined {
  const raw = env.PYRIC_ORACLE_FIREBASE_CONFIG;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as OracleWebConfig;
  } catch (e) {
    let detail = String(e);
    if (e instanceof Error) {
      detail = e.message;
    }
    throw new Error(`PYRIC_ORACLE_FIREBASE_CONFIG is not valid JSON: ${detail}`);
  }
}

/** A web config for another project would point the probes away from the rules the credential deploys. */
export function assertWebConfigProject(config: OracleWebConfig, credentialProjectId: string): void {
  if (config.projectId !== credentialProjectId) {
    throw new Error(
      `PYRIC_ORACLE_FIREBASE_CONFIG is for project '${config.projectId}' but the oracle credential is for '${credentialProjectId}'.`,
    );
  }
}

export function manualWebConfig(env: Record<string, string | undefined>): OracleWebConfig {
  const config = webConfigFromEnv(env);
  if (!config) throw new Error(`${MANUAL_CONFIG_FLAG} needs PYRIC_ORACLE_FIREBASE_CONFIG.`);
  return config;
}

/**
 * True only when `url` targets a dedicated non-default RTDB instance (never
 * `<project>-default-rtdb.*` and never the legacy `<project>.firebaseio.com`
 * default database).
 */
export function isDedicatedOracleRtdbUrl(url: string | undefined, projectId?: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim().replace(/\/+$/, ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const instanceName = parsed.hostname.split('.')[0] ?? '';
  if (!instanceName) return false;
  if (instanceName.endsWith('-default-rtdb')) return false;
  if (projectId && instanceName === projectId) return false;
  return true;
}

export function assertDedicatedOracleRtdbUrl(url: string | undefined, projectId?: string): string {
  if (!url || !isDedicatedOracleRtdbUrl(url, projectId)) {
    throw new Error(
      `refusing RTDB URL '${String(url ?? '')}': set PYRIC_ORACLE_RTDB_URL to a dedicated RTDB oracle instance (e.g. pyric-oracle-rtdb-2), never the project default instance.`,
    );
  }
  return url.trim().replace(/\/+$/, '');
}

export interface RtdbInstanceSummary {
  name: string;
  databaseUrl?: string;
  state?: string;
  type?: string;
}

export function selectDedicatedRtdbInstanceUrl(
  instances: readonly RtdbInstanceSummary[],
  projectId: string,
): string | null {
  const dedicated = instances.filter(
    (item) => item.type !== 'DEFAULT_DATABASE' && isDedicatedOracleRtdbUrl(item.databaseUrl, projectId),
  );
  if (dedicated.length === 0) return null;
  const active = dedicated.filter((item) => item.state === 'ACTIVE');
  let pool = dedicated;
  if (active.length > 0) {
    pool = active;
  }
  const namedOracle = pool.find((item) => (item.databaseUrl ?? '').includes('oracle'));
  const chosen = namedOracle ?? pool[0];
  if (!chosen?.databaseUrl) return null;
  return assertDedicatedOracleRtdbUrl(chosen.databaseUrl, projectId);
}

export async function resolveOracleRtdbUrl(options: {
  projectId: string;
  env: Record<string, string | undefined>;
  webConfigDatabaseUrl: string | undefined;
  discoverDedicated: () => Promise<string | null>;
}): Promise<string | undefined> {
  const explicit = options.env.PYRIC_ORACLE_RTDB_URL;
  if (explicit !== undefined && explicit.trim() !== '') {
    return assertDedicatedOracleRtdbUrl(explicit, options.projectId);
  }
  if (options.webConfigDatabaseUrl && isDedicatedOracleRtdbUrl(options.webConfigDatabaseUrl, options.projectId)) {
    return assertDedicatedOracleRtdbUrl(options.webConfigDatabaseUrl, options.projectId);
  }
  const discovered = await options.discoverDedicated();
  if (discovered) {
    return assertDedicatedOracleRtdbUrl(discovered, options.projectId);
  }
  return undefined;
}

/**
 * Why a probe result is a skip record rather than an observation, or null.
 * The harness does not write a skip record over an observation; it reports
 * the probe and fails the run.
 */
export function skipReason(behavior: unknown): string | null {
  const isRecord = typeof behavior === 'object' && behavior !== null;
  if (!isRecord) return null;
  const { skipped, reason } = behavior as { skipped?: unknown; reason?: unknown };
  if (skipped !== true) return null;
  return typeof reason === 'string' ? reason : 'no reason given';
}
