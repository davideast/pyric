import { readFileSync } from 'node:fs';
import { z } from 'zod';

type SupportIssue =
  | { rule: 'unknown-scenario'; configuration: string; scenario: string }
  | { rule: 'duplicate-scenario'; scenario: string }
  | { rule: 'duplicate-configuration'; configuration: string }
  | { rule: 'uncovered-configuration'; configuration: string };

const path = process.argv[2];
const hasNoPath = path === undefined;
if (hasNoPath) throw new Error('Usage: bun scripts/check-support-contract.ts <manifest.json>');
const parsed = z.object({
  configurations: z.array(z.object({
    id: z.string(),
    host: z.enum(['page', 'sharedworker', 'node']),
    executionOwner: z.string().min(1),
    identitySource: z.string().min(1),
    projectDatabaseScope: z.string().min(1),
    persistenceOwner: z.string().min(1),
    families: z.array(z.string().min(1)).min(1),
    scenarios: z.array(z.string()),
  })).min(1),
  scenarios: z.array(z.object({
    id: z.string(),
    seam: z.enum(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']),
    gates: z.array(z.string().min(1)).min(1),
    expected: z.string().min(1),
  })).min(1),
}).safeParse(JSON.parse(readFileSync(path, 'utf8')));
const hasInvalidManifest = !parsed.success;
if (hasInvalidManifest) {
  const issues = parsed.error.issues.map((issue) => ({ rule: 'invalid-manifest', path: issue.path.join('.') }));
  console.log(JSON.stringify({ issues }, null, 2));
  process.exit(1);
}
const manifest = parsed.data;
const scenarioIds = new Set<string>();
const issues: SupportIssue[] = [];
for (const scenario of manifest.scenarios) {
  const isDuplicate = scenarioIds.has(scenario.id);
  if (isDuplicate) issues.push({ rule: 'duplicate-scenario', scenario: scenario.id });
  scenarioIds.add(scenario.id);
}
const configurationIds = new Set<string>();
for (const configuration of manifest.configurations) {
  const isDuplicate = configurationIds.has(configuration.id);
  if (isDuplicate) issues.push({ rule: 'duplicate-configuration', configuration: configuration.id });
  configurationIds.add(configuration.id);
  const hasNoScenarios = configuration.scenarios.length === 0;
  if (hasNoScenarios) issues.push({ rule: 'uncovered-configuration', configuration: configuration.id });
}
issues.push(...manifest.configurations.flatMap((configuration) =>
  configuration.scenarios.filter((id) => !scenarioIds.has(id)).map((scenario): SupportIssue => ({
    rule: 'unknown-scenario', configuration: configuration.id, scenario,
  })),
));
const coverage = manifest.configurations.map((configuration) => ({
  configuration: configuration.id,
  resolved: configuration.scenarios.filter((id) => scenarioIds.has(id)),
  missing: configuration.scenarios.filter((id) => !scenarioIds.has(id)),
}));
console.log(JSON.stringify({ scope: 'scenario-declarations', coverage, issues }, null, 2));
const hasIssues = issues.length > 0;
if (hasIssues) process.exitCode = 1;
