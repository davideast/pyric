#!/usr/bin/env bun
/**
 * Modular one-file-per-probe SDK oracle runner (`packages/conformance/probes/<surface>/<name>.ts`).
 *
 * Discovers probe files declaring `rig: 'sdk-probes'` (or another target rig
 * passed by a sibling entrypoint such as `admin-auth-probes.ts`), prints a
 * deterministic inert preview without `--write` / `--capture`, validates
 * required live-project credentials and dedicated endpoints upfront when
 * `--write` is passed, and writes captured observations to
 * `packages/conformance/observations/<surface>/<name>.json`.
 *
 * Usage:
 *   bun run packages/conformance/src/sdk-probes.ts                            # inert preview
 *   bun run packages/conformance/src/sdk-probes.ts --write --probe <name>     # live capture
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listProbeFiles } from '../probes/load.ts';
import type { Probe, ProbeSdkRequirement } from '../rigs/types.ts';
import {
  formatInertPreviewFooter,
  hasExplicitCaptureFlag,
  requireCaptureMode,
  stripCaptureFlags,
} from './capture-mode-guard.ts';
import {
  resolveProbeObservationLinkage,
  shouldIncludeProbeInUnfilteredRun,
} from './observation-linkage.ts';
import {
  loadOracleServiceAccount,
  oracleCredentialConfigured,
  type OracleEnv,
} from './oracle-credential.ts';
import {
  assertWebConfigProject,
  isDedicatedOracleRtdbUrl,
  webConfigFromEnv,
} from './oracle-run-setup.ts';
import { isTransientAuthCaptureError } from './oracle-run-auth-session.ts';
import {
  resolvedAdminVersion,
  resolvedAndroidBomVersion,
  resolvedFirebaseVersion,
} from './package-version.ts';
import { readProbeSelectors } from './probe-cli-args.ts';
import { readDeclaredProbeRig } from './staged-captures.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBES_ROOT = join(HERE, '..', 'probes');
const DEFAULT_OBS_ROOT = join(HERE, '..', 'observations');

export interface LoadedModularProbe {
  id: string;
  surfaceDir: string;
  probe: Probe;
}

export async function loadModularProbes(rigId: string): Promise<LoadedModularProbe[]> {
  const candidates = listProbeFiles().filter(
    (entry) => readDeclaredProbeRig(entry.surfaceDir, entry.name) === rigId,
  );
  const loaded: LoadedModularProbe[] = [];
  for (const entry of candidates) {
    const fullPath = join(PROBES_ROOT, entry.surfaceDir, `${entry.name}.ts`);
    const mod = (await import(pathToFileURL(fullPath).href)) as { probe?: Probe };
    if (!mod.probe || typeof mod.probe.observe !== 'function') {
      throw new Error(
        `probes/${entry.surfaceDir}/${entry.name}.ts: does not export a 'probe' record with an observe() method`,
      );
    }
    loaded.push({
      id: entry.name,
      surfaceDir: entry.surfaceDir,
      probe: mod.probe,
    });
  }
  return loaded.sort((a, b) => a.id.localeCompare(b.id));
}

export interface SelectModularProbesOptions {
  observationsRoot?: string;
  includeUncapturedStaged?: boolean;
}

export function selectModularProbes(
  loaded: readonly LoadedModularProbe[],
  args: readonly string[],
  rigId: string,
  options: SelectModularProbesOptions = {},
): LoadedModularProbe[] {
  const cleaned = stripCaptureFlags(args);
  const selectors = readProbeSelectors(cleaned);
  if (selectors.length === 0) {
    if (options.includeUncapturedStaged === false) {
      const obsRoot = options.observationsRoot ?? DEFAULT_OBS_ROOT;
      return loaded.filter((item) =>
        shouldIncludeProbeInUnfilteredRun(
          item.probe,
          join(obsRoot, item.surfaceDir, `${item.id}.json`),
        ),
      );
    }
    return [...loaded];
  }
  const byId = new Map(loaded.map((item) => [item.id, item]));
  const selected: LoadedModularProbe[] = [];
  for (const selector of selectors) {
    const found = byId.get(selector);
    if (!found) {
      throw new Error(`unknown ${rigId} probe: ${selector}`);
    }
    if (!selected.some((existing) => existing.id === found.id)) {
      selected.push(found);
    }
  }
  return selected;
}

const REQUIREMENT_HINTS: Readonly<Record<ProbeSdkRequirement, string>> = {
  'web-config':
    'IAM role roles/firebase.viewer on firebase.googleapis.com (or optional PYRIC_ORACLE_FIREBASE_CONFIG override)',
  'dedicated-rtdb':
    'PYRIC_ORACLE_RTDB_URL (dedicated non-default RTDB instance URL) + IAM role roles/firebasedatabase.admin on firebasedatabase.googleapis.com',
  'firestore-rules':
    'IAM roles roles/firebaserules.admin (firebaserules.googleapis.com) and roles/datastore.user (firestore.googleapis.com)',
  'admin-auth':
    'IAM role roles/firebaseauth.admin on identitytoolkit.googleapis.com',
  'admin-firestore':
    'IAM role roles/datastore.user on firestore.googleapis.com',
};

export function validateModularProbeRequirements(
  probes: readonly LoadedModularProbe[],
  env: OracleEnv,
): void {
  const needed = new Set<ProbeSdkRequirement>();
  for (const item of probes) {
    for (const req of item.probe.requires ?? []) {
      needed.add(req);
    }
  }

  if (!oracleCredentialConfigured(env)) {
    const roleNotes = [...needed].map((req) => REQUIREMENT_HINTS[req]).join('; ');
    let suffix = '';
    if (roleNotes) {
      suffix = ` Required capabilities: ${roleNotes}.`;
    }
    throw new Error(
      `Missing oracle credential: set PYRIC_ORACLE_PROJECT_ID (with Workload Identity Federation / Application Default Credentials) or PYRIC_ORACLE_SA_PATH.${suffix}`,
    );
  }

  if (probes.length === 0) return;

  const webConfig = webConfigFromEnv(env as Record<string, string | undefined>);
  const envProjectId = env.PYRIC_ORACLE_PROJECT_ID?.trim();
  if (webConfig && envProjectId) {
    assertWebConfigProject(webConfig, envProjectId);
  }

  if (needed.has('dedicated-rtdb')) {
    let candidateRtdb = webConfig?.databaseURL;
    const envRtdbUrl = env.PYRIC_ORACLE_RTDB_URL?.trim();
    if (envRtdbUrl) {
      candidateRtdb = envRtdbUrl;
    }
    let projectId = webConfig?.projectId;
    if (envProjectId) {
      projectId = envProjectId;
    }
    if (!isDedicatedOracleRtdbUrl(candidateRtdb, projectId)) {
      throw new Error(
        `Missing dedicated RTDB endpoint: set ${REQUIREMENT_HINTS['dedicated-rtdb']} (refusing missing or default RTDB instance '${String(candidateRtdb ?? '')}').`,
      );
    }
  }
}

export function printModularProbePreview(options: {
  rig: string;
  scriptPath: string;
  probes: readonly LoadedModularProbe[];
  log?: (line: string) => void;
}): void {
  const log = options.log ?? ((line: string) => console.log(line));
  log(`[${options.rig}] INERT preview (no --write flag): zero credential reads, zero network calls.`);
  log(`  Matching modular probe(s): ${options.probes.length}`);
  for (const item of options.probes) {
    const reqs = (item.probe.requires ?? []).join(', ') || 'oracle-credential';
    let stagedTag = '';
    if (item.probe.pendingRowLink) {
      stagedTag = ' [pendingRowLink]';
    }
    log(
      `    - ${item.id} (observations/${item.surfaceDir}/${item.id}.json, requires: ${reqs})${stagedTag}`,
    );
  }
  log(`  ${formatInertPreviewFooter(options.scriptPath, '--probe <probe-name>')}`);
}

export interface ModularProbeRigConfig {
  rig: string;
  scriptPath: string;
  versionField: 'fbSdkVersion' | 'adminSdkVersion' | 'androidBomVersion';
}

export const SDK_PROBES_RIG_CONFIG: ModularProbeRigConfig = {
  rig: 'sdk-probes',
  scriptPath: 'packages/conformance/src/sdk-probes.ts',
  versionField: 'fbSdkVersion',
};

const DEFAULT_MODULAR_PROBE_BACKOFF_MS: readonly number[] = [15_000, 30_000, 60_000];

function defaultModularProbeSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function observeModularProbeWithRetry(
  probeId: string,
  rigName: string,
  observe: () => Promise<Record<string, unknown>>,
  backoffMs: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<Record<string, unknown>> {
  let attemptIndex = 0;
  for (;;) {
    try {
      return await observe();
    } catch (err) {
      if (!isTransientAuthCaptureError(err) || attemptIndex >= backoffMs.length) {
        throw err;
      }
      const waitMs = backoffMs[attemptIndex];
      attemptIndex += 1;
      console.log(
        `[${rigName}] ${probeId} hit auth/too-many-requests or transient unavailable; waiting ${waitMs}ms before retry ${attemptIndex}/${backoffMs.length}`,
      );
      if (waitMs !== undefined) {
        await sleep(waitMs);
      }
    }
  }
}

export async function executeModularProbes(options: {
  config: ModularProbeRigConfig;
  sdkVersion: string;
  projectId: string;
  observationsRoot?: string;
  probes: readonly LoadedModularProbe[];
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const outRoot = options.observationsRoot ?? DEFAULT_OBS_ROOT;
  let backoffMs = DEFAULT_MODULAR_PROBE_BACKOFF_MS;
  if (options.backoffMs !== undefined) {
    backoffMs = options.backoffMs;
  }
  let sleep = defaultModularProbeSleep;
  if (options.sleep !== undefined) {
    sleep = options.sleep;
  }
  for (const item of options.probes) {
    const surfaceDir = join(outRoot, item.surfaceDir);
    mkdirSync(surfaceDir, { recursive: true });
    const outPath = join(surfaceDir, `${item.id}.json`);
    const linkage = resolveProbeObservationLinkage(item.probe, outPath);

    const behavior = await observeModularProbeWithRetry(
      item.id,
      options.config.rig,
      () => item.probe.observe(),
      backoffMs,
      sleep,
    );
    const envelope: Record<string, unknown> = {
      name: item.id,
      matrixRow: linkage.matrixRow,
      rowIds: linkage.rowIds,
      description: item.probe.description,
      observedAt: new Date().toISOString(),
      [options.config.versionField]: options.sdkVersion,
      projectId: options.projectId,
      behavior,
    };
    if (item.surfaceDir.endsWith('-admin') && envelope.adminSdkVersion === undefined) {
      envelope.adminSdkVersion = resolvedAdminVersion();
    }
    writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`);
    console.log(`[${options.config.rig}] wrote observations/${item.surfaceDir}/${item.id}.json`);
  }
}

export async function runModularProbesCli(options: {
  config: ModularProbeRigConfig;
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  observationsRoot?: string;
  exitOnCli?: boolean;
}): Promise<void> {
  const env = options.env ?? process.env;
  const allProbes = await loadModularProbes(options.config.rig);
  const previewProbes = selectModularProbes(allProbes, options.argv, options.config.rig, {
    observationsRoot: options.observationsRoot,
    includeUncapturedStaged: true,
  });

  if (options.exitOnCli === false && !hasExplicitCaptureFlag(options.argv)) {
    printModularProbePreview({
      rig: options.config.rig,
      scriptPath: options.config.scriptPath,
      probes: previewProbes,
    });
    return;
  }

  const selected = selectModularProbes(allProbes, options.argv, options.config.rig, {
    observationsRoot: options.observationsRoot,
    includeUncapturedStaged: false,
  });

  requireCaptureMode({
    label: options.config.rig,
    scriptPath: options.config.scriptPath,
    argv: options.argv,
    preview: () =>
      printModularProbePreview({
        rig: options.config.rig,
        scriptPath: options.config.scriptPath,
        probes: previewProbes,
      }),
    missingCredentials: () => {
      try {
        validateModularProbeRequirements(selected, env);
        return null;
      } catch (err) {
        if (err instanceof Error) return err.message;
        return String(err);
      }
    },
  });

  if (selected.length === 0) {
    console.log(`[${options.config.rig}] 0 matching probes to capture.`);
    return;
  }

  validateModularProbeRequirements(selected, env);
  const sa = await loadOracleServiceAccount(env);
  let sdkVersion: string;
  if (options.config.versionField === 'adminSdkVersion') {
    sdkVersion = resolvedAdminVersion();
  } else if (options.config.versionField === 'androidBomVersion') {
    sdkVersion = resolvedAndroidBomVersion();
  } else {
    sdkVersion = resolvedFirebaseVersion();
  }

  await executeModularProbes({
    config: options.config,
    sdkVersion,
    projectId: sa.project_id,
    observationsRoot: options.observationsRoot,
    probes: selected,
  });
}

if (import.meta.main) {
  await runModularProbesCli({
    config: SDK_PROBES_RIG_CONFIG,
    argv: process.argv.slice(2),
  });
}
