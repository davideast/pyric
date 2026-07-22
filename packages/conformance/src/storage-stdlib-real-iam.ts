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
