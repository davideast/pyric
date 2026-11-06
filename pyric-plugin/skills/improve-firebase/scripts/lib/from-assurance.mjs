/**
 * Converts a Pyric assurance CampaignExport (`pyric.assurance.export.v1`) and selected
 * AssuranceProbeResult into a validated `pyric.evidence.scenario.v1` specification plus
 * normalized control and exploit operations.
 *
 * Zero external runtime dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  ASSURANCE_EXPORT_SCHEMA,
  ContractValidationError,
  SCENARIO_SCHEMA,
  STORY_TEMPLATES,
  validateScenario,
} from './contracts.mjs';
import { formatSdkSnippet, normalizeServiceName } from './op-snippet.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate and normalize a Pyric assurance campaign export object.
 */
export function parseCampaignExport(raw) {
  if (!isPlainObject(raw)) {
    throw new ContractValidationError('Assurance export must be a JSON object');
  }

  // Also accept a standalone AssuranceProbeResult object by wrapping it into a campaign envelope
  if (raw.probeId && raw.mutationSpec && !Array.isArray(raw.probes)) {
    const campaignId =
      typeof raw.campaignId === 'string' && raw.campaignId.trim().length > 0
        ? raw.campaignId.trim()
        : 'campaign-single-probe';
    return {
      schema: ASSURANCE_EXPORT_SCHEMA,
      campaignId,
      target: isPlainObject(raw.target) ? raw.target : { service: raw.mutationSpec?.operation?.service || 'database' },
      probes: [raw],
    };
  }

  if (raw.schema && raw.schema !== ASSURANCE_EXPORT_SCHEMA) {
    throw new ContractValidationError(
      `Unsupported assurance export schema "${raw.schema}" (expected "${ASSURANCE_EXPORT_SCHEMA}")`,
    );
  }

  const campaignId =
    typeof raw.campaignId === 'string' && raw.campaignId.trim().length > 0
      ? raw.campaignId.trim()
      : 'campaign-1';

  if (!Array.isArray(raw.probes) || raw.probes.length === 0) {
    throw new ContractValidationError('Assurance export must contain a non-empty probes array');
  }

  return {
    ...raw,
    schema: ASSURANCE_EXPORT_SCHEMA,
    campaignId,
    target: isPlainObject(raw.target) ? raw.target : {},
    probes: raw.probes,
  };
}

/**
 * Find a probe in a CampaignExport by probeId or invariant.id.
 */
export function selectProbeFromExport(campaignExport, probeId = null) {
  const probes = campaignExport.probes || [];
  if (!probeId) {
    if (probes.length === 1) {
      return probes[0];
    }
    const available = probes.map((p) => p.probeId || p.invariant?.id || '(unnamed)').join(', ');
    throw new ContractValidationError(
      `Multiple probes present in export (${available}); pass --probe <probeId> to select one.`,
    );
  }

  const normalizedQuery = String(probeId).trim();
  const match = probes.find(
    (p) =>
      p?.probeId === normalizedQuery ||
      p?.invariant?.id === normalizedQuery ||
      p?.slug === normalizedQuery,
  );

  if (!match) {
    const available = probes.map((p) => p.probeId || p.invariant?.id || '(unnamed)').join(', ');
    throw new ContractValidationError(
      `Probe "${normalizedQuery}" not found in campaign "${campaignExport.campaignId}". Available: ${available}`,
    );
  }

  return match;
}

/**
 * Normalize a FirebaseOperation from a probe or scenario step.
 */
