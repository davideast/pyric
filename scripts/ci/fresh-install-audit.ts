/**
 * Parsing, formatting, and failure gating for `npm audit --json` in the
 * nightly fresh-install run (`scripts/ci/fresh-install.ts`).
 */
import { UPSTREAM_ADVISORIES } from './upstream-advisories.ts';

/**
 * The line npm's audit prints at the end of `npm install`: `found 0
 * vulnerabilities`, or `3 moderate severity vulnerabilities`, or
 * `7 vulnerabilities (2 low, 5 moderate)`.
 */
const AUDIT_SUMMARY = /^(?:found \d+ vulnerabilit(?:y|ies)|\d+ (?:\w+ severity )?vulnerabilit(?:y|ies)\b.*)$/;

export function auditSummary(installOutput: string): string | undefined {
  return installOutput.split('\n').map((line) => line.trim()).find((line) => AUDIT_SUMMARY.test(line));
}

export function auditNote(installOutput: string | undefined): string[] {
  if (installOutput === undefined) {
    return [];
  }
  const summary = auditSummary(installOutput);
  if (summary === undefined) {
    return ['npm audit: npm install printed no audit summary'];
  }
  return [`npm audit: ${summary}`];
}

/** One `npm audit --json` run: its exit code and stdout and stderr as one stream, or why it did not finish. */
export interface AuditRun {
  code: number | null;
  output: string;
  /** Set when the command threw or timed out instead of exiting. */
  error?: string;
}

export interface AuditVerdict {
  failing: string[];
  allowed: string[];
}

interface AuditAdvisory {
  severity: string;
  name: string;
  id: string;
  /** Where the vulnerable package is installed, such as `node_modules/shadcn/node_modules/undici`. */
  nodes: string[];
}

type AuditReading = { advisories: AuditAdvisory[] } | { problem: string };

const NOTED_SEVERITIES = ['critical', 'high'];
const AUDIT_NOTE = 'npm audit --json';
/** The most install locations one advisory line lists. */
const LISTED_NODES = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The JSON document in `output`: from the first line that starts with `{` to
 * the last that ends with `}`. npm writes it to stdout, and its `npm warn` and
 * `npm error` lines may come before or after it on the same stream.
 */
function auditJsonText(output: string): string | undefined {
  const lines = output.split('\n').map((line) => line.trim());
  const first = lines.findIndex((line) => line.startsWith('{'));
  const last = lines.findLastIndex((line) => line.endsWith('}'));
  if (first === -1 || last < first) {
    return undefined;
  }
  return lines.slice(first, last + 1).join('\n');
}

/** Canonical GitHub advisory casing (`GHSA-xxxx-xxxx-xxxx`) so matching and dedup are case-stable. */
function normalizeGhsaId(raw: string): string {
  return `GHSA-${raw.slice(5).toLowerCase()}`;
}

/** GitHub's advisory id from the advisory URL, else npm's numeric source id. */
function advisoryId(via: Record<string, unknown>): string {
  if (typeof via.url === 'string') {
    const match = /GHSA(?:-[a-z0-9]{4}){3}/i.exec(via.url);
    if (match !== null) {
      return normalizeGhsaId(match[0]);
    }
  }
  if (typeof via.source === 'number') {
    return `advisory ${via.source}`;
  }
  return '(no advisory id)';
}

/**
 * The advisories a vulnerable package lists in `via`. A string entry names
 * another vulnerable package (npm's metavuln), whose own entry lists the advisory.
 */
function packageAdvisories(key: string, entry: unknown): AuditAdvisory[] {
  if (!isRecord(entry) || !Array.isArray(entry.via)) {
    return [];
  }
  let nodes: string[] = [];
  if (Array.isArray(entry.nodes)) {
    nodes = entry.nodes.filter((node): node is string => typeof node === 'string');
  }
  return entry.via.filter(isRecord).map((via) => {
    let severity = 'unknown';
    if (typeof via.severity === 'string') {
      severity = via.severity.toLowerCase();
    }
    let name = key;
    if (typeof via.name === 'string') {
      name = via.name;
    }
    return {
      severity,
      name,
      id: advisoryId(via),
      nodes,
    };
  });
}

/** A string with something in it, trimmed. */
function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  if (text === '') {
    return undefined;
  }
  return text;
}

function joinedParts(parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part) => part !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  return present.join(': ');
}

/**
 * What npm's error object says: `{"error":{"code":"ENOLOCK","summary":"..."}}`
 * reads `npm error ENOLOCK: ...`. Undefined when it names neither.
 */
function npmErrorText(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const named = joinedParts([nonEmptyText(error.code), nonEmptyText(error.summary)]);
  if (named === undefined) {
    return undefined;
  }
  return `npm error ${named}`;
}

/** Why a JSON object with no vulnerabilities is not a report: npm's message and its error object. */
function npmProblem(report: Record<string, unknown>): string | undefined {
  return joinedParts([nonEmptyText(report.message), npmErrorText(report.error)]);
}

function compareAdvisories(a: AuditAdvisory, b: AuditAdvisory): number {
  const severity = NOTED_SEVERITIES.indexOf(a.severity) - NOTED_SEVERITIES.indexOf(b.severity);
  if (severity !== 0) {
    return severity;
  }
  const name = a.name.localeCompare(b.name);
  if (name !== 0) {
    return name;
  }
  return a.id.localeCompare(b.id);
}

