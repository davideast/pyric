import { jsonRequest, type AccessHeaders } from './storage-stdlib-real-api.ts';

export interface IamBinding {
  role: string;
  members: string[];
  condition?: unknown;
}

export interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
  auditConfigs?: unknown[];
}

export function canonicalPolicy(policy: IamPolicy): string {
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...binding.members].sort(),
  })).sort((a, b) =>
    `${a.role}:${JSON.stringify(a.condition)}`.localeCompare(`${b.role}:${JSON.stringify(b.condition)}`));
  return JSON.stringify({
    version: policy.version ?? 0,
    bindings,
    auditConfigs: policy.auditConfigs ?? [],
  });
}

type IamPolicyRequest = (url: string, init: RequestInit, label: string) => Promise<IamPolicy>;
type IamJsonRequest = <T>(url: string, init: RequestInit, label: string) => Promise<T>;

interface TemporaryIamOptions {
  request?: IamJsonRequest;
  cleanupRequest?: IamJsonRequest;
  settle?: () => Promise<void>;
}

const FIRESTORE_SERVICE_AGENT_ROLE = 'roles/firebaserules.firestoreServiceAgent';

export async function withTemporaryFirestoreRulesIam<T>(
  projectId: string,
  headers: AccessHeaders,
  work: (iamChanged: boolean) => Promise<T>,
  options: TemporaryIamOptions = {},
): Promise<{ value: T; iamChanged: boolean; iamRestored: boolean }> {
  const request: IamJsonRequest = options.request
    ?? (<R>(url: string, init: RequestInit, label: string) => jsonRequest<R>(url, init, label));
  const cleanupRequest = options.cleanupRequest ?? request;
  const settle = options.settle ?? (async () => {});
  const project = await request<{ projectNumber: string }>(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`,
    { headers: headers.auth },
    'read project number',
  );
  const policyUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`;
  const original = await request<IamPolicy>(
    policyUrl,
    { method: 'POST', headers: headers.json, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
    'snapshot IAM policy',
  );
  const member = `serviceAccount:service-${project.projectNumber}@gcp-sa-firebasestorage.iam.gserviceaccount.com`;
  const next = structuredClone(original);
  next.version = Math.max(next.version ?? 0, 3);
  next.bindings ??= [];
  const alreadyGranted = next.bindings.some((binding) => binding.role === FIRESTORE_SERVICE_AGENT_ROLE
    && binding.condition === undefined
    && binding.members.includes(member));
  let iamChanged = false;
  let iamRestored = alreadyGranted;
  let value!: T;
  try {
    if (!alreadyGranted) {
      let binding = next.bindings.find((candidate) => candidate.role === FIRESTORE_SERVICE_AGENT_ROLE
        && candidate.condition === undefined);
      if (!binding) {
        binding = { role: FIRESTORE_SERVICE_AGENT_ROLE, members: [] };
        next.bindings.push(binding);
      }
      binding.members.push(member);
      // Mark the lease dirty before the request: a transport failure can occur
      // after the policy commits but before the response reaches this process.
      iamChanged = true;
      await request<IamPolicy>(
        policyUrl.replace(':getIamPolicy', ':setIamPolicy'),
        { method: 'POST', headers: headers.json, body: JSON.stringify({ policy: next }) },
        'grant temporary cross-service IAM role',
      );
      await settle();
    }
    value = await work(iamChanged);
  } finally {
    if (iamChanged) {
      iamRestored = await restoreIamPolicy(
        policyUrl,
        original,
        headers,
        (url, init, label) => cleanupRequest<IamPolicy>(url, init, label),
        settle,
      );
    }
  }
  if (!iamRestored) throw new Error('IAM restoration verification failed');
  return { value, iamChanged, iamRestored };
}

export async function restoreIamPolicy(
  policyUrl: string,
  original: IamPolicy,
  headers: AccessHeaders,
  request: IamPolicyRequest = (url, init, label) => jsonRequest<IamPolicy>(url, init, label),
  settle: () => Promise<void> = async () => {},
  attempts = 2,
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const current = await request(
        policyUrl,
        { method: 'POST', headers: headers.json, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
        'read IAM policy before restore',
      );
      if (canonicalPolicy(current) !== canonicalPolicy(original)) {
        await request(
          policyUrl.replace(':getIamPolicy', ':setIamPolicy'),
          { method: 'POST', headers: headers.json, body: JSON.stringify({ policy: { ...original, etag: current.etag } }) },
          'restore original IAM policy',
        );
      }
      await settle();
      const verified = await request(
        policyUrl,
        { method: 'POST', headers: headers.json, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
        'verify settled IAM policy restoration',
      );
      if (canonicalPolicy(verified) === canonicalPolicy(original)) return true;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw new Error('IAM restoration failed after bounded retries', { cause: lastError });
  return false;
}
