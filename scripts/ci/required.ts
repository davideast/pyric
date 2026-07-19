#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import type { PrCheckSet } from './check-set.ts';

interface RequiredInput {
  checkSet: PrCheckSet;
  requirePackaging: boolean;
  results: Record<string, string | undefined>;
}

const CHECK_SET_JOBS: Record<PrCheckSet, readonly string[]> = {
  full: ['build-and-test', 'library-tests', 'browser-conformance', 'docs-only'],
  'release-only': ['release-contract'],
  'docs-only': ['docs-only'],
};

export function requiredFailures(input: RequiredInput): string[] {
  const required = [
    ...CHECK_SET_JOBS[input.checkSet],
    ...(input.requirePackaging ? ['packaging', 'install-matrix', 'standalone'] : []),
  ];
  return required.flatMap((job) => input.results[job] === 'success'
    ? []
    : [`${job}: ${input.results[job] ?? 'missing'}`]);
}

function main(): void {
  const checkSet = process.env.CI_CHECK_SET as PrCheckSet;
  if (!(checkSet in CHECK_SET_JOBS)) throw new Error(`Unknown CI_CHECK_SET: ${checkSet}`);
  const needs = JSON.parse(process.env.CI_NEEDS_JSON ?? '{}') as Record<string, { result?: string }>;
  const results = Object.fromEntries(Object.entries(needs).map(([job, value]) => [job, value.result]));
  const failures = requiredFailures({
    checkSet,
    requirePackaging: process.env.CI_REQUIRE_PACKAGING === 'true',
    results,
  });
  const report = [
    `## Required CI: ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
    '',
    `Check set: \`${checkSet}\``,
    '',
    ...Object.entries(results).map(([job, result]) => `- ${job}: ${result ?? 'missing'}`),
    ...(failures.length ? ['', 'Required failures:', ...failures.map((failure) => `- ${failure}`)] : []),
    '',
  ].join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (failures.length) process.exit(1);
}

if (import.meta.main) main();
