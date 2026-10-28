#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  requiresPackagingProof,
  selectPrCheckSet,
  type ChangedPath,
  type CheckSetInput,
} from './check-set.ts';

export function parseNameStatus(output: string): ChangedPath[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const paths: ChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) throw new Error('git diff emitted an empty status');
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) throw new Error(`git diff emitted an incomplete ${status} record`);
      paths.push({ path, previousPath });
      continue;
    }
    const path = fields[index++];
    if (!path) throw new Error(`git diff emitted an incomplete ${status} record`);
    paths.push({ path });
  }
  return paths;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function labels(): string[] {
  const value = process.env.CI_PR_LABELS_JSON;
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null) return [];
  if (!Array.isArray(parsed) || !parsed.every((label) => typeof label === 'string')) {
    throw new Error('CI_PR_LABELS_JSON must be a JSON string array');
  }
  return parsed;
}

export function determinePackaging(input: {
  event: CheckSetInput['event'];
  labels: string[];
  paths: ChangedPath[];
}): boolean {
  return input.event === 'push' || input.labels.includes('ci-packaging') || requiresPackagingProof(input.paths);
}

/** The code the RTDB differential gate compares: the served hosts, the RTDB
 *  and rules engines, and the gate itself. */
const RTDB_DIFFERENTIAL_INPUTS = [
  /^packages\/cli\/src\/serve\//,
  /^packages\/cli\/src\/rtdb\//,
  /^packages\/pyric\/src\/database\//,
  /^packages\/pyric\/src\/rules\//,
  /^packages\/cli\/test\/serve\/rtdb-differential\//,
  /^\.github\/workflows\/build\.yml$/,
];

export function determineRtdbDifferential(input: {
  event: CheckSetInput['event'];
  paths: ChangedPath[];
}): boolean {
  if (input.event !== 'pull_request') return true;
  const touches = (path: string): boolean => RTDB_DIFFERENTIAL_INPUTS.some((pattern) => pattern.test(path));
  return input.paths.some(({ path, previousPath }) =>
    touches(path) || (previousPath !== undefined && touches(previousPath)));
}

/** The code the app scenarios run as an installed user project: the Vite
 *  plugin and served hosts, the register hook and remote sandbox client, the
 *  Firebase project resolution, pyric-admin, the AI broker, the published
 *  manifests and the packaging that builds the tarballs, and the apps. */
const APP_SCENARIO_INPUTS = [
  /^packages\/cli\/src\/serve\//,
  /^packages\/cli\/src\/register\//,
  /^packages\/cli\/src\/remote\//,
  /^packages\/cli\/src\/cli\/firebase-project\.ts$/,
  /^packages\/pyric-admin\/src\//,
  /^packages\/pyric\/src\/ai\//,
  /^packages\/[^/]+\/package\.json$/,
  /^scripts\/pack-packages\.sh$/,
  /^scripts\/lib\/rewrite-workspace-deps\.mjs$/,
  /^test\/apps\//,
  /^\.github\/workflows\/build\.yml$/,
];

export function determineAppScenarios(input: {
  event: CheckSetInput['event'];
  paths: ChangedPath[];
}): boolean {
  if (input.event !== 'pull_request') return true;
  const touches = (path: string): boolean => APP_SCENARIO_INPUTS.some((pattern) => pattern.test(path));
  return input.paths.some(({ path, previousPath }) =>
    touches(path) || (previousPath !== undefined && touches(previousPath)));
}

function main(): void {
  const event = env('CI_EVENT_NAME') as CheckSetInput['event'];
  const paths = event === 'pull_request'
    ? parseNameStatus(execFileSync('git', [
      'diff', '--name-status', '-z', '--find-renames',
      `${env('CI_BASE_SHA')}...${env('CI_HEAD_SHA')}`,
    ], { encoding: 'utf8' }))
    : [];
  const prLabels = labels();
  const checkSet = selectPrCheckSet({ event, labels: prLabels, paths });
  const mode = process.env.CI_SELECTION_MODE === 'enforce' ? 'enforce' : 'shadow';
  const effectiveCheckSet = mode === 'shadow' ? 'full' : checkSet;
  // The packaging gate answers a question about published artifacts, which is
  // orthogonal to how much of the suite runs. It is forced by a push to main,
  // by the ci-packaging label, or by a diff that invalidates what it proves.
  const packaging = determinePackaging({ event, labels: prLabels, paths });
  const rtdbDifferential = effectiveCheckSet === 'full' && determineRtdbDifferential({ event, paths });
  const appScenarios = effectiveCheckSet === 'full' && determineAppScenarios({ event, paths });
  const summary = JSON.stringify(
    { mode, predictedCheckSet: checkSet, checkSet: effectiveCheckSet, packaging, rtdbDifferential, appScenarios, paths },
    null,
    2,
  );
  console.log(summary);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `check-set=${effectiveCheckSet}\n`);
    appendFileSync(output, `predicted-check-set=${checkSet}\n`);
    appendFileSync(output, `packaging=${String(packaging)}\n`);
    appendFileSync(output, `rtdb-differential=${String(rtdbDifferential)}\n`);
    appendFileSync(output, `app-scenarios=${String(appScenarios)}\n`);
    appendFileSync(output, `paths-json=${JSON.stringify(paths)}\n`);
  }
}

if (import.meta.main) main();
