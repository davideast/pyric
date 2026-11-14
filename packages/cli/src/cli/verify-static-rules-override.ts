/**
 * Target-scoped `--rules` flag parsing and ruleset override loading for
 * `pyric verify --static` (`verify-static.ts`).
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  isDefaultDatabaseInstance,
  parseResourcePattern,
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

export function applyRulesFlagOverrides(
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
      overriddenTargets.add(`storage:${effectiveTarget}`);
      if (project.defaultBucket !== undefined) {
        if (effectiveTarget === DEFAULT_SNAPSHOT_RESOURCE) {
          overriddenTargets.add(`storage:${project.defaultBucket}`);
        } else if (effectiveTarget === project.defaultBucket) {
          overriddenTargets.add(`storage:${DEFAULT_SNAPSHOT_RESOURCE}`);
        }
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
