/**
 * Target-scoped `--rules` flag parsing and ruleset override loading for
 * `pyric verify --static` (`verify-static.ts`).
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  isDefaultDatabaseInstance,
  parseResourcePattern,
  type AssuranceService,
} from 'pyric/sandbox/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import {
  bundleRulesSource,
  parseRtdbRulesText,
  validateRulesSourceSyntax,
  type FirestoreRuleSource,
  type RtdbRuleSource,
  type RuleSources,
  type StorageRuleSource,
} from 'pyric/rules/internal/usage';
import { DEFAULT_BUCKET } from 'pyric/storage/internal';
import { defineOwn } from '../assurance/derive-campaign-state.js';
import {
  buildRuleSurfaceFromSources,
  type LoadedAssuranceProject,
} from '../assurance/derive-project.js';
import type { FlagValue } from './parse-args.js';

export function readStringValues(value: FlagValue | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
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
    if (/^(?:https?|wss?):\/\/\/?$/i.test(targetPart)) {
      return {
        ok: false,
        message: `empty target in --rules prefix '${rawPrefix}' in '${spec}'`,
      };
    }
    return { ok: true, value: { service: 'rtdb', target: targetPart } };
  }
  if (svcPart === 'storage') {
    if (!/^https?:\/\//i.test(targetPart)) {
      const stripped = targetPart.replace(/^gs:\/\//i, '').replace(/^\/+|\/+$/g, '');
      if (stripped.length === 0 || stripped.includes('/')) {
        return {
          ok: false,
          message: `invalid Storage bucket target '${targetPart}' in '${spec}'`,
        };
      }
    }
    return { ok: true, value: { service: 'storage', target: targetPart } };
  }
  return {
    ok: false,
    message: `unsupported --rules prefix '${rawPrefix}' in '${spec}'`,
  };
}

function isWithinRootDir(baseDir: string, targetPath: string): boolean {
  const rel = relative(baseDir, targetPath);
  if (rel === '') return true;
  if (rel === '..') return false;
  if (
    rel.startsWith(`..${sep}`)
    || rel.startsWith('../')
    || rel.startsWith('..\\')
  ) {
    return false;
  }
  return !isAbsolute(rel);
}

function resolveContainedOverrideFile(
  realRoot: string,
  lexicalRoot: string | undefined,
  cwd: string,
  fileArg: string,
): { ok: true; realFile: string } | { ok: false; message: string } {
  const absFile = resolve(cwd, fileArg);
  let relInsideProject: string;
  if (isWithinRootDir(realRoot, absFile)) {
    relInsideProject = relative(realRoot, absFile);
  } else if (lexicalRoot !== undefined && isWithinRootDir(lexicalRoot, absFile)) {
    relInsideProject = relative(lexicalRoot, absFile);
  } else {
    return { ok: false, message: `rules path escapes project root: ${fileArg}` };
  }

  const canonicalCandidate = resolve(realRoot, relInsideProject);
  if (!isWithinRootDir(realRoot, canonicalCandidate)) {
    return { ok: false, message: `rules path escapes project root: ${fileArg}` };
  }

  const segments = relInsideProject
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
  let current = realRoot;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = join(current, segments[i]!);
    let ancStat: ReturnType<typeof lstatSync>;
    try {
      ancStat = lstatSync(current);
    } catch {
      break;
    }
    if (ancStat.isSymbolicLink()) {
      return {
        ok: false,
        message: `rules path must not traverse symbolic links: ${fileArg}`,
      };
    }
    const realAnc = realpathSync(current);
    if (!isWithinRootDir(realRoot, realAnc)) {
      return { ok: false, message: `rules path escapes project root: ${fileArg}` };
    }
  }

  let leafStat: ReturnType<typeof lstatSync>;
  try {
    leafStat = lstatSync(canonicalCandidate);
  } catch {
    if (!existsSync(canonicalCandidate)) {
      return { ok: false, message: `rules file does not exist: ${fileArg}` };
    }
    return {
      ok: false,
      message: `rules path must be a regular non-symlink file: ${fileArg}`,
    };
  }
  if (leafStat.isSymbolicLink() || !leafStat.isFile()) {
    return {
      ok: false,
      message: `rules path must be a regular non-symlink file: ${fileArg}`,
    };
  }
  const realLeaf = realpathSync(canonicalCandidate);
  if (!isWithinRootDir(realRoot, realLeaf)) {
    return { ok: false, message: `rules path escapes project root: ${fileArg}` };
  }
  return { ok: true, realFile: realLeaf };
}

export function applyRulesFlagOverrides(
  project: LoadedAssuranceProject,
  rawRules: FlagValue | undefined,
  cwd: string,
  lexicalProjectRoot?: string,
): { ok: true; project: LoadedAssuranceProject } | { ok: false; message: string } {
  const specs = readStringValues(rawRules);
  if (specs.length === 0) return { ok: true, project };

  let firestore: FirestoreRuleSource[] = [...project.sources.firestore];
  let rtdb: RtdbRuleSource[] = [...project.sources.rtdb];
  const existingStorage = project.sources.storage ?? [];
  let storage: StorageRuleSource[] = [...existingStorage];
  const configuredBuckets = [...project.configuredBuckets];
  const rtdbInstances: Record<string, { rules: Record<string, unknown> }> = {};
  for (const [instId, instRules] of Object.entries(project.rtdbInstances)) {
    defineOwn(rtdbInstances, instId, instRules);
  }

  const defaultBucketAliases = new Set<string>([
    DEFAULT_SNAPSHOT_RESOURCE,
    DEFAULT_BUCKET,
  ]);
  if (project.defaultBucket !== undefined) {
    defaultBucketAliases.add(project.defaultBucket);
  }
  if (project.projectId !== undefined) {
    const fbAppBucket = `${project.projectId}.firebasestorage.app`;
    const appspotBucket = `${project.projectId}.appspot.com`;
    const bothConfigured =
      project.configuredBuckets.includes(fbAppBucket)
      && project.configuredBuckets.includes(appspotBucket);
    if (!bothConfigured) {
      defaultBucketAliases.add(fbAppBucket);
      defaultBucketAliases.add(appspotBucket);
    }
  }
  const overriddenTargets = new Set<string>();
  const defaultRtdbSuffixRe = /^[a-z0-9-]+-default-rtdb$/i;
  const normalizeOverrideTarget = (
    service: AssuranceService,
    rawTarget: string | undefined,
  ): string => {
    if (rawTarget === undefined) return DEFAULT_SNAPSHOT_RESOURCE;
    const trimmed = rawTarget.trim();
    if (
      trimmed.length === 0
      || trimmed === DEFAULT_SNAPSHOT_RESOURCE
      || trimmed === 'default'
    ) {
      return DEFAULT_SNAPSHOT_RESOURCE;
    }
    if (service === 'storage') {
      let bucketId: string;
      if (/^https?:\/\//i.test(trimmed)) {
        bucketId = parseResourcePattern('storage', trimmed).resourceId;
      } else {
        bucketId = trimmed.replace(/^gs:\/\//i, '').replace(/^\/+|\/+$/g, '');
      }
      if (
        bucketId.length === 0
        || bucketId === DEFAULT_SNAPSHOT_RESOURCE
        || bucketId === 'default'
        || bucketId === 'pyric-default'
        || bucketId === 'default-bucket'
        || bucketId === DEFAULT_BUCKET
      ) {
        return DEFAULT_SNAPSHOT_RESOURCE;
      }
      return bucketId;
    }
    if (service === 'rtdb') {
      const instId = parseResourcePattern('rtdb', 'ref', trimmed).resourceId;
      if (
        instId === DEFAULT_SNAPSHOT_RESOURCE
        || instId === 'default'
        || isDefaultDatabaseInstance(instId, project.projectId)
        || (project.projectId === undefined && defaultRtdbSuffixRe.test(instId))
      ) {
        return DEFAULT_SNAPSHOT_RESOURCE;
      }
      return instId;
    }
    return trimmed;
  };

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

    let realRoot = resolve(project.root);
    try {
      realRoot = realpathSync(realRoot);
    } catch {
      realRoot = resolve(project.root);
    }
    let resolvedLexicalRoot: string | undefined;
    if (lexicalProjectRoot !== undefined) {
      resolvedLexicalRoot = resolve(lexicalProjectRoot);
    }
    const checkedFile = resolveContainedOverrideFile(
      realRoot,
      resolvedLexicalRoot,
      cwd,
      fileArg,
    );
    if (!checkedFile.ok) {
      return checkedFile;
    }
    const absFile = checkedFile.realFile;
    const content = readFileSync(absFile, 'utf8');
    const sourceLabel = relative(realRoot, absFile).split('\\').join('/') || fileArg;

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
          rootDir: realRoot,
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
      const effectiveTarget = normalizeOverrideTarget('firestore', targetId);
      overriddenTargets.add(`firestore:${effectiveTarget}`);
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
          rootDir: realRoot,
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
      const effectiveTarget = normalizeOverrideTarget('storage', targetId);
      const isDefaultOverride = defaultBucketAliases.has(effectiveTarget);
      overriddenTargets.add(`storage:${effectiveTarget}`);
      if (isDefaultOverride) {
        for (const alias of defaultBucketAliases) {
          overriddenTargets.add(`storage:${alias}`);
        }
      }
      const entry: StorageRuleSource = { source: sourceLabel, text: bundledText };
      if (effectiveTarget !== DEFAULT_SNAPSHOT_RESOURCE) {
        entry.bucket = effectiveTarget;
        if (configuredBuckets.length > 0 && !configuredBuckets.includes(effectiveTarget)) {
          configuredBuckets.push(effectiveTarget);
        }
      }
      storage = storage.filter((s) => {
        const existingTarget = s.bucket ?? DEFAULT_SNAPSHOT_RESOURCE;
        if (isDefaultOverride && defaultBucketAliases.has(existingTarget)) {
          return false;
        }
        return existingTarget !== effectiveTarget;
      });
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
      const rtdbRejection = rtdbRulesSourceRejection(parsedRtdb);
      if (rtdbRejection !== null) {
        return {
          ok: false,
          message: `invalid RTDB rules in ${fileArg}: ${rtdbRejection.message}`,
        };
      }
      const effectiveTarget = normalizeOverrideTarget('rtdb', targetId);
      overriddenTargets.add(`rtdb:${effectiveTarget}`);
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

  const remainingConfigProblems = (project.configProblems ?? []).filter((p) => {
    if (p.isGlobalConfig === true || p.service === undefined) return true;
    const resId = p.resourceId ?? DEFAULT_SNAPSHOT_RESOURCE;
    return !overriddenTargets.has(`${p.service}:${resId}`);
  });
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
