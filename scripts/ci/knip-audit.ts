#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface KnipRawExportIssue {
  name: string;
  line?: number;
  col?: number;
  pos?: number;
}

export interface KnipRawDependencyIssue {
  name: string;
  packageJsonPath?: string;
}

export interface KnipRawFileIssue {
  file: string;
  files?: Array<{ name: string }>;
  dependencies?: KnipRawDependencyIssue[];
  devDependencies?: KnipRawDependencyIssue[];
  optionalPeerDependencies?: KnipRawDependencyIssue[];
  exports?: KnipRawExportIssue[];
  types?: KnipRawExportIssue[];
  duplicates?: unknown[];
}

export interface KnipRawReport {
  issues: KnipRawFileIssue[];
}

export interface NormalizedFinding {
  type:
    | 'unused-file'
    | 'unused-dependency'
    | 'unused-dev-dependency'
    | 'unused-export'
    | 'unused-type';
  file: string;
  name: string;
  packageJsonPath?: string;
  line?: number;
  col?: number;
}

export interface CategorizedFindings {
  prFindings: NormalizedFinding[];
  legacyFindings: NormalizedFinding[];
  isPrContext: boolean;
}

export function normalizePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/');
  const root = process.cwd().replace(/\\/g, '/');
  if (normalized.startsWith(root + '/')) {
    normalized = normalized.slice(root.length + 1);
  }
  return normalized.replace(/^\.\//, '');
}

function resolveFindingPath(explicitPath: string | undefined, defaultPath: string): string {
  if (explicitPath) {
    return normalizePath(explicitPath);
  }
  return defaultPath;
}

export function parseKnipReport(report: KnipRawReport): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  for (const rawItem of report.issues || []) {
    const itemFile = normalizePath(rawItem.file || '');

    for (const f of rawItem.files || []) {
      const filePath = normalizePath(f.name);
      findings.push({
        type: 'unused-file',
        file: filePath,
        name: filePath,
      });
    }

    for (const dep of rawItem.dependencies || []) {
      const pkgPath = resolveFindingPath(dep.packageJsonPath, itemFile);
      findings.push({
        type: 'unused-dependency',
        file: pkgPath,
        name: dep.name,
        packageJsonPath: pkgPath,
      });
    }

    for (const dep of rawItem.devDependencies || []) {
      const pkgPath = resolveFindingPath(dep.packageJsonPath, itemFile);
      findings.push({
        type: 'unused-dev-dependency',
        file: pkgPath,
        name: dep.name,
        packageJsonPath: pkgPath,
      });
    }

    for (const dep of rawItem.optionalPeerDependencies || []) {
      const pkgPath = resolveFindingPath(dep.packageJsonPath, itemFile);
      findings.push({
        type: 'unused-dependency',
        file: pkgPath,
        name: dep.name,
        packageJsonPath: pkgPath,
      });
    }

    for (const exp of rawItem.exports || []) {
      findings.push({
        type: 'unused-export',
        file: itemFile,
        name: exp.name,
        line: exp.line,
        col: exp.col,
      });
    }

    for (const exp of rawItem.types || []) {
      findings.push({
        type: 'unused-type',
        file: itemFile,
        name: exp.name,
        line: exp.line,
        col: exp.col,
      });
    }
  }
  return findings;
}

export function categorizeFindings(
  findings: readonly NormalizedFinding[],
  changedPaths: readonly string[],
  isPrContext: boolean
): CategorizedFindings {
  if (!isPrContext || changedPaths.length === 0) {
    return {
      prFindings: [],
      legacyFindings: [...findings],
      isPrContext,
    };
  }

  const changedSet = new Set(changedPaths.map((p) => normalizePath(p)));
  const prFindings: NormalizedFinding[] = [];
  const legacyFindings: NormalizedFinding[] = [];

  for (const finding of findings) {
    const matchesFile = changedSet.has(finding.file);
    const matchesPkg = finding.packageJsonPath ? changedSet.has(finding.packageJsonPath) : false;

    if (matchesFile || matchesPkg) {
      prFindings.push(finding);
    } else {
      legacyFindings.push(finding);
    }
  }

  return {
    prFindings,
    legacyFindings,
    isPrContext,
  };
}

