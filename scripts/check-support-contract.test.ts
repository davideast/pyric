import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const command = join(__dirname, 'check-support-contract.ts');
const directories: string[] = [];
const restartScenario = {
  id: 'hosted.restart',
  seam: 'S3',
  gates: ['4B'],
  expected: 'An SDK read after host restart returns the saved document.',
};
const sharedDocumentScenario = {
  id: 'hosted.shared-document',
  seam: 'S1',
  gates: ['0C'],
  expected: 'A second browser observes the first browser’s SDK write.',
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(manifest: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'pyric-support-contract-'));
  directories.push(directory);
  const path = join(directory, 'support.json');
  writeFileSync(path, JSON.stringify(manifest));
  return spawnSync(process.execPath, [command, path], { encoding: 'utf8', timeout: 10_000 });
}

function hostedConfiguration(scenarios: string[]) {
  return {
    id: 'hosted-sandbox',
    host: 'node',
    executionOwner: 'shared-host-dispatcher',
    identitySource: 'emulated-admitted-consumer-session-and-lens',
    projectDatabaseScope: 'configured-project-and-database',
    persistenceOwner: 'exclusive-node-state-writer',
    families: ['firestore'],
    scenarios,
  };
}

test('support contract command refuses a configuration that references an undefined scenario', () => {
  const result = run({
    configurations: [hostedConfiguration(['hosted.restart'])],
    scenarios: [sharedDocumentScenario],
  });

  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).issues).toContainEqual({
    rule: 'unknown-scenario', configuration: 'hosted-sandbox', scenario: 'hosted.restart',
  });
});

test('support contract command refuses duplicate scenario identities', () => {
  const result = run({
    configurations: [hostedConfiguration(['hosted.restart'])],
    scenarios: [restartScenario, restartScenario],
  });

  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).issues).toContainEqual({ rule: 'duplicate-scenario', scenario: 'hosted.restart' });
});

test('support contract command refuses a configuration with no scenarios', () => {
  const result = run({
    configurations: [hostedConfiguration([])],
    scenarios: [restartScenario],
  });

  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).issues).toContainEqual({ rule: 'uncovered-configuration', configuration: 'hosted-sandbox' });
});

test('support contract command reports resolved scenario declarations without claiming execution', () => {
  const result = run({
    configurations: [hostedConfiguration(['hosted.restart', 'hosted.shared-document'])],
    scenarios: [sharedDocumentScenario, restartScenario],
  });

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    scope: 'scenario-declarations',
    coverage: [{ configuration: 'hosted-sandbox', resolved: ['hosted.restart', 'hosted.shared-document'], missing: [] }],
    issues: [],
  });
});

test('support contract command refuses duplicate configuration identities', () => {
  const result = run({
    configurations: [
      hostedConfiguration(['hosted.restart']),
      hostedConfiguration(['hosted.restart']),
    ],
    scenarios: [restartScenario],
  });

  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).issues).toContainEqual({ rule: 'duplicate-configuration', configuration: 'hosted-sandbox' });
});

test('support contract command refuses an empty contract', () => {
  const result = run({ configurations: [], scenarios: [] });

  expect(result.status).toBe(1);
});

test('support contract command identifies missing ownership and service-family metadata', () => {
  const result = run({
    configurations: [{ id: 'hosted-sandbox', scenarios: ['hosted.restart'] }],
    scenarios: [restartScenario],
  });

  expect(result.status).toBe(1);
  const missingFields = [
    'configurations.0.host',
    'configurations.0.executionOwner',
    'configurations.0.identitySource',
    'configurations.0.projectDatabaseScope',
    'configurations.0.persistenceOwner',
    'configurations.0.families',
  ];
  const expectedIssues = missingFields.map((path) => ({ rule: 'invalid-manifest', path }));
  const report = JSON.parse(result.stdout);
  expect(report.issues).toEqual(expect.arrayContaining(expectedIssues));
  expect(report.issues).toHaveLength(6);
});

