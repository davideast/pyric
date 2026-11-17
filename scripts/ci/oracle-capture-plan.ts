/**
 * Capture target planning, branch-context guard, WIF identity tier routing, and
 * GCP IAM/secret diagnostic formatter for `.github/workflows/oracle-capture.yml`.
 */
import { appendFileSync } from 'node:fs';
import { loadRigManifests } from '../../packages/conformance/rigs/load.ts';
import type { RigManifest } from '../../packages/conformance/rigs/types.ts';
import {
  discoverUncapturedStagedTargets,
  type StagedCaptureItem,
} from '../../packages/conformance/src/staged-captures.ts';

const DEFAULT_PARITY_SA = 'parity-test-sa@digame-mas.iam.gserviceaccount.com';

type WifTier = 'none' | 'parity-readonly' | 'capture-write';

interface RigIamHint {
  permission: string;
  role: string;
  api: string;
}

interface RigCapturePolicy {
  readonlyParityWif?: boolean;
  filterFlag?: '--scenario' | '--probe';
  autoPushSafe?: boolean;
  perProbeStaged?: boolean;
  iamHint?: RigIamHint;
}

const RULES_VIEWER_IAM_HINT: RigIamHint = {
  permission: 'firebaserules.rulesets.test',
  role: 'roles/firebaserules.viewer',
  api: 'firebaserules.googleapis.com',
};

const LIVE_SDK_IAM_HINT: RigIamHint = {
  permission:
    'datastore.entities.create, firebaserules.releases.update, firebasedatabase.instances.update',
  role: 'roles/datastore.user, roles/firebaserules.admin, roles/firebasedatabase.admin',
  api: 'firestore.googleapis.com, firebaserules.googleapis.com, firebasedatabase.googleapis.com',
};

/**
 * Consolidated per-rig policy table (`oracle-capture.yml`).
 *
 * Read-only Rules Test API rigs (`readonlyParityWif: true`) use the existing
 * `GCP_WIF_PROVIDER` + `PARITY_SA_EMAIL` identity (`firebaserules.rulesets.test`).
 * Messaging and live-project write rigs use the separate main-only
 * `CAPTURE_WIF_PROVIDER` + `CAPTURE_SA_EMAIL` identity so write roles are never
 * granted to the PR-reachable parity identity. Paid generative model rigs omit
 * `autoPushSafe` so they stay manual-dispatch only.
 */
const RIG_CAPTURE_POLICIES: Readonly<Record<string, RigCapturePolicy>> = {
  'admin-app': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
  },
  'admin-auth': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: {
      permission: 'firebaseauth.users.create, firebaseauth.users.get, firebaseauth.users.delete',
      role: 'roles/firebaseauth.admin',
      api: 'identitytoolkit.googleapis.com',
    },
  },
  'admin-firestore': {
    filterFlag: '--probe',
    perProbeStaged: true,
    iamHint: {
      permission: 'datastore.entities.create, datastore.entities.get, datastore.entities.delete',
      role: 'roles/datastore.user',
      api: 'firestore.googleapis.com',
    },
  },
  'app-registry': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
  },
  'client-storage': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
  },
  'messaging-send': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: {
      permission: 'cloudmessaging.messages.create',
      role: 'roles/firebasecloudmessaging.admin',
      api: 'fcm.googleapis.com',
    },
  },
  'oracle-run': {
    iamHint: LIVE_SDK_IAM_HINT,
  },
  'rules-firestore': {
    readonlyParityWif: true,
    filterFlag: '--scenario',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: RULES_VIEWER_IAM_HINT,
  },
  'rules-storage': {
    readonlyParityWif: true,
    filterFlag: '--scenario',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: RULES_VIEWER_IAM_HINT,
  },
  'sdk-probes': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: LIVE_SDK_IAM_HINT,
  },
  'storage-admin': {
    filterFlag: '--probe',
    perProbeStaged: true,
    iamHint: {
      permission: 'storage.objects.create, storage.objects.get, storage.objects.delete',
      role: 'roles/storage.objectAdmin',
      api: 'storage.googleapis.com',
    },
  },
  'storage-stdlib-discovery': {
    readonlyParityWif: true,
    filterFlag: '--probe',
    autoPushSafe: true,
    iamHint: RULES_VIEWER_IAM_HINT,
  },
};