export function normalizeAssuranceOperation(op, fallbackTarget = {}) {
  if (!isPlainObject(op)) {
    throw new ContractValidationError('Firebase operation must be a JSON object');
  }

  const rawService = op.service ?? fallbackTarget.service ?? 'database';
  const service = normalizeServiceName(rawService);
  const rawMethod = op.method ?? op.op ?? (op.data !== undefined ? 'set' : 'get');
  const method = String(rawMethod).trim();

  let targetPath = op.path;
  if (!targetPath && (op.collection || op.doc)) {
    const parts = [op.collection, op.doc]
      .filter((x) => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim().replace(/^\/+|\/+$/g, ''));
    targetPath = parts.join('/');
  }
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new ContractValidationError(`${service}.${method} operation is missing a target path`);
  }

  const normalizedPath =
    service === 'database' && !targetPath.startsWith('/')
      ? `/${targetPath}`
      : targetPath.trim();

  const normalized = {
    service,
    method,
    path: normalizedPath,
  };

  if (op.data !== undefined) {
    normalized.data = structuredClone(op.data);
  }
  if (op.query !== undefined) {
    normalized.query = structuredClone(op.query);
  }
  if (op.contentType !== undefined) {
    normalized.contentType = op.contentType;
  }
  if (op.uid !== undefined) {
    normalized.uid = op.uid;
  }
  if (isPlainObject(op.customClaims)) {
    normalized.customClaims = structuredClone(op.customClaims);
  }

  return normalized;
}

/**
 * Infer a storytelling template from an assurance probe and actor definitions.
 */
export function inferStoryTemplate(probe, actors = {}) {
  const haystack = [
    probe?.template,
    probe?.invariant?.id,
    probe?.invariant?.name,
    probe?.invariant?.description,
    probe?.mutationSpec?.exploitDescription,
  ]
    .filter((s) => typeof s === 'string')
    .join(' ');

  if (probe?.template && STORY_TEMPLATES.includes(probe.template)) {
    return probe.template;
  }
  if (!actors.attacker || /\bunauth|anonymous|signed[- ]?out\b/i.test(haystack)) {
    return 'unauthenticated';
  }
  if (/\bspoof|impersonat|forge|pretend|wrong author\b/i.test(haystack)) {
    return 'spoof';
  }
  if (/\bescalat|admin|privilege|role|custom claim\b/i.test(haystack)) {
    return 'escalation';
  }
  const opMethod = String(probe?.mutationSpec?.operation?.method ?? '').toLowerCase();
  if (opMethod === 'get' || opMethod === 'list' || /\bexpos|leak|read|disclos\b/i.test(haystack)) {
    return 'exposure';
  }
  return 'tamper';
}

function buildActorsFromProbe(probe, overrideActors = {}) {
  const evidence = isPlainObject(probe?.actorEvidence) ? probe.actorEvidence : {};
  const victimUid =
    overrideActors?.victim?.uid ??
    evidence.victimUid ??
    'alice';
  const victimName =
    overrideActors?.victim?.name ??
    evidence.victimLabel ??
    `${victimUid.charAt(0).toUpperCase()}${victimUid.slice(1)} (Owner)`;

  const victim = {
    uid: victimUid,
    name: victimName,
    view: overrideActors?.victim?.view ?? '/',
    ...(isPlainObject(evidence.victimClaims) ? { claims: evidence.victimClaims } : {}),
    ...(isPlainObject(overrideActors?.victim) ? overrideActors.victim : {}),
  };

  const hasExplicitAttackerOverride =
    overrideActors && Object.prototype.hasOwnProperty.call(overrideActors, 'attacker');

  let attacker;
  if (hasExplicitAttackerOverride) {
    if (overrideActors.attacker && isPlainObject(overrideActors.attacker)) {
      const aUid = overrideActors.attacker.uid ?? evidence.attackerUid ?? 'mallory';
      attacker = {
        uid: aUid,
        name: overrideActors.attacker.name ?? evidence.attackerLabel ?? aUid,
        view: overrideActors.attacker.view ?? '/',
        ...(isPlainObject(evidence.attackerClaims) ? { claims: evidence.attackerClaims } : {}),
        ...overrideActors.attacker,
      };
    }
  } else {
    const rawAttackerUid = evidence.attackerUid !== undefined ? evidence.attackerUid : 'mallory';
    if (rawAttackerUid !== null && rawAttackerUid !== '') {
      attacker = {
        uid: rawAttackerUid,
        name:
          evidence.attackerLabel ??
          `${rawAttackerUid.charAt(0).toUpperCase()}${rawAttackerUid.slice(1)} (External)`,
        view: '/',
        ...(isPlainObject(evidence.attackerClaims) ? { claims: evidence.attackerClaims } : {}),
      };
    }
  }

  return attacker ? { victim, attacker } : { victim };
}