/** Reads `npm audit --json` (report version 2) output; never throws. */
function readAudit(output: string): AuditReading {
  const text = auditJsonText(output);
  if (text === undefined) {
    return { problem: 'npm printed no JSON' };
  }
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return { problem: 'npm printed JSON that does not parse' };
  }
  if (!isRecord(report)) {
    return { problem: 'the JSON is not an object' };
  }
  if (report.vulnerabilities === undefined) {
    const npmSaid = npmProblem(report);
    if (npmSaid !== undefined) {
      return { problem: npmSaid };
    }
  }
  if (!isRecord(report.vulnerabilities)) {
    return { problem: 'the JSON has no vulnerabilities object' };
  }
  const seen = new Set<string>();
  const advisories = Object.entries(report.vulnerabilities)
    .flatMap(([key, entry]) => packageAdvisories(key, entry))
    .filter((advisory) => NOTED_SEVERITIES.includes(advisory.severity))
    .filter((advisory) => {
      const key = `${advisory.name} ${advisory.id}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  return { advisories: advisories.sort(compareAdvisories) };
}

/** `at a, b, c and 2 more`: where npm installed the vulnerable package, so a reader can tell what brings it in. */
function nodesText(nodes: string[]): string | undefined {
  if (nodes.length === 0) {
    return undefined;
  }
  const more = nodes.length - LISTED_NODES;
  const listed = nodes.slice(0, LISTED_NODES).join(', ');
  if (more > 0) {
    return `at ${listed} and ${more} more`;
  }
  return `at ${listed}`;
}

function upstreamAdvisoryReason(
  id: string,
  upstreamAdvisories: Readonly<Record<string, string>>,
): string | undefined {
  if (!Object.hasOwn(upstreamAdvisories, id)) {
    return undefined;
  }
  return nonEmptyText(upstreamAdvisories[id]);
}

function advisoryBaseNote({ severity, name, id, nodes }: AuditAdvisory): string {
  const location = nodesText(nodes);
  if (location === undefined) {
    return `${AUDIT_NOTE}: ${severity} ${name} ${id}`;
  }
  return `${AUDIT_NOTE}: ${severity} ${name} ${id} ${location}`;
}

function advisoryNote(
  advisory: AuditAdvisory,
  upstreamAdvisories: Readonly<Record<string, string>>,
): string {
  const base = advisoryBaseNote(advisory);
  const reason = upstreamAdvisoryReason(advisory.id, upstreamAdvisories);
  if (reason === undefined) {
    return base;
  }
  return `${base} (upstream: ${reason})`;
}

/** The first line of a command's error, without the output a timeout message carries after it. */
function errorHeadline(error: string): string {
  const line = error.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? '';
  return line.replace(/:$/, '');
}

/**
 * One line per high or critical advisory `npm audit --json` reported: its
 * severity, package, advisory id and install locations, and the reason when
 * the advisory is known upstream and unreachable. A run with no report, or
 * one that did not finish, gets one line saying so.
 */
export function auditAdvisoryNotes(
  run: AuditRun | undefined,
  upstreamAdvisories: Readonly<Record<string, string>> = UPSTREAM_ADVISORIES,
): string[] {
  if (run === undefined) {
    return [];
  }
  if (run.error !== undefined) {
    return [`${AUDIT_NOTE}: did not finish: ${errorHeadline(run.error)}`];
  }
  const reading = readAudit(run.output);
  if ('problem' in reading) {
    return [`${AUDIT_NOTE}: no report (exit ${run.code}): ${reading.problem}`];
  }
  if (reading.advisories.length === 0) {
    return [`${AUDIT_NOTE}: no high or critical advisory`];
  }
  return reading.advisories.map((advisory) => advisoryNote(advisory, upstreamAdvisories));
}

/**
 * Evaluates the fresh-install high/critical advisory gate for one template's
 * `npm audit --json` run. Every unallowlisted high or critical advisory fails,
 * as does an audit that failed to finish or produced no valid JSON report.
 * Advisories named in `upstreamAdvisories` are listed in `allowed` instead.
 */
export function auditAdvisoryFindings(
  run: AuditRun | undefined,
  upstreamAdvisories: Readonly<Record<string, string>> = UPSTREAM_ADVISORIES,
): AuditVerdict {
  if (run === undefined) {
    return { failing: [], allowed: [] };
  }
  if (run.error !== undefined) {
    return {
      failing: [`${AUDIT_NOTE}: did not finish: ${errorHeadline(run.error)}`],
      allowed: [],
    };
  }
  const reading = readAudit(run.output);
  if ('problem' in reading) {
    return {
      failing: [`${AUDIT_NOTE}: no report (exit ${run.code}): ${reading.problem}`],
      allowed: [],
    };
  }
  const failing: string[] = [];
  const allowed: string[] = [];
  for (const advisory of reading.advisories) {
    const base = advisoryBaseNote(advisory);
    const reason = upstreamAdvisoryReason(advisory.id, upstreamAdvisories);
    if (reason === undefined) {
      failing.push(base);
    } else {
      allowed.push(`allowed (${advisory.id}): ${base}; ${reason}`);
    }
  }
  return { failing, allowed };
}