function policyForRig(rigId: string): RigCapturePolicy {
  return RIG_CAPTURE_POLICIES[rigId] ?? {};
}

function hintForExtractedPermission(permission: string): RigIamHint | undefined {
  if (permission.startsWith('cloudmessaging.')) {
    return policyForRig('messaging-send').iamHint;
  }
  if (permission.startsWith('firebaseauth.')) {
    return policyForRig('admin-auth').iamHint;
  }
  if (permission.startsWith('firebasedatabase.')) {
    return {
      permission,
      role: 'roles/firebasedatabase.admin',
      api: 'firebasedatabase.googleapis.com',
    };
  }
  if (permission.startsWith('datastore.')) {
    return policyForRig('admin-firestore').iamHint;
  }
  if (permission.startsWith('storage.')) {
    return policyForRig('storage-admin').iamHint;
  }
  if (permission === 'firebaserules.rulesets.test') {
    return RULES_VIEWER_IAM_HINT;
  }
  if (permission.startsWith('firebaserules.')) {
    return {
      permission,
      role: 'roles/firebaserules.admin',
      api: 'firebaserules.googleapis.com',
    };
  }
  return undefined;
}

export interface PlannedRigInvocation {
  rig: string;
  script: string;
  args: string[];
  wifTier?: WifTier;
}

export interface CapturePlan {
  shouldRun: boolean;
  needsWif: boolean;
  needsParityWif?: boolean;
  needsCaptureWif?: boolean;
  invocations: PlannedRigInvocation[];
  skippedRigs?: string[];
}

export interface PlanDiscoveryOverrides {
  stagedTargets?: readonly StagedCaptureItem[];
  pendingPrefixRigs?: readonly string[];
}

export function appendStepSummary(env: NodeJS.ProcessEnv, markdown: string): void {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${markdown}\n`);
  }
}

export function appendGithubOutput(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const outPath = env.GITHUB_OUTPUT;
  if (outPath) {
    appendFileSync(outPath, `${key}=${value}\n`);
  }
}

export function assertMainBranchContext(env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_EVENT_NAME === 'pull_request' || env.GITHUB_EVENT_NAME === 'pull_request_target') {
    throw new Error(
      `oracle-capture refused: event '${env.GITHUB_EVENT_NAME}' is prohibited (never runs on pull_request)`,
    );
  }
  if (env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error(
      `oracle-capture refused: GITHUB_REF must equal 'refs/heads/main', got '${String(env.GITHUB_REF ?? '')}'`,
    );
  }
}

function wifTierForManifest(manifest: RigManifest): WifTier {
  if (manifest.automation === 'unattended') {
    return 'none';
  }
  if (policyForRig(manifest.id).readonlyParityWif) {
    return 'parity-readonly';
  }
  return 'capture-write';
}

function validateRigAllowed(rigId: string, manifestsById: ReadonlyMap<string, RigManifest>): RigManifest {
  const manifest = manifestsById.get(rigId);
  if (!manifest) {
    const known = [...manifestsById.keys()].sort().join(', ');
    throw new Error(`Unknown oracle rig '${rigId}'. Known rigs: ${known}`);
  }
  if (manifest.automation === 'human-witnessed') {
    throw new Error(
      `Oracle rig '${rigId}' is human-witnessed and cannot run unattended in CI.`,
    );
  }
  if (manifest.id === 'rtdb-rules') {
    throw new Error(
      `Oracle rig 'rtdb-rules' mutates live project rules (deploy/restore) and is excluded from automated CI capture.`,
    );
  }
  if (!manifest.safety.unattendedSafe) {
    throw new Error(
      `Oracle rig '${rigId}' declares safety.unattendedSafe=false and is excluded from automated CI capture.`,
    );
  }
  return manifest;
}

function buildInvocationForRig(manifest: RigManifest, filter?: string): PlannedRigInvocation {
  const args: string[] = ['--write'];
  const trimmedFilter = (filter ?? '').trim();
  if (trimmedFilter !== '') {
    if (!/^[A-Za-z0-9._-]+$/.test(trimmedFilter)) {
      throw new Error(`Invalid filter '${trimmedFilter}': expected safe identifier characters only`);
    }
    const flag = policyForRig(manifest.id).filterFlag;
    if (!flag) {
      throw new Error(`Oracle rig '${manifest.id}' does not accept a filter input ('${trimmedFilter}')`);
    }
    args.push(flag, trimmedFilter);
  }
  return {
    rig: manifest.id,
    script: manifest.script,
    args,
    wifTier: wifTierForManifest(manifest),
  };
}

function formatMissingParityWifReport(rigs: readonly string[], missingVar: string, saEmail: string): string {
  return [
    `## Oracle capture blocked: missing \`${missingVar}\``,
    '',
    `- Affected rig(s): \`${rigs.join('`, `')}\``,
    `- Service account: \`${saEmail}\``,
    `- Missing repository variable: \`vars.${missingVar}\``,
    `- Action: Configure \`vars.GCP_WIF_PROVIDER\` and \`vars.PARITY_SA_EMAIL\` (${DEFAULT_PARITY_SA}) on the repository.`,
  ].join('\n');
}

