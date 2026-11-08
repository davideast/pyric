/**
 * Top-level access-site extraction: build programs for the app, run the
 * site collector over every scanned file with one evaluator per program,
 * and summarise.
 */
import type ts from 'typescript';
import { resolve } from 'node:path';
import { buildPrograms, iteratePrograms } from './program.js';
import { ReferenceIndex } from './references.js';
import { SdkTable } from './sdk-imports.js';
import { Evaluator } from './evaluator.js';
import { isWriteOp } from './operation-specs.js';
import { SiteCollector } from './sites.js';
import { mergeResults, type CollectorResult } from './specialization.js';
import { findEmbeddedRules, type EmbeddedRules } from './embedded-rules.js';
import type { AccessSite, AccessSiteCounts, AccessSiteReport, ExtractAccessSitesOptions } from './types.js';
import { isExcludedPath } from './program.js';
import { relative, sep } from 'node:path';

export function extractAccessSites(options: ExtractAccessSitesOptions): AccessSiteReport {
  const root = resolve(options.root);
  const presets = options.presets ?? [];
  const excludes = presets.flatMap((p) => p.exclude ?? []);
    const sdk = new SdkTable(presets);
  const results: CollectorResult[] = [];
  const embeddedRules: EmbeddedRules[] = [];
  let filesScanned = 0;
  
  const normRel = (p: string): string => relative(root, p).split(sep).join('/');
  const normRoot = (r: string): string => normRel(resolve(root, r));
  const clientPrefixes = (options.clientRoots ?? []).map(normRoot);
  const serverPrefixes = (options.serverRoots ?? []).map(normRoot);
  const matchesPrefix = (rel: string, prefix: string): boolean =>
    prefix === '' ? !rel.startsWith('..') : rel === prefix || rel.startsWith(`${prefix}/`);
  const isServer = (sf: import('typescript').SourceFile) => {
    const rel = normRel(sf.fileName);
    return serverPrefixes.some((sr) => matchesPrefix(rel, sr));
  };
  const isClientOwned = (sf: import('typescript').SourceFile) => {
    const rel = normRel(sf.fileName);
    if (serverPrefixes.some((sr) => matchesPrefix(rel, sr))) return false;
    if (clientPrefixes.length && !clientPrefixes.some((cr) => matchesPrefix(rel, cr))) return false;
    return true;
  };
  const isClientOwnedPath = (path: string) => {
    const rel = normRel(path);
    if (serverPrefixes.some((sr) => matchesPrefix(rel, sr))) return false;
    if (clientPrefixes.length && !clientPrefixes.some((cr) => matchesPrefix(rel, cr))) return false;
    return true;
  };

  const projects: string[] = [];
  for (const p of iteratePrograms(root, options.files, excludes, (rootNames: string[]) => rootNames.some(isClientOwnedPath))) {
    projects.push(p.config);
    const inProject = p.program.getSourceFiles().filter((sf: import('typescript').SourceFile) => isInProject(root, sf, excludes) && !isServer(sf));
    const clientFiles = p.files.filter(isClientOwned);
    if (clientFiles.length === 0) continue;
    const ev = new Evaluator(p.checker, new ReferenceIndex(p.checker, inProject), sdk);
    const collector = new SiteCollector(ev, root, options.includeReads ?? true);
    const owned = new Set(clientFiles);
    for (const sf of clientFiles) {
      collector.scanFile(sf, true);
    }
    for (const sf of inProject) {
      if (!owned.has(sf)) {
        collector.scanFile(sf, false);
      }
    }
    results.push(collector.finish());
    const gc = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun?.gc;
    if (gc) gc(false);

    embeddedRules.push(...findEmbeddedRules(ev, clientFiles, root));
    filesScanned += clientFiles.length;
  }
  const sites = mergeResults(results);
  sites.sort(compareSites);
  return {
    accessSites: sites,
    counts: countSites(sites),
    filesScanned,
    projects,
    embeddedRules,
  };
}

function isInProject(root: string, sf: ts.SourceFile, excludes: string[]): boolean {
  if (sf.isDeclarationFile || sf.fileName.includes('/node_modules/')) return false;
  const rel = relative(root, sf.fileName);
  if (rel.startsWith('..')) return false;
  return !isExcludedPath(rel, excludes);
}

function compareSites(a: AccessSite, b: AccessSite): number {
  const [fa, la] = splitSource(a.source);
  const [fb, lb] = splitSource(b.source);
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (la !== lb) return la - lb;
  if (a.op !== b.op) return a.op < b.op ? -1 : 1;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

function splitSource(source: string): [string, number] {
  const i = source.lastIndexOf(':');
  return [source.slice(0, i), Number(source.slice(i + 1))];
}

export function countSites(sites: AccessSite[]): AccessSiteCounts {
  const counts: AccessSiteCounts = { total: sites.length, writes: 0, reads: 0, resolved: 0, partial: 0, unresolved: 0 };
  for (const s of sites) {
    if (isWriteOp(s.op)) counts.writes += 1;
    else if (s.op === 'get' || s.op === 'query') counts.reads += 1;
    counts[s.resolution] += 1;
  }
  return counts;
}
