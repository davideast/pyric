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
