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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { readObservationLinkage } from './observation-linkage.ts';
import {
  loadOracleServiceAccount,
  oracleCredentialConfigured,
  type OracleEnv,
} from './oracle-credential.ts';
import { isDedicatedOracleRtdbUrl, webConfigFromEnv } from './oracle-run-setup.ts';
import { resolvedAdminVersion, resolvedFirebaseVersion } from './package-version.ts';
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

export function selectModularProbes(
  loaded: readonly LoadedModularProbe[],
  args: readonly string[],
  rigId: string,
): LoadedModularProbe[] {
  const cleaned = stripCaptureFlags(args);
  const selectors = readProbeSelectors(cleaned);
  if (selectors.length === 0) {
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
    'PYRIC_ORACLE_FIREBASE_CONFIG (Web SDK config JSON secret for digame-mas)',
  'dedicated-rtdb':
    'PYRIC_ORACLE_RTDB_URL (dedicated non-default RTDB instance URL, e.g. https://pyric-oracle-rtdb-2.firebaseio.com) + IAM role roles/firebasedatabase.admin on firebasedatabase.googleapis.com',
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
  if (needed.has('web-config') && !webConfig) {
    throw new Error(
      `Missing required secret PYRIC_ORACLE_FIREBASE_CONFIG: ${REQUIREMENT_HINTS['web-config']}.`,
    );
  }

  if (needed.has('dedicated-rtdb')) {
    const candidateRtdb = env.PYRIC_ORACLE_RTDB_URL ?? webConfig?.databaseURL;
    const projectId = env.PYRIC_ORACLE_PROJECT_ID ?? webConfig?.projectId;
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
  versionField: 'fbSdkVersion' | 'adminSdkVersion';
}

export const SDK_PROBES_RIG_CONFIG: ModularProbeRigConfig = {
  rig: 'sdk-probes',
  scriptPath: 'packages/conformance/src/sdk-probes.ts',
  versionField: 'fbSdkVersion',
};

export async function executeModularProbes(options: {
  config: ModularProbeRigConfig;
  sdkVersion: string;
  projectId: string;
  observationsRoot?: string;
  probes: readonly LoadedModularProbe[];
}): Promise<void> {
  const outRoot = options.observationsRoot ?? DEFAULT_OBS_ROOT;
  for (const item of options.probes) {
    const surfaceDir = join(outRoot, item.surfaceDir);
    mkdirSync(surfaceDir, { recursive: true });
    const outPath = join(surfaceDir, `${item.id}.json`);
    let existing = { matrixRow: '', rowIds: [] as string[] };
    if (existsSync(outPath)) {
      existing = readObservationLinkage(outPath);
    }
    const matrixRow = item.probe.matrixRow || existing.matrixRow;
    let rowIds = existing.rowIds;
    if (item.probe.rowIds.length > 0) {
      rowIds = item.probe.rowIds;
    }

    const behavior = await item.probe.observe();
    const envelope: Record<string, unknown> = {
      name: item.id,
      matrixRow,
      rowIds,
      description: item.probe.description,
      observedAt: new Date().toISOString(),
      [options.config.versionField]: options.sdkVersion,
      projectId: options.projectId,
      behavior,
    };
    writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`);
    console.log(`[${options.config.rig}] wrote observations/${item.surfaceDir}/${item.id}.json`);
  }
}

export async function runModularProbesCli(options: {
  config: ModularProbeRigConfig;
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  exitOnCli?: boolean;
}): Promise<void> {
  const env = options.env ?? process.env;
  const allProbes = await loadModularProbes(options.config.rig);
  const selected = selectModularProbes(allProbes, options.argv, options.config.rig);

  if (options.exitOnCli === false && !hasExplicitCaptureFlag(options.argv)) {
    printModularProbePreview({
      rig: options.config.rig,
      scriptPath: options.config.scriptPath,
      probes: selected,
    });
    return;
  }

  requireCaptureMode({
    label: options.config.rig,
    scriptPath: options.config.scriptPath,
    argv: options.argv,
    preview: () =>
      printModularProbePreview({
        rig: options.config.rig,
        scriptPath: options.config.scriptPath,
        probes: selected,
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
  } else {
    sdkVersion = resolvedFirebaseVersion();
  }

  await executeModularProbes({
    config: options.config,
    sdkVersion,
    projectId: sa.project_id,
    probes: selected,
  });
}

if (import.meta.main) {
  await runModularProbesCli({
    config: SDK_PROBES_RIG_CONFIG,
    argv: process.argv.slice(2),
  });
}
