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
  // orthogonal to how much of the suite runs. It is forced by the label or by a
  // diff that invalidates what it proves; a non-PR event carries no diff to
  // read, so the label is the only lever there.
  const packaging = prLabels.includes('ci-packaging') || requiresPackagingProof(paths);
  const summary = JSON.stringify(
    { mode, predictedCheckSet: checkSet, checkSet: effectiveCheckSet, packaging, paths },
    null,
    2,
  );
  console.log(summary);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `check-set=${effectiveCheckSet}\n`);
    appendFileSync(output, `predicted-check-set=${checkSet}\n`);
    appendFileSync(output, `packaging=${String(packaging)}\n`);
    appendFileSync(output, `paths-json=${JSON.stringify(paths)}\n`);
  }
}

if (import.meta.main) main();