function formatSkippedCaptureWifReport(rigs: readonly string[]): string {
  const roleLines = rigs.map((rig) => {
    const hint = policyForRig(rig).iamHint;
    let roleNote = '';
    if (hint) {
      roleNote = ` (requires \`${hint.role}\` on \`${hint.api}\`)`;
    }
    return `  - \`${rig}\`${roleNote}`;
  });
  return [
    '## Oracle capture skipped: main-only capture identity not configured',
    '',
    '- Missing repository variables: `vars.CAPTURE_WIF_PROVIDER` and/or `vars.CAPTURE_SA_EMAIL`',
    '- Skipped rig(s) (never routed through the PR-reachable parity identity):',
    ...roleLines,
    '- Action: Configure `vars.CAPTURE_WIF_PROVIDER` and `vars.CAPTURE_SA_EMAIL` for the main-only capture service account on `digame-mas`.',
  ].join('\n');
}

export async function planCaptureRun(
  env: NodeJS.ProcessEnv,
  overrides: PlanDiscoveryOverrides = {},
): Promise<CapturePlan> {
  assertMainBranchContext(env);
  const manifests = await loadRigManifests();
  const manifestsById = new Map(manifests.map((m) => [m.id, m]));
  const inputRig = (env.INPUT_RIG ?? '').trim();
  const inputFilter = (env.INPUT_FILTER ?? '').trim();

  let candidateInvocations: PlannedRigInvocation[] = [];

  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' || inputRig !== '') {
    if (inputRig === '') {
      throw new Error('workflow_dispatch requires a non-empty `rig` input');
    }
    const requestedRigs = inputRig
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (requestedRigs.length === 0) {
      throw new Error('workflow_dispatch requires at least one valid `rig` id');
    }
    if (requestedRigs.length > 1 && inputFilter !== '') {
      throw new Error('`filter` cannot be combined with multiple comma-separated rigs');
    }
    candidateInvocations = requestedRigs.map((rigId) => {
      const manifest = validateRigAllowed(rigId, manifestsById);
      return buildInvocationForRig(manifest, inputFilter);
    });
  } else {
    const stagedTargets = overrides.stagedTargets ?? discoverUncapturedStagedTargets();
    const pendingPrefixRigs =
      overrides.pendingPrefixRigs ??
      manifests
        .filter((m) => {
          const policy = policyForRig(m.id);
          return (
            (m.pendingPrefixes?.length ?? 0) > 0 &&
            Boolean(policy.autoPushSafe) &&
            !policy.perProbeStaged
          );
        })
        .map((m) => m.id);

    const plannedList: PlannedRigInvocation[] = [];
    const coveredRigs = new Set<string>();

    for (const item of stagedTargets) {
      if (!policyForRig(item.rig).autoPushSafe) continue;
      const manifest = validateRigAllowed(item.rig, manifestsById);
      coveredRigs.add(manifest.id);
      plannedList.push(buildInvocationForRig(manifest, item.filterValue));
    }

    for (const rigId of pendingPrefixRigs) {
      if (coveredRigs.has(rigId)) continue;
      const manifest = validateRigAllowed(rigId, manifestsById);
      coveredRigs.add(manifest.id);
      plannedList.push(buildInvocationForRig(manifest));
    }

    candidateInvocations = plannedList.sort(
      (a, b) => a.rig.localeCompare(b.rig) || a.args.join(' ').localeCompare(b.args.join(' ')),
    );
  }

  if (candidateInvocations.length === 0) {
    return {
      shouldRun: false,
      needsWif: false,
      needsParityWif: false,
      needsCaptureWif: false,
      invocations: [],
      skippedRigs: [],
    };
  }

  const captureWifConfigured =
    Boolean((env.CAPTURE_WIF_PROVIDER ?? '').trim()) &&
    Boolean((env.CAPTURE_SA_EMAIL ?? '').trim());

  const skippedRigsSet = new Set<string>();
  const activeInvocations: PlannedRigInvocation[] = [];
  for (const inv of candidateInvocations) {
    if (inv.wifTier === 'capture-write' && !captureWifConfigured) {
      skippedRigsSet.add(inv.rig);
      continue;
    }
    activeInvocations.push(inv);
  }

  const skippedRigs = [...skippedRigsSet].sort();
  if (skippedRigs.length > 0) {
    const skipNotice = formatSkippedCaptureWifReport(skippedRigs);
    appendStepSummary(env, skipNotice);
    console.log(skipNotice);
  }

  if (activeInvocations.length === 0) {
    return {
      shouldRun: false,
      needsWif: false,
      needsParityWif: false,
      needsCaptureWif: false,
      invocations: [],
      skippedRigs,
    };
  }

  const parityRigs = [...new Set(
    activeInvocations.filter((inv) => inv.wifTier === 'parity-readonly').map((inv) => inv.rig),
  )].sort();
  const needsParityWif = parityRigs.length > 0;
  const needsCaptureWif = activeInvocations.some((inv) => inv.wifTier === 'capture-write');

  if (needsParityWif) {
    const saEmail = (env.PARITY_SA_EMAIL ?? '').trim() || DEFAULT_PARITY_SA;
    if (!(env.GCP_WIF_PROVIDER ?? '').trim()) {
      const msg = formatMissingParityWifReport(parityRigs, 'GCP_WIF_PROVIDER', saEmail);
      appendStepSummary(env, msg);
      console.error(msg);
      throw new Error(`Missing required repository variable GCP_WIF_PROVIDER for ${parityRigs.join(', ')}`);
    }
    if (!(env.PARITY_SA_EMAIL ?? '').trim()) {
      const msg = formatMissingParityWifReport(parityRigs, 'PARITY_SA_EMAIL', DEFAULT_PARITY_SA);
      appendStepSummary(env, msg);
      console.error(msg);
      throw new Error(`Missing required repository variable PARITY_SA_EMAIL for ${parityRigs.join(', ')}`);
    }
  }

  return {
    shouldRun: true,
    needsWif: needsParityWif || needsCaptureWif,
    needsParityWif,
    needsCaptureWif,
    invocations: activeInvocations,
    skippedRigs,
  };
}

