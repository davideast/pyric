/**
 * How the oracle harness (`run.ts`) gets its credential and web config, and
 * which probe results it may write.
 *
 * The default mode loads the oracle credential (src/oracle-credential.ts),
 * opens the rules session, and takes the web config from
 * `PYRIC_ORACLE_FIREBASE_CONFIG` when set, or from the Management API. A
 * client-only run with no service account happens only under the explicit
 * `--manual-config` flag: it deploys no rules, and the probes that need the
 * admin credential skip.
 */

export const MANUAL_CONFIG_FLAG = '--manual-config';

export type OracleRunMode = 'credential' | 'manual';

export function oracleRunMode(argv: readonly string[]): OracleRunMode {
  return argv.includes(MANUAL_CONFIG_FLAG) ? 'manual' : 'credential';
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
    throw new Error(`PYRIC_ORACLE_FIREBASE_CONFIG is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
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
