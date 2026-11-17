/**
 * Capture target planning, branch-context guard, and GCP IAM/secret diagnostic
 * formatter for `.github/workflows/oracle-capture.yml`.
 */
import { appendFileSync } from 'node:fs';
import { loadRigManifests } from '../../packages/conformance/rigs/load.ts';
import type { RigManifest } from '../../packages/conformance/rigs/types.ts';
import {
  discoverUncapturedStagedTargets,
  type StagedCaptureItem,
} from '../../packages/conformance/src/staged-captures.ts';

const DEFAULT_ORACLE_SA = 'parity-test-sa@digame-mas.iam.gserviceaccount.com';

const WRITE_FLAG_RIGS = new Set(['admin-app', 'app-registry', 'client-storage']);

const FILTER_FLAG_BY_RIG: Readonly<Record<string, '--scenario' | '--probe'>> = {
  'rules-firestore': '--scenario',
  'rules-storage': '--scenario',
  'storage-stdlib-discovery': '--probe',
  'messaging-send': '--probe',
  'admin-app': '--probe',
  'app-registry': '--probe',
  'client-storage': '--probe',
};

/** Rigs eligible for automatic `on: push` capture on `main`. Paid generative
 *  model rigs (`ai-logic`, `ai-request-edge`) stay manual-dispatch only. */
const AUTO_PUSH_SAFE_RIGS = new Set([
  'admin-app',
  'app-registry',
  'client-storage',
  'messaging-send',
  'rules-firestore',
  'rules-storage',
  'storage-stdlib-discovery',
]);

interface RigIamHint {
  permission: string;
  role: string;
  api: string;
}

const RIG_IAM_HINTS: Readonly<Record<string, RigIamHint>> = {
  'rules-firestore': {
    permission: 'firebaserules.rulesets.test',
    role: 'roles/firebaserules.viewer',
    api: 'firebaserules.googleapis.com',
  },
  'rules-storage': {
    permission: 'firebaserules.rulesets.test',
    role: 'roles/firebaserules.viewer',
    api: 'firebaserules.googleapis.com',
  },
  'storage-stdlib-discovery': {
    permission: 'firebaserules.rulesets.test',
    role: 'roles/firebaserules.viewer',
    api: 'firebaserules.googleapis.com',
  },
  'messaging-send': {
    permission: 'cloudmessaging.messages.create',
    role: 'roles/firebasecloudmessaging.admin',
    api: 'fcm.googleapis.com',
  },
  'admin-firestore': {
    permission: 'datastore.entities.create, datastore.entities.get, datastore.entities.delete',
    role: 'roles/datastore.user',
    api: 'firestore.googleapis.com',
  },
  'storage-admin': {
    permission: 'storage.objects.create, storage.objects.get, storage.objects.delete',
    role: 'roles/storage.objectAdmin',
    api: 'storage.googleapis.com',
  },
};

export interface PlannedRigInvocation {
  rig: string;
  script: string;
  args: string[];
}

export interface CapturePlan {
  shouldRun: boolean;
  needsWif: boolean;
  invocations: PlannedRigInvocation[];
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
  const args: string[] = [];
  if (WRITE_FLAG_RIGS.has(manifest.id)) {
    args.push('--write');
  }
  const trimmedFilter = (filter ?? '').trim();
  if (trimmedFilter !== '') {
    if (!/^[A-Za-z0-9._-]+$/.test(trimmedFilter)) {
      throw new Error(`Invalid filter '${trimmedFilter}': expected safe identifier characters only`);
    }
    const flag = FILTER_FLAG_BY_RIG[manifest.id];
    if (!flag) {
      throw new Error(`Oracle rig '${manifest.id}' does not accept a filter input ('${trimmedFilter}')`);
    }
    args.push(flag, trimmedFilter);
  }
  return {
    rig: manifest.id,
    script: manifest.script,
    args,
  };
}

