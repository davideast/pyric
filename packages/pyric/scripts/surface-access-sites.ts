/**
 * Emit the `accessSites` part of an assurance `surface-report.json` for
 * one app.
 *
 *   bun packages/pyric/scripts/surface-access-sites.ts --root <app dir> \
 *     [--app <name>] [--out <file>] [--preset <preset.json>]... [--no-reads] [--summary] \
 *     [--firestore-rules <file>]... [--rtdb-rules <file>]...
 *
 * Also emits `ownerBindings`: rules come from the `--*-rules` files, else
 * `firebase.json`, else rules the app installs from code.
 *
 * `--preset` takes a JSON file holding one `AccessPreset` (app-specific
 * conventions such as extra SDK module names). Prints the report to stdout
 * unless `--out` is given; `--summary` also prints counts to stderr.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAccessSites } from '../src/assurance-surface/code/extractor.js';
import type { AccessPreset } from '../src/assurance-surface/code/types.js';
import { runProbes, type ProbeReport } from '../src/assurance-surface/probes/run-probes.js';
import { analyzeOwners } from '../src/assurance-surface/rules/analyze-owners.js';

interface ParsedArgs {
  root: string;
  app?: string;
  out?: string;
  presets: string[];
  clientRoots: string[];
  serverRoots: string[];
  reads: boolean;
  summary: boolean;
  firestoreRules: string[];
  rtdbRules: string[];
  probes: boolean;
  probeLog?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    root: '',
    app: undefined,
    out: undefined,
    presets: [],
    clientRoots: [],
    serverRoots: [],
    reads: true,
    summary: false,
    firestoreRules: [],
    rtdbRules: [],
    probes: true,
    probeLog: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--app') out.app = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--preset') out.presets.push(argv[++i]);
    else if (a === '--no-reads') out.reads = false;
    else if (a === '--summary') out.summary = true;
    else if (a === '--firestore-rules') out.firestoreRules.push(argv[++i]);
    else if (a === '--rtdb-rules') out.rtdbRules.push(argv[++i]);
    else if (a === '--no-probes') out.probes = false;
    else if (a === '--probe-log') out.probeLog = argv[++i];
    else if (a === '--client-root') out.clientRoots.push(argv[++i]);
    else if (a === '--server-root') out.serverRoots.push(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.root) throw new Error('--root is required');
  return out;
}

function pyricCommit(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const args = parseArgs(process.argv.slice(2));
const presets = args.presets.map((p) => JSON.parse(readFileSync(p, 'utf8')) as AccessPreset);
const started = Date.now();
const report = extractAccessSites({
  root: args.root,
  clientRoots: args.clientRoots,
  serverRoots: args.serverRoots,
  presets,
  includeReads: args.reads,
});
const owners = analyzeOwners(args.root, report.accessSites, report.embeddedRules, {
  firestore: args.firestoreRules,
  rtdb: args.rtdbRules,
});
let probeReport: ProbeReport = { probes: { total: 0, invalid: 0 }, findings: [], results: [], actors: [] };
if (args.probes) {
  probeReport = await runProbes({
    accessSites: report.accessSites,
    ownerBindings: owners.ownerBindings,
    conditions: owners.conditions,
    sources: owners.sources,
  });
}
if (args.probeLog) {
  const log = probeReport.results.map((r) => ({
    id: r.probe.id,
    kind: r.probe.kind,
    template: r.probe.template,
    outcome: r.outcome,
    reason: r.reason,
    steps: r.steps.map((s) => ({
      actor: s.step.actor,
      method: s.step.method,
      path: s.step.path,
      data: s.step.data,
      decision: s.decision,
      message: s.message,
    })),
  }));
  writeFileSync(args.probeLog, `${JSON.stringify(log, null, 2)}\n`);
}
const humanInputs: { what: string; why: string }[] = [];
if (args.presets.length) humanInputs.push({ what: '--preset', why: 'cli preset override' });
if (args.clientRoots.length) humanInputs.push({ what: '--client-root', why: 'cli client-root override' });
if (args.serverRoots.length) humanInputs.push({ what: '--server-root', why: 'cli server-root override' });
const result = {
  app: args.app ?? basename(resolve(args.root)),
  commit: pyricCommit(),
  humanInputs,
  accessSites: report.accessSites,
  ownerBindings: owners.ownerBindings,
  probes: probeReport.probes,
  findings: probeReport.findings.map((f) => ({
    path: f.path,
    op: f.op,
    kind: f.kind,
    status: f.status,
    evidence: f.evidence,
  })),
  extraction: {
    counts: report.counts,
    filesScanned: report.filesScanned,
    projects: report.projects,
    presets: presets.map((p) => p.name),
    ms: Date.now() - started,
  },
  rules: { sources: owners.ruleSources, conditions: owners.conditions.length, problems: owners.problems },
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (args.out) writeFileSync(args.out, json);
else process.stdout.write(json);
if (args.summary || args.out) {
  const strength = { strong: 0, tentative: 0 };
  for (const b of owners.ownerBindings) strength[b.strength] += 1;
  process.stderr.write(
    `${result.app}: ${JSON.stringify(report.counts)} files=${report.filesScanned} ms=${result.extraction.ms} ownerBindings=${JSON.stringify(strength)} ruleSources=${owners.ruleSources.map((r) => r.source).join(',')} probes=${JSON.stringify(probeReport.probes)} findings=${probeReport.findings.length}\n`,
  );
}
