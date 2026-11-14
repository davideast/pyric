/**
 * Target-scoped `--rules` flag parsing and ruleset override loading for
 * `pyric verify --static` (`verify-static.ts`).
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
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
  normalizeConfiguredResourceId,
  type LoadedAssuranceProject,
} from '../assurance/derive-project.js';
import { resolveContainedRulesFile } from './contained-rules-file.js';
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
  lexicalProjectRoot?: string,
): { ok: true; project: LoadedAssuranceProject } | { ok: false; message: string } {
  const specs = readStringValues(rawRules);
  if (specs.length === 0) return { ok: true, project };

  let firestore: FirestoreRuleSource[] = [...project.sources.firestore];
  let rtdb: RtdbRuleSource[] = [...project.sources.rtdb];
  const existingStorage = project.sources.storage ?? [];
  let storage: StorageRuleSource[] = [...existingStorage];
  let configuredBuckets = [...project.configuredBuckets];
  let nextDefaultBucket = project.defaultBucket;
  const rtdbInstances: Record<string, { rules: Record<string, unknown> }> = {};
  for (const [instId, instRules] of Object.entries(project.rtdbInstances)) {
    defineOwn(rtdbInstances, instId, instRules);
  }

  const defaultBucketAliases = new Set<string>([
    DEFAULT_SNAPSHOT_RESOURCE,
    DEFAULT_BUCKET,
    'pyric-default.appspot.com',
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

    const resolveInput: {
      projectRoot: string;
      lexicalProjectRoot?: string;
      cwd: string;
      fileArg: string;
    } = {
      projectRoot: project.root,
      cwd,
      fileArg,
    };
    if (lexicalProjectRoot !== undefined) {
      resolveInput.lexicalProjectRoot = lexicalProjectRoot;
    }
    const checkedFile = resolveContainedRulesFile(resolveInput);
    if (!checkedFile.ok) {
      return { ok: false, message: checkedFile.message };
    }
    const realRoot = checkedFile.realRoot;
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
      const effectiveTarget = normalizeConfiguredResourceId(
        'firestore',
        targetId,
        project.projectId,
      );
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
      const effectiveTarget = normalizeConfiguredResourceId(
        'storage',
        targetId,
        project.projectId,
      );
      const isDefaultOverride = defaultBucketAliases.has(effectiveTarget);
      overriddenTargets.add(`storage:${effectiveTarget}`);
      const hadConfiguredBuckets = configuredBuckets.length > 0;
      if (isDefaultOverride) {
        for (const alias of defaultBucketAliases) {
          overriddenTargets.add(`storage:${alias}`);
        }
        configuredBuckets = configuredBuckets.filter(
          (b) => !defaultBucketAliases.has(b),
        );
      }
      const entry: StorageRuleSource = { source: sourceLabel, text: bundledText };
      if (effectiveTarget !== DEFAULT_SNAPSHOT_RESOURCE) {
        entry.bucket = effectiveTarget;
        if (isDefaultOverride) {
          nextDefaultBucket = effectiveTarget;
        }
        if (hadConfiguredBuckets && !configuredBuckets.includes(effectiveTarget)) {
          configuredBuckets.push(effectiveTarget);
        }
      } else if (isDefaultOverride) {
        if (project.projectId !== undefined && nextDefaultBucket !== undefined) {
          const fbApp = `${project.projectId}.firebasestorage.app`;
          const appspot = `${project.projectId}.appspot.com`;
          if (
            bundledText.includes(`/b/${appspot}/o`)
            && !bundledText.includes(`/b/${fbApp}/o`)
          ) {
            nextDefaultBucket = appspot;
          } else if (
            bundledText.includes(`/b/${fbApp}/o`)
            && !bundledText.includes(`/b/${appspot}/o`)
          ) {
            nextDefaultBucket = fbApp;
          }
        }
        if (
          configuredBuckets.length > 0
          && nextDefaultBucket !== undefined
          && !configuredBuckets.includes(nextDefaultBucket)
        ) {
          configuredBuckets.push(nextDefaultBucket);
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
      const effectiveTarget = normalizeConfiguredResourceId(
        'rtdb',
        targetId,
        project.projectId,
      );
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
      defaultBucket: nextDefaultBucket,
      rtdbInstances,
      problems: remainingProblems,
      configProblems: remainingConfigProblems,
    },
  };
}