test('support contract command requires a scenario seam, gate, and expected outcome', () => {
  const result = run({
    configurations: [hostedConfiguration(['hosted.restart'])],
    scenarios: [{ id: 'hosted.restart' }],
  });

  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.issues).toEqual(expect.arrayContaining([
    { rule: 'invalid-manifest', path: 'scenarios.0.seam' },
    { rule: 'invalid-manifest', path: 'scenarios.0.gates' },
    { rule: 'invalid-manifest', path: 'scenarios.0.expected' },
  ]));
  expect(report.issues).toHaveLength(3);
});

test('required CI runs support validation and propagates invalid declarations', () => {
  const root = resolve(__dirname, '..');
  const workflow = z.object({
    jobs: z.object({
      'build-packages': z.object({
        'continue-on-error': z.literal(false).optional(),
        steps: z.array(z.object({
          name: z.string().optional(),
          run: z.string().optional(),
          if: z.string().optional(),
          'continue-on-error': z.literal(false).optional(),
        })),
      }),
      required: z.object({ needs: z.array(z.string()) }),
    }),
  }).parse(Bun.YAML.parse(readFileSync(join(root, '.github/workflows/build.yml'), 'utf8')));
  const steps = workflow.jobs['build-packages'].steps;
  const testStep = steps.find((step) => step.name === 'Test support contract command');
  const checkStep = steps.find((step) => step.name === 'Check sandbox/hosted support declarations');
  expect(workflow.jobs.required.needs).toContain('build-packages');
  expect(testStep?.run).toBe('bun test scripts/check-support-contract.test.ts');
  expect(testStep?.if).toBeUndefined();
  expect(checkStep?.if).toBeUndefined();
  const script = checkStep?.run;
  expect(script).toBeDefined();
  const hasNoCommand = script === undefined;
  if (hasNoCommand) throw new Error('Required build has no support validation command');
  const fixture = mkdtempSync(join(tmpdir(), 'pyric-support-ci-'));
  directories.push(fixture);
  mkdirSync(join(fixture, 'docs'));
  symlinkSync(__dirname, join(fixture, 'scripts'), 'dir');
  const manifestPath = join(fixture, 'docs/hosted-support.json');
  const reportPath = join(fixture, 'pyric-support-contract.json');
  writeFileSync(manifestPath, JSON.stringify({
    configurations: [hostedConfiguration(['hosted.restart'])], scenarios: [restartScenario],
  }));
  const args = ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script];
  const options = { cwd: fixture, env: { ...process.env, RUNNER_TEMP: fixture }, encoding: 'utf8', timeout: 10_000 } as const;

  const valid = spawnSync('bash', args, options);

  expect(valid.status).toBe(0);
  expect(JSON.parse(readFileSync(reportPath, 'utf8')).issues).toEqual([]);
  writeFileSync(manifestPath, JSON.stringify({
    configurations: [hostedConfiguration(['hosted.missing'])], scenarios: [restartScenario],
  }));

  const invalid = spawnSync('bash', args, options);

  expect(invalid.status).toBe(1);
  expect(JSON.parse(readFileSync(reportPath, 'utf8')).issues).toContainEqual({
    rule: 'unknown-scenario', configuration: 'hosted-sandbox', scenario: 'hosted.missing',
  });
});

test('hosted runtime declarations state Node minimum and standalone Bun unavailability', () => {
  const root = resolve(__dirname, '..');
  const manifest = z.object({ scenarios: z.array(z.object({ id: z.string(), expected: z.string() })) })
    .parse(JSON.parse(readFileSync(join(root, 'docs/hosted-support.json'), 'utf8')));
  const packaging = manifest.scenarios.find(scenario => scenario.id === 'hosted.packaging');
  const requirement = 'Hosted mode requires Node >=22.15 and is unavailable in the Bun standalone binary until a Bun adapter ships.';
  expect(packaging?.expected).toContain(requirement);
  const persistenceContract = readFileSync(join(root, 'docs/hosted-persistence-contract.md'), 'utf8').replace(/\s+/g, ' ');
  expect(persistenceContract).toContain(requirement);
  expect(persistenceContract).toContain('SharedWorker remains supported.');
});
