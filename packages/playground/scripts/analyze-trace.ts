#!/usr/bin/env bun
/**
 * Offline trace analyzer (EFF1) — turns the efficiency ledgers and/or a
 * trace-viewer JSON export into a markdown report with per-hypothesis
 * priors (H1 context integral, H2 payload outliers, H3 duplicate prompt,
 * H4 reasoning/deliberation, H5 simulate redundancy, H6 router provenance,
 * H7 write churn). Pure read — never runs the agent, never spends tokens.
 *
 * Usage:
 *   bun scripts/analyze-trace.ts                          # ledgers + records at default paths
 *   bun scripts/analyze-trace.ts --trace=export.json      # a trace-viewer export
 *   bun scripts/analyze-trace.ts --run=<runId>            # filter ledger rows to one run
 *   bun scripts/analyze-trace.ts --no-records             # skip the eval store
 *   flags: --request-ledger=path --tool-ledger=path --records=path --out=report.md
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  DEFAULT_REQUEST_LEDGER,
  DEFAULT_TOOL_LEDGER,
  readRequestRows,
  readToolRows,
} from '~/lib/experiment/efficiency-ledgers';
import { DEFAULT_STORE, readAllRecords } from '~/lib/experiment/metrics-store';
import { parseTraceExport, renderReport } from '~/lib/experiment/trace-analysis';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

const tracePath = flag('trace');
const requestLedgerPath = flag('request-ledger') ?? DEFAULT_REQUEST_LEDGER;
const toolLedgerPath = flag('tool-ledger') ?? DEFAULT_TOOL_LEDGER;
const recordsPath = flag('records') ?? DEFAULT_STORE;
const runFilter = flag('run');
const outPath = flag('out');
const skipRecords = argv.includes('--no-records');

let requestRows = readRequestRows(requestLedgerPath);
let toolRows = readToolRows(toolLedgerPath);
const bundles = tracePath ? parseTraceExport(readFileSync(tracePath, 'utf8')) : [];
let records = skipRecords || !existsSync(recordsPath) ? [] : readAllRecords(recordsPath);

if (runFilter) {
  requestRows = requestRows.filter((r) => r.runId.includes(runFilter));
  toolRows = toolRows.filter((r) => r.runId.includes(runFilter));
  records = records.filter((r) => r.runId.includes(runFilter));
}

const sourceBits = [
  ...(tracePath ? [`trace=${tracePath}`] : []),
  `request-ledger=${requestLedgerPath}`,
  `tool-ledger=${toolLedgerPath}`,
  ...(records.length > 0 ? [`records=${recordsPath}`] : []),
  ...(runFilter ? [`run~="${runFilter}"`] : []),
];

// SF-S0a: a one-line strategy/cadence provenance readout from the ledger's
// new `cadence` tag — how many iterations ran in each cadence, so a glance
// distinguishes draft-cadence vs react-cadence call volume.
const cadenceCounts = new Map<string, number>();
for (const r of requestRows) {
  const c = r.cadence ?? r.strategy ?? 'unknown';
  cadenceCounts.set(c, (cadenceCounts.get(c) ?? 0) + 1);
}
const provenanceLine =
  cadenceCounts.size > 0
    ? '## SF-S0a provenance — iterations by cadence\n\n' +
      [...cadenceCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cadence, n]) => `- \`${cadence}\`: ${n} iteration(s)`)
        .join('\n') +
      '\n'
    : '';

const report =
  provenanceLine +
  (provenanceLine ? '\n' : '') +
  renderReport({
    requestRows,
    toolRows,
    bundles,
    records,
    source: sourceBits.join(' · '),
  });

if (outPath) {
  writeFileSync(outPath, report, 'utf8');
  console.log(`wrote ${outPath}`);
} else {
  console.log(report);
}