export function formatMarkdownReport(categorized: CategorizedFindings): string {
  const { prFindings, legacyFindings, isPrContext } = categorized;
  const lines: string[] = ['## ✂️ Advisory Knip Audit', ''];

  if (isPrContext) {
    if (prFindings.length === 0) {
      lines.push('✅ **No unused code or dependencies introduced in PR changes.**');
      lines.push('');
    } else {
      lines.push(`⚠️ **${prFindings.length} advisory finding(s) detected in PR changes (non-blocking):**`);
      lines.push('');

      const unusedDeps = prFindings.filter(
        (f) => f.type === 'unused-dependency' || f.type === 'unused-dev-dependency'
      );
      if (unusedDeps.length > 0) {
        lines.push('### Unused Dependencies in PR');
        lines.push('| Package Manifest | Dependency | Dependency Type |');
        lines.push('| --- | --- | --- |');
        for (const dep of unusedDeps) {
          const kind = dep.type === 'unused-dev-dependency' ? 'devDependencies' : 'dependencies';
          lines.push(`| \`${dep.file}\` | \`${dep.name}\` | ${kind} |`);
        }
        lines.push('');
      }

      const unusedFiles = prFindings.filter((f) => f.type === 'unused-file');
      if (unusedFiles.length > 0) {
        lines.push('### Unused Files in PR');
        lines.push('| File |');
        lines.push('| --- |');
        for (const fileItem of unusedFiles) {
          lines.push(`| \`${fileItem.file}\` |`);
        }
        lines.push('');
      }

      const unusedExports = prFindings.filter(
        (f) => f.type === 'unused-export' || f.type === 'unused-type'
      );
      if (unusedExports.length > 0) {
        lines.push('### Unused Exports & Types in PR');
        lines.push('| File | Symbol | Location | Kind |');
        lines.push('| --- | --- | --- | --- |');
        for (const exp of unusedExports) {
          const location = exp.line !== undefined ? `line ${exp.line}` : '-';
          const kind = exp.type === 'unused-type' ? 'type' : 'export';
          lines.push(`| \`${exp.file}\` | \`${exp.name}\` | ${location} | ${kind} |`);
        }
        lines.push('');
      }
    }
  } else {
    const totalCount = prFindings.length + legacyFindings.length;
    lines.push(`ℹ️ **Workspace Audit Summary (${totalCount} total findings across workspace)**`);
    lines.push('');
  }

  // Pre-existing / Workspace Legacy Debt Breakdown
  const legacyFileCount = new Set(legacyFindings.map((f) => f.file)).size;
  const legacyUnusedFiles = legacyFindings.filter((f) => f.type === 'unused-file').length;
  const legacyUnusedDeps = legacyFindings.filter(
    (f) => f.type === 'unused-dependency' || f.type === 'unused-dev-dependency'
  ).length;
  const legacyUnusedExports = legacyFindings.filter(
    (f) => f.type === 'unused-export' || f.type === 'unused-type'
  ).length;

  lines.push('<details>');
  lines.push(
    `<summary><b>Workspace Baseline Debt (${isPrContext ? 'filtered out of PR check' : 'all findings'}): ${legacyFileCount} files with findings</b></summary>`
  );
  lines.push('');
  lines.push(`- **Unused files:** ${legacyUnusedFiles}`);
  lines.push(`- **Unused dependencies:** ${legacyUnusedDeps}`);
  lines.push(`- **Unused exports & types:** ${legacyUnusedExports}`);
  lines.push('');
  lines.push('*Pre-existing legacy debt in unchanged files is non-blocking.*');
  lines.push('</details>');
  lines.push('');
  lines.push('---');
  lines.push('*Note: This audit is strictly advisory and non-blocking. It will not fail PR builds or block merges.*');

  return lines.join('\n');
}

export function getChangedPathsFromGit(): { paths: string[]; isPrContext: boolean } {
  const eventName = process.env.CI_EVENT_NAME || process.env.GITHUB_EVENT_NAME;
  const baseSha = process.env.CI_BASE_SHA || process.env.GITHUB_BASE_SHA;
  const headSha = process.env.CI_HEAD_SHA || process.env.GITHUB_HEAD_SHA;
  const isCiPr = eventName === 'pull_request' || (Boolean(baseSha) && Boolean(headSha));

  if (baseSha && headSha) {
    try {
      const output = execFileSync(
        'git',
        ['diff', '--name-status', '-z', '--find-renames', `${baseSha}...${headSha}`],
        { encoding: 'utf8' }
      );
      const fields = output.split('\0');
      if (fields.at(-1) === '') fields.pop();
      const paths: string[] = [];
      for (let i = 0; i < fields.length; ) {
        const status = fields[i++];
        if (!status) break;
        if (status.startsWith('R') || status.startsWith('C')) {
          const prev = fields[i++];
          const curr = fields[i++];
          if (curr) paths.push(curr);
          if (prev) paths.push(prev);
        } else {
          const curr = fields[i++];
          if (curr) paths.push(curr);
        }
      }
      return { paths, isPrContext: isCiPr };
    } catch {
      // Fall through to git diff fallback
    }
  }

  // Fallback git diff if in local branch against origin/main or main
  try {
    const output = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], {
      encoding: 'utf8',
    });
    const paths = output.split('\n').filter((p) => p.trim().length > 0);
    return { paths, isPrContext: isCiPr || paths.length > 0 };
  } catch {
    return { paths: [], isPrContext: isCiPr };
  }
}

export function runKnipAudit(): string {
  let stdout = '';
  try {
    stdout = execFileSync('bun', ['x', 'knip', '--reporter', 'json'], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string') {
      stdout = err.stdout;
    } else {
      throw new Error(`Failed to execute Knip: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let rawReport: KnipRawReport;
  try {
    rawReport = JSON.parse(stdout) as KnipRawReport;
  } catch {
    throw new Error('Failed to parse Knip JSON output');
  }

  const findings = parseKnipReport(rawReport);
  const { paths: changedPaths, isPrContext } = getChangedPathsFromGit();
  const categorized = categorizeFindings(findings, changedPaths, isPrContext);

  return formatMarkdownReport(categorized);
}

function main(): void {
  let reportMarkdown: string;
  try {
    reportMarkdown = runKnipAudit();
    console.log(reportMarkdown);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    reportMarkdown = [
      '## ✂️ Advisory Knip Audit',
      '',
      `⚠️ Advisory audit step encountered an error: ${errorMsg}`,
      '',
      '---',
      '*Note: This check is strictly advisory and non-blocking.*',
    ].join('\n');
    console.error('Knip audit error:', err);
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, reportMarkdown + '\n');
  }

  // Always exit code 0 so CI build pipeline is never blocked
  process.exit(0);
}

if (import.meta.main) {
  main();
}