function resolveServiceAccountDisplay(rig: string, env: NodeJS.ProcessEnv): string {
  if (!policyForRig(rig).readonlyParityWif) {
    const captureSa = (env.CAPTURE_SA_EMAIL ?? '').trim();
    if (captureSa !== '') return captureSa;
  }
  const paritySa = (env.PARITY_SA_EMAIL ?? '').trim();
  if (paritySa !== '' && paritySa !== DEFAULT_PARITY_SA) {
    return `${paritySa} (default parity SA: ${DEFAULT_PARITY_SA})`;
  }
  return DEFAULT_PARITY_SA;
}

/**
 * Produces an actionable IAM / API / secret diagnostic block suitable for both
 * `$GITHUB_STEP_SUMMARY` and stderr when a capture rig fails against GCP.
 */
export function diagnoseCaptureFailure(
  rig: string,
  output: string,
  env: NodeJS.ProcessEnv,
): string {
  const saDisplay = resolveServiceAccountDisplay(rig, env);
  const captureSaTrimmed = (env.CAPTURE_SA_EMAIL ?? '').trim();
  let saTarget = DEFAULT_PARITY_SA;
  if (!policyForRig(rig).readonlyParityWif && captureSaTrimmed !== '') {
    saTarget = captureSaTrimmed;
  }

  const extractedPermMatch =
    /Permission\s+['"]?([a-z0-9_.]+)['"]?\s+denied(?:\s+on\s+resource)?/i.exec(output);
  const extractedPerm = extractedPermMatch?.[1];
  let hint = policyForRig(rig).iamHint;
  if (extractedPerm) {
    const extractedHint = hintForExtractedPermission(extractedPerm);
    if (extractedHint) {
      hint = extractedHint;
    }
  }

  const mentionsSignBlob = /signBlob|iamcredentials\.googleapis\.com/i.test(output);
  const mentionsMissingFirebaseConfig = /PYRIC_ORACLE_FIREBASE_CONFIG/i.test(output);
  const mentionsMissingRtdbUrl = /PYRIC_ORACLE_RTDB_URL|dedicated RTDB/i.test(output);
  const mentionsApiDisabled = /accessNotConfigured|has not been used in project|API .* is disabled/i.test(output);
  const mentionsPermissionDenied =
    Boolean(extractedPerm) ||
    /403|PERMISSION_DENIED|permission .* denied|does not have permission|Caller does not have required permission/i.test(
      output,
    );

  const lines: string[] = [`## Oracle capture failed for \`${rig}\``, ''];
  lines.push(`- Service account: \`${saDisplay}\``);
  lines.push(`- Oracle project: \`digame-mas\``);

  if (mentionsSignBlob) {
    lines.push('- Failure class: IAM Credentials `iam.serviceAccounts.signBlob` denied');
    lines.push('- Required IAM role: `roles/iam.serviceAccountTokenCreator` (self-binding on the service account)');
    lines.push('- Required API: `iamcredentials.googleapis.com` enabled on `digame-mas`');
    lines.push(
      `- Action: Grant \`roles/iam.serviceAccountTokenCreator\` (\`iam.serviceAccounts.signBlob\`) and enable \`iamcredentials.googleapis.com\` for \`${saTarget}\` on \`digame-mas\` so \`${rig}\` can sign tokens.`,
    );
  } else if (mentionsMissingFirebaseConfig) {
    lines.push('- Failure class: Missing repository secret `PYRIC_ORACLE_FIREBASE_CONFIG`');
    lines.push('- Required secret: `secrets.PYRIC_ORACLE_FIREBASE_CONFIG` (Web app config JSON for `digame-mas`)');
    lines.push(
      `- Action: Add repository secret \`PYRIC_ORACLE_FIREBASE_CONFIG\` for project \`digame-mas\` so \`${rig}\` can initialize its Firebase client configuration.`,
    );
  } else if (mentionsMissingRtdbUrl) {
    lines.push('- Failure class: Missing dedicated oracle RTDB instance variable `PYRIC_ORACLE_RTDB_URL`');
    lines.push('- Required variable/secret: `PYRIC_ORACLE_RTDB_URL` pointing to the dedicated non-default RTDB instance (e.g. `https://pyric-oracle-rtdb-2.firebaseio.com`)');
    lines.push(
      `- Action: Set \`PYRIC_ORACLE_RTDB_URL\` to the dedicated non-default oracle RTDB instance on \`digame-mas\` and grant \`roles/firebasedatabase.admin\` to \`${saTarget}\` for \`${rig}\`.`,
    );
  } else if (mentionsApiDisabled) {
    let apiName = 'the target Firebase/Google Cloud API';
    if (hint) {
      apiName = hint.api;
    }
    lines.push(`- Failure class: Google Cloud API disabled (\`${apiName}\`)`);
    lines.push(
      `- Action: Enable \`${apiName}\` on project \`digame-mas\` and verify \`${saTarget}\` access for \`${rig}\`.`,
    );
  } else if (mentionsPermissionDenied) {
    const permName = extractedPerm ?? hint?.permission;
    let permText = 'the required IAM permission for this rig';
    if (permName && hint) {
      permText = `permission \`${permName}\` (e.g. \`${hint.role}\` on \`${hint.api}\`)`;
    } else if (permName) {
      permText = `permission \`${permName}\``;
    }
    lines.push(`- Failure class: IAM permission denied (${permText})`);
    if (permName) {
      lines.push(`- Missing IAM permission: \`${permName}\``);
    }
    if (hint) {
      lines.push(`- Suggested IAM role: \`${hint.role}\` on project \`digame-mas\``);
      lines.push(`- Target API: \`${hint.api}\``);
    }
    lines.push(
      `- Action: Grant ${permText} to \`${saTarget}\` on project \`digame-mas\` to unblock \`${rig}\` oracle captures.`,
    );
  } else {
    lines.push('- Failure class: Capture script exited non-zero (inspect log excerpt below)');
  }

  const tail = output
    .trim()
    .split('\n')
    .slice(-20)
    .join('\n');
  if (tail) {
    lines.push('', '```text', tail, '```');
  }
  return lines.join('\n');
}