function deriveControlOperation({ probe, exploitOperation, actors }) {
  if (isPlainObject(probe?.control?.operation)) {
    return normalizeAssuranceOperation(probe.control.operation, { service: exploitOperation.service });
  }
  if (isPlainObject(probe?.mutationSpec?.controlOperation)) {
    return normalizeAssuranceOperation(probe.mutationSpec.controlOperation, {
      service: exploitOperation.service,
    });
  }

  const victimUid = actors.victim?.uid || 'alice';
  const preState = probe?.mutation?.before ?? probe?.stateDiff?.before?.[exploitOperation.path];
  const isReadMethod = ['get', 'list', 'getDoc', 'getDocs', 'getBytes', 'getDownloadURL'].includes(
    exploitOperation.method,
  );

  if (isReadMethod || exploitOperation.service === 'storage') {
    return {
      service: exploitOperation.service,
      method: exploitOperation.service === 'firestore' ? 'getDoc' : 'get',
      path: exploitOperation.path,
      uid: victimUid,
    };
  }

  // Synthesize a legitimate owner write with pre-exploit data (preserving owner field)
  let safeBaselineData;
  if (isPlainObject(preState)) {
    safeBaselineData = structuredClone(preState);
    if ('ownerUid' in safeBaselineData) {
      safeBaselineData.ownerUid = victimUid;
    } else if ('authorUid' in safeBaselineData) {
      safeBaselineData.authorUid = victimUid;
    } else if ('uid' in safeBaselineData) {
      safeBaselineData.uid = victimUid;
    }
  } else if (preState !== undefined && preState !== null) {
    safeBaselineData = preState;
  } else {
    safeBaselineData = {
      authorUid: victimUid,
      ownerUid: victimUid,
      text: 'Verified owner baseline state',
    };
  }

  return {
    service: exploitOperation.service,
    method: exploitOperation.service === 'firestore' ? 'setDoc' : 'set',
    path: exploitOperation.path,
    data: safeBaselineData,
    uid: victimUid,
  };
}

function readRuleSnippetText(ruleSpec) {
  if (!isPlainObject(ruleSpec)) return null;
  if (typeof ruleSpec.matchedRule === 'string' && ruleSpec.matchedRule.trim().length > 0) {
    return ruleSpec.matchedRule.trim();
  }
  for (const key of ['rtdb', 'database', 'firestore', 'storage']) {
    const val = ruleSpec[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      const resolved = path.resolve(val.trim());
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        const raw = fs.readFileSync(resolved, 'utf8').trim();
        return raw.length > 260 ? `${raw.slice(0, 257)}...` : raw;
      }
      return val.trim();
    }
  }
  return null;
}

/**
 * Convert an assurance export + probe (with optional scenario override) into a validated scenario
 * plus normalized control/exploit operations and seed state.
 */