function formatMissingWifReport(rigs: readonly string[], missingVar: string, saEmail: string): string {
  return [
    `## Oracle capture blocked: missing \`${missingVar}\``,
    '',
    `- Affected rig(s): \`${rigs.join('`, `')}\``,
    `- Service account: \`${saEmail}\``,
    `- Missing repository variable: \`vars.${missingVar}\``,
    `- Action (\`captures-to-authorise\`): Configure \`vars.GCP_WIF_PROVIDER\` and \`vars.PARITY_SA_EMAIL\` (${DEFAULT_ORACLE_SA}) on the repository.`,
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

  let selectedManifests: RigManifest[] = [];
  let invocations: PlannedRigInvocation[] = [];

  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' || inputRig !== '') {
    if (inputRig === '') {
      throw new Error('workflow_dispatch requires a non-empty `rig` input');
    }
    const manifest = validateRigAllowed(inputRig, manifestsById);
    selectedManifests = [manifest];
    invocations = [buildInvocationForRig(manifest, inputFilter)];
  } else {
    const stagedTargets = overrides.stagedTargets ?? discoverUncapturedStagedTargets();
    const pendingPrefixRigs =
      overrides.pendingPrefixRigs ??
      manifests
        .filter((m) => (m.pendingPrefixes?.length ?? 0) > 0 && AUTO_PUSH_SAFE_RIGS.has(m.id))
        .map((m) => m.id);

    const plannedList: PlannedRigInvocation[] = [];
    const manifestSet = new Map<string, RigManifest>();

    for (const item of stagedTargets) {
      if (!AUTO_PUSH_SAFE_RIGS.has(item.rig)) continue;
      const manifest = validateRigAllowed(item.rig, manifestsById);
      manifestSet.set(manifest.id, manifest);
      plannedList.push(buildInvocationForRig(manifest, item.filterValue));
    }

    for (const rigId of pendingPrefixRigs) {
      if (manifestSet.has(rigId)) continue;
      const manifest = validateRigAllowed(rigId, manifestsById);
      manifestSet.set(manifest.id, manifest);
      plannedList.push(buildInvocationForRig(manifest));
    }

    selectedManifests = [...manifestSet.values()].sort((a, b) => a.id.localeCompare(b.id));
    invocations = plannedList.sort(
      (a, b) => a.rig.localeCompare(b.rig) || a.args.join(' ').localeCompare(b.args.join(' ')),
    );
  }

  if (invocations.length === 0) {
    return { shouldRun: false, needsWif: false, invocations: [] };
  }

  const credentialedRigs = selectedManifests
    .filter((m) => m.automation === 'credentialed')
    .map((m) => m.id);
  const needsWif = credentialedRigs.length > 0;

  if (needsWif) {
    const saEmail = (env.PARITY_SA_EMAIL ?? '').trim() || DEFAULT_ORACLE_SA;
    if (!(env.GCP_WIF_PROVIDER ?? '').trim()) {
      const msg = formatMissingWifReport(credentialedRigs, 'GCP_WIF_PROVIDER', saEmail);
      appendStepSummary(env, msg);
      console.error(msg);
      throw new Error(`Missing required repository variable GCP_WIF_PROVIDER for ${credentialedRigs.join(', ')}`);
    }
    if (!(env.PARITY_SA_EMAIL ?? '').trim()) {
      const msg = formatMissingWifReport(credentialedRigs, 'PARITY_SA_EMAIL', DEFAULT_ORACLE_SA);
      appendStepSummary(env, msg);
      console.error(msg);
      throw new Error(`Missing required repository variable PARITY_SA_EMAIL for ${credentialedRigs.join(', ')}`);
    }
  }

  return { shouldRun: true, needsWif, invocations };
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
  const configuredSa = (env.PARITY_SA_EMAIL ?? '').trim();
  let saDisplay = DEFAULT_ORACLE_SA;
  if (configuredSa !== '' && configuredSa !== DEFAULT_ORACLE_SA) {
    saDisplay = `${configuredSa} (default oracle SA: ${DEFAULT_ORACLE_SA})`;
  }
  const hint = RIG_IAM_HINTS[rig];

  const mentionsSignBlob = /signBlob|iamcredentials\.googleapis\.com/i.test(output);
  const mentionsMissingFirebaseConfig = /PYRIC_ORACLE_FIREBASE_CONFIG/i.test(output);
  const mentionsApiDisabled = /accessNotConfigured|has not been used in project|API .* is disabled/i.test(output);
  const mentionsPermissionDenied = /403|PERMISSION_DENIED|does not have permission|Caller does not have required permission/i.test(
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
      `- 1-line \`captures-to-authorise\`: Grant \`roles/iam.serviceAccountTokenCreator\` (\`iam.serviceAccounts.signBlob\`) and enable \`iamcredentials.googleapis.com\` for \`${DEFAULT_ORACLE_SA}\` on \`digame-mas\` so \`${rig}\` can sign tokens.`,
    );
  } else if (mentionsMissingFirebaseConfig) {
    lines.push('- Failure class: Missing repository secret `PYRIC_ORACLE_FIREBASE_CONFIG`');
    lines.push('- Required secret: `secrets.PYRIC_ORACLE_FIREBASE_CONFIG` (Web app config JSON for `digame-mas`)');
    lines.push(
      `- 1-line \`captures-to-authorise\`: Add repository secret \`PYRIC_ORACLE_FIREBASE_CONFIG\` for project \`digame-mas\` so \`${rig}\` can initialize its Firebase client configuration.`,
    );
  } else if (mentionsApiDisabled) {
    const apiName = hint ? hint.api : 'the target Firebase/Google Cloud API';
    lines.push(`- Failure class: Google Cloud API disabled (\`${apiName}\`)`);
    lines.push(
      `- 1-line \`captures-to-authorise\`: Enable \`${apiName}\` on project \`digame-mas\` and verify \`${DEFAULT_ORACLE_SA}\` access for \`${rig}\`.`,
    );
  } else if (mentionsPermissionDenied) {
    let permText = 'the required IAM permission for this rig';
    if (hint) {
      permText = `permission \`${hint.permission}\` (e.g. \`${hint.role}\` on \`${hint.api}\`)`;
    }
    lines.push(`- Failure class: HTTP 403 / \`PERMISSION_DENIED\` (${permText})`);
    if (hint) {
      lines.push(`- Required IAM permission: \`${hint.permission}\``);
      lines.push(`- Suggested IAM role: \`${hint.role}\` on project \`digame-mas\``);
      lines.push(`- Target API: \`${hint.api}\``);
    }
    lines.push(
      `- 1-line \`captures-to-authorise\`: Grant ${permText} to \`${DEFAULT_ORACLE_SA}\` on project \`digame-mas\` to unblock \`${rig}\` oracle captures.`,
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
