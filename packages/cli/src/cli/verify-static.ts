/**
 * `pyric verify --static` CLI handler:
 * runs Tri-Source static assurance passes (`staticQueryProofPass`,
 * `storageContractPass`, `checkRtdbIndexes`, and `coverageMatrixPass`)
 * against project code and security rules before any runtime capture exists.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  parseResourcePattern,
  type AssuranceDiagnostic,
  type AssuranceService,
} from 'pyric/sandbox/internal';
import {
  bundleRulesSource,
  parseRtdbRulesText,
  validateRulesSourceSyntax,
  type FirestoreRuleSource,
  type RtdbRuleSource,
  type RuleSources,
  type StorageRuleSource,
} from 'pyric/rules/internal/usage';
import { defineOwn } from '../assurance/derive-campaign-state.js';
import {
  runStaticAssurancePasses,
  summarizeDiagnosticCounts,
} from '../assurance/derive.js';
import {
  buildRuleSurfaceFromSources,
  loadAssuranceProject,
  resolveDeriveRoot,
  type LoadedAssuranceProject,
} from '../assurance/derive-project.js';
import {
  formatAssuranceDiagnosticsText,
  readBooleanFlag,
  resolveFailGate,
} from './assurance.js';
import { findMissingValueFlag, type FlagValue, type ParsedArgs } from './parse-args.js';

export interface VerifyStaticCliDeps {
  readonly cwd?: string;
  readonly stdout?: { write(s: string): void };
  readonly stderr?: { write(s: string): void };
}

function readStringValues(value: FlagValue | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function parseServiceFilter(
  rawService: FlagValue | undefined,
): { ok: true; services?: ReadonlySet<AssuranceService> } | { ok: false; message: string } {
  const tokens = readStringValues(rawService)
    .flatMap((part) => part.split(','))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (tokens.length === 0) return { ok: true };

  const selected = new Set<AssuranceService>();
  for (const token of tokens) {
    if (token === 'firestore') {
      selected.add('firestore');
    } else if (token === 'rtdb' || token === 'database') {
      selected.add('rtdb');
    } else if (token === 'storage') {
      selected.add('storage');
    } else {
      return {
        ok: false,
        message: `unknown --service '${token}'; expected firestore, rtdb, database, or storage`,
      };
    }
  }
  return { ok: true, services: selected };
}

interface ParsedRulesPrefix {
  readonly service: AssuranceService;
  readonly target?: string;
}

function parseRulesPrefix(
  rawPrefix: string,
  spec: string,
): { ok: true; value: ParsedRulesPrefix } | { ok: false; message: string } {
  const colon = rawPrefix.indexOf(':');
  if (colon < 0) {
    const lower = rawPrefix.toLowerCase();
    if (lower === 'firestore') return { ok: true, value: { service: 'firestore' } };
    if (lower === 'rtdb' || lower === 'database') return { ok: true, value: { service: 'rtdb' } };
    if (lower === 'storage') return { ok: true, value: { service: 'storage' } };
    return {
      ok: false,
      message: `unsupported --rules prefix '${rawPrefix}' in '${spec}'`,
    };
  }
  const svcPart = rawPrefix.slice(0, colon).trim().toLowerCase();
  const targetPart = rawPrefix.slice(colon + 1).trim();
  if (targetPart.length === 0) {
    return {
      ok: false,
      message: `empty target in --rules prefix '${rawPrefix}' in '${spec}'`,
    };
  }
  if (svcPart === 'firestore') {
    return { ok: true, value: { service: 'firestore', target: targetPart } };
  }
  if (svcPart === 'rtdb' || svcPart === 'database') {
    const instanceId = parseResourcePattern('rtdb', 'ref', targetPart).resourceId;
    return { ok: true, value: { service: 'rtdb', target: instanceId } };
  }
  if (svcPart === 'storage') {
    const bucketId = parseResourcePattern('storage', 'object', targetPart).resourceId;
    return { ok: true, value: { service: 'storage', target: bucketId } };
  }
  return {
    ok: false,
    message: `unsupported --rules prefix '${rawPrefix}' in '${spec}'`,
  };
}

function applyRulesFlagOverrides(
  project: LoadedAssuranceProject,
  rawRules: FlagValue | undefined,
  cwd: string,
): { ok: true; project: LoadedAssuranceProject } | { ok: false; message: string } {
  const specs = readStringValues(rawRules);
  if (specs.length === 0) return { ok: true, project };

  let firestore: FirestoreRuleSource[] = [...project.sources.firestore];
  let rtdb: RtdbRuleSource[] = [...project.sources.rtdb];
  let storage: StorageRuleSource[] = [...(project.sources.storage ?? [])];
  const configuredBuckets = [...project.configuredBuckets];
  const rtdbInstances: Record<string, { rules: Record<string, unknown> }> = {};
  for (const [instId, instRules] of Object.entries(project.rtdbInstances)) {
    defineOwn(rtdbInstances, instId, instRules);
  }

  const overriddenDefaultServices = new Set<AssuranceService>();

  for (const spec of specs) {
    const eq = spec.indexOf('=');
    let targetService: AssuranceService | undefined;
    let targetId: string | undefined;
    let fileArg = spec;
    if (eq > 0) {
      const rawPrefix = spec.slice(0, eq).trim();
      fileArg = spec.slice(eq + 1).trim();
      const parsedPrefix = parseRulesPrefix(rawPrefix, spec);
      if (!parsedPrefix.ok) return parsedPrefix;
      targetService = parsedPrefix.value.service;
      targetId = parsedPrefix.value.target;
    }

    const absFile = resolve(cwd, fileArg);
    if (!existsSync(absFile)) {
      return { ok: false, message: `rules file does not exist: ${fileArg}` };
    }
    const st = lstatSync(absFile);
    if (st.isSymbolicLink() || !st.isFile()) {
      return {
        ok: false,
        message: `rules path must be a regular non-symlink file: ${fileArg}`,
      };
    }
    const content = readFileSync(absFile, 'utf8');
    const sourceLabel = relative(project.root, absFile).split('\\').join('/') || fileArg;

    if (targetService === undefined) {
      if (fileArg.endsWith('.json')) targetService = 'rtdb';
      else if (content.includes('firebase.storage')) targetService = 'storage';
      else targetService = 'firestore';
    }

    if (targetService === 'firestore') {
      let bundledText: string;
      try {
        bundledText = bundleRulesSource(content, {
          filePath: absFile,
          sourceFile: sourceLabel,
          targetService: 'cloud.firestore',
        });
      } catch (err) {
        let msg = String(err);
        if (err instanceof Error) msg = err.message;
        return { ok: false, message: `invalid Firestore rules in ${fileArg}: ${msg}` };
      }
      const syntax = validateRulesSourceSyntax(bundledText, 'cloud.firestore', {
        sourceFile: sourceLabel,
        targetService: 'cloud.firestore',
      });
      if (!syntax.ok) {
        return { ok: false, message: `invalid Firestore rules in ${fileArg}: ${syntax.message}` };
      }
      const effectiveTarget = targetId ?? DEFAULT_SNAPSHOT_RESOURCE;
      if (effectiveTarget === DEFAULT_SNAPSHOT_RESOURCE) {
        overriddenDefaultServices.add('firestore');
      }
      const entry: FirestoreRuleSource = { source: sourceLabel, text: bundledText };
      if (effectiveTarget !== DEFAULT_SNAPSHOT_RESOURCE) {
        entry.database = effectiveTarget;
      }
      firestore = firestore.filter(
        (s) => (s.database ?? DEFAULT_SNAPSHOT_RESOURCE) !== effectiveTarget,
      );
      firestore.push(entry);
    } else if (targetService === 'storage') {
      let bundledText: string;
      try {
        bundledText = bundleRulesSource(content, {
          filePath: absFile,
          sourceFile: sourceLabel,
          targetService: 'firebase.storage',
        });
      } catch (err) {
        let msg = String(err);
        if (err instanceof Error) msg = err.message;
        return { ok: false, message: `invalid Storage rules in ${fileArg}: ${msg}` };
      }
      const syntax = validateRulesSourceSyntax(bundledText, 'firebase.storage', {
        sourceFile: sourceLabel,
        targetService: 'firebase.storage',
      });
      if (!syntax.ok) {
        return { ok: false, message: `invalid Storage rules in ${fileArg}: ${syntax.message}` };
      }
      const effectiveTarget = targetId ?? DEFAULT_SNAPSHOT_RESOURCE;
      if (effectiveTarget === DEFAULT_SNAPSHOT_RESOURCE) {
        overriddenDefaultServices.add('storage');
      }
      const entry: StorageRuleSource = { source: sourceLabel, text: bundledText };
      if (effectiveTarget !== DEFAULT_SNAPSHOT_RESOURCE) {
        entry.bucket = effectiveTarget;
        if (configuredBuckets.length > 0 && !configuredBuckets.includes(effectiveTarget)) {
          configuredBuckets.push(effectiveTarget);
        }
      }
      storage = storage.filter(
        (s) => (s.bucket ?? DEFAULT_SNAPSHOT_RESOURCE) !== effectiveTarget,
      );
      storage.push(entry);
    } else {
      let parsedRtdb: unknown;
      try {
        parsedRtdb = parseRtdbRulesText(content);
      } catch (err) {
        let msg = String(err);
        if (err instanceof Error) msg = err.message;
        return { ok: false, message: `invalid RTDB rules JSON in ${fileArg}: ${msg}` };
      }
      if (!parsedRtdb || typeof parsedRtdb !== 'object' || Array.isArray(parsedRtdb)) {
        return {
          ok: false,
          message: `invalid RTDB rules JSON in ${fileArg}: expected a JSON object`,
        };
      }
      const effectiveTarget = targetId ?? DEFAULT_SNAPSHOT_RESOURCE;
      if (effectiveTarget === DEFAULT_SNAPSHOT_RESOURCE) {
        overriddenDefaultServices.add('rtdb');
      }
      const entry: RtdbRuleSource = { source: sourceLabel, json: parsedRtdb };
      if (effectiveTarget !== DEFAULT_SNAPSHOT_RESOURCE) {
        entry.instance = effectiveTarget;
        if (parsedRtdb && typeof parsedRtdb === 'object' && Object.hasOwn(parsedRtdb, 'rules')) {
          const inner = (parsedRtdb as { rules?: unknown }).rules;
          if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            defineOwn(rtdbInstances, effectiveTarget, {
              rules: inner as Record<string, unknown>,
            });
          }
        }
      }
      rtdb = rtdb.filter(
        (s) => (s.instance ?? DEFAULT_SNAPSHOT_RESOURCE) !== effectiveTarget,
      );
      rtdb.push(entry);
    }
  }

  const remainingConfigProblems = (project.configProblems ?? []).filter(
    (p) =>
      p.isGlobalConfig === true
      || p.service === undefined
      || !overriddenDefaultServices.has(p.service),
  );
  const remainingProblems = remainingConfigProblems.map((p) => p.message);

  const nextSources: RuleSources = {
    firestore,
    rtdb,
    storage,
    problems: remainingProblems,
  };
  const nextSurface = buildRuleSurfaceFromSources(nextSources, rtdbInstances);
  return {
    ok: true,
    project: {
      ...project,
      sources: nextSources,
      ruleSurface: nextSurface,
      configuredBuckets,
      rtdbInstances,
      problems: remainingProblems,
      configProblems: remainingConfigProblems,
    },
  };
}

export async function runVerifyStatic(
  parsed: ParsedArgs,
  deps: VerifyStaticCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const missingFlag = findMissingValueFlag(parsed.flags, [
    'rules',
    'service',
    'root',
    'fail-on',
  ]);
  if (missingFlag !== undefined) {
    stderr.write(`pyric verify --static: missing value for --${missingFlag}\n`);
    return 2;
  }
  const json = readBooleanFlag(parsed.flags.get('json'));
  const includeHeuristic = readBooleanFlag(parsed.flags.get('include-heuristic'));

  const gate = resolveFailGate(parsed.flags.get('fail-on'), includeHeuristic);
  if (!gate.ok) {
    stderr.write(`pyric verify --static: ${gate.message}\n`);
    return 2;
  }

  const serviceFilter = parseServiceFilter(parsed.flags.get('service'));
  if (!serviceFilter.ok) {
    stderr.write(`pyric verify --static: ${serviceFilter.message}\n`);
    return 2;
  }

  const rootValues = readStringValues(parsed.flags.get('root'));
  let rawRoot = rootValues.at(-1);
  if (rawRoot === undefined && typeof parsed.positional[0] === 'string') {
    rawRoot = parsed.positional[0];
  }
  let targetRoot = cwd;
  if (rawRoot !== undefined && rawRoot.trim().length > 0) {
    targetRoot = resolve(cwd, rawRoot);
  }

  let absRoot: string;
  try {
    absRoot = resolveDeriveRoot(targetRoot, undefined);
  } catch (err) {
    let msg = String(err);
    if (err instanceof Error) msg = err.message;
    stderr.write(`pyric verify --static: ${msg}\n`);
    return 2;
  }

  const baseProject = loadAssuranceProject(absRoot);
  const overridden = applyRulesFlagOverrides(
    baseProject,
    parsed.flags.get('rules'),
    cwd,
  );
  if (!overridden.ok) {
    stderr.write(`pyric verify --static: ${overridden.message}\n`);
    return 2;
  }

  let diagnostics: AssuranceDiagnostic[] = runStaticAssurancePasses(
    overridden.project,
  );
  if (serviceFilter.services !== undefined) {
    const allowed = serviceFilter.services;
    diagnostics = diagnostics.filter(
      (d) =>
        allowed.has(d.service)
        || (d.code === 'invalid-rules-configuration'
          && d.ruleSite?.source === 'firebase.json'),
    );
  }

  const counts = summarizeDiagnosticCounts(diagnostics);
  const failing = diagnostics.some((d) => gate.matches(d));
  const ok = !failing;

  if (json) {
    stdout.write(`${JSON.stringify({ ok, counts, diagnostics }, null, 2)}\n`);
  } else {
    const sp = counts.byCertainty['static-proof'];
    const he = counts.byCertainty.heuristic;
    const header = `pyric verify --static: ${sp} static proof failure(s), ${he} heuristic hint(s)`;
    stdout.write(formatAssuranceDiagnosticsText(header, diagnostics));
  }

  if (failing) return 1;
  return 0;
}