export function buildScenarioFromAssurance({
  campaignExport,
  probe,
  scenarioOverride = null,
  app = null,
  fixRules = null,
  stage = null,
}) {
  const override = isPlainObject(scenarioOverride) ? scenarioOverride : {};
  const finding = {
    campaign: override.finding?.campaign ?? campaignExport.campaignId ?? probe.campaignId,
    probe: override.finding?.probe ?? probe.probeId,
    ...(probe.targetHash || campaignExport.target?.databaseRulesHash || campaignExport.target?.rulesHash
      ? {
          targetHash:
            probe.targetHash ??
            campaignExport.target?.databaseRulesHash ??
            campaignExport.target?.rulesHash,
        }
      : {}),
  };

  const actors = buildActorsFromProbe(probe, override.actors);
  const template = inferStoryTemplate(
    { ...probe, ...(override.template ? { template: override.template } : {}) },
    actors,
  );

  let exploitOperation = null;
  if (isPlainObject(probe?.mutationSpec?.operation)) {
    exploitOperation = normalizeAssuranceOperation(
      probe.mutationSpec.operation,
      campaignExport.target,
    );
  } else if (Array.isArray(override.steps)) {
    const exploitStep = override.steps.find(
      (s) =>
        isPlainObject(s) &&
        String(s.kind || s.type || '').toLowerCase() === 'sdk' &&
        (String(s.id || s.phase || '').toLowerCase() === 'exploit' || isPlainObject(s.operation)),
    );
    if (exploitStep?.operation) {
      exploitOperation = normalizeAssuranceOperation(exploitStep.operation, campaignExport.target);
    }
  }

  if (!exploitOperation) {
    throw new ContractValidationError(
      `Probe "${finding.probe}" has no mutationSpec.operation and no SDK exploit step`,
    );
  }

  const controlOperation = isPlainObject(override.controlOperation)
    ? normalizeAssuranceOperation(override.controlOperation, { service: exploitOperation.service })
    : deriveControlOperation({ probe, exploitOperation, actors });

  const mergedApp = override.app ?? app ?? undefined;
  const mergedFixRules =
    override.fixRules || fixRules
      ? {
          ...(isPlainObject(override.fixRules) ? override.fixRules : {}),
          ...(isPlainObject(fixRules) ? fixRules : {}),
        }
      : undefined;

  const hasFix = Boolean(mergedFixRules);
  const attackerLabel = actors.attacker?.name || actors.attacker?.uid || 'Unauthenticated caller';
  const victimLabel = actors.victim?.name || actors.victim?.uid || 'Owner';

  const defaultTitle =
    probe?.invariant?.name ||
    `${exploitOperation.service}.${exploitOperation.method} security bypass on ${exploitOperation.path}`;
  const defaultExploit =
    probe?.mutationSpec?.exploitDescription ||
    `${attackerLabel} executes ${exploitOperation.service}.${exploitOperation.method} on ${exploitOperation.path} and the rules allow it.`;
  const defaultWhy =
    probe?.invariant?.description ||
    `Security rules on ${exploitOperation.path} failed to enforce caller authorization.`;
  const defaultBaseline = `${victimLabel} performs a legitimate ${controlOperation.service}.${controlOperation.method} operation on ${controlOperation.path}.`;

  const copy = {
    severity: String(probe?.invariant?.severity || 'HIGH').toUpperCase(),
    title: defaultTitle,
    baseline: defaultBaseline,
    exploit: defaultExploit,
    why: defaultWhy,
    ...(hasFix
      ? {
          fixed: `Updated security rules reject ${attackerLabel}'s unauthorized mutation while preserving ${victimLabel}'s access.`,
        }
      : {}),
    ...(isPlainObject(override.copy) ? override.copy : {}),
  };

  const defaultLayout = mergedApp
    ? actors.attacker
      ? 'split-actors'
      : 'single-hero'
    : 'data-plane';

  const mergedStage = {
    layout: defaultLayout,
    aspect: '16:9',
    ...(isPlainObject(override.stage) ? override.stage : {}),
    ...(isPlainObject(stage) ? stage : {}),
  };

  const initialSeedValue =
    probe?.mutation?.before ??
    probe?.stateDiff?.before?.[exploitOperation.path] ??
    controlOperation.data;

  const scenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding,
    template,
    ...(mergedApp ? { app: mergedApp } : {}),
    actors,
    copy,
    stage: mergedStage,
    ...(Array.isArray(override.steps) ? { steps: override.steps } : {}),
    ...(mergedFixRules ? { fixRules: mergedFixRules } : {}),
  });

  // Preserve custom helper properties on actors/finding needed at runtime
  if (finding.targetHash) {
    scenario.finding.targetHash = finding.targetHash;
  }

  return {
    scenario,
    probe,
    controlOperation,
    exploitOperation,
    exploitSnippet: formatSdkSnippet(exploitOperation),
    controlSnippet: formatSdkSnippet(controlOperation),
    initialSeedValue: initialSeedValue !== undefined ? structuredClone(initialSeedValue) : undefined,
    fixedRuleSnippet: readRuleSnippetText(mergedFixRules),
  };
}
