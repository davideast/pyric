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

  // The real `firebase_assurance_export` bundle nests results: { campaign, report: { results } }.
  // `campaign` (inline target rules/state, actors), `observations`, and `verifications` are
  // kept on the normalized object so later stages can read them.
  if (!Array.isArray(raw.probes) && Array.isArray(raw.report?.results)) {
    raw = {
      ...raw,
      campaignId: raw.campaignId ?? raw.campaign?.id ?? raw.report.campaignId,
      probes: raw.report.results,
      ...(raw.target ? {} : { target: { rulesHash: raw.report.targetHash } }),
    };
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

function capitalize(value) {
  const s = String(value);
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

/**
 * Resolve a campaign actor id (`campaign.actors[].id`) to the uid it signs in as.
 */
export function resolveCampaignActorUid(campaignExport, actorId) {
  if (typeof actorId !== 'string' || actorId.length === 0) return null;
  const actors = campaignExport?.campaign?.actors;
  const actor = Array.isArray(actors) ? actors.find((a) => a?.id === actorId) : null;
  return actor?.acquisition?.uid ?? actor?.uid ?? actorId;
}

/**
 * The uid of the actor that performed the probe's mutation (the attacker). Real exports
 * carry it as `actorEvidence.uid` / `actorEvidence.actorId`; older fixtures as `attackerUid`.
 */
export function resolveProbeActorUid(campaignExport, probe) {
  const evidence = isPlainObject(probe?.actorEvidence) ? probe.actorEvidence : {};
  if (evidence.attackerUid !== undefined) return evidence.attackerUid;
  if (typeof evidence.uid === 'string' && evidence.uid) return evidence.uid;
  const actorId = evidence.actorId ?? probe?.actorId ?? null;
  return actorId ? resolveCampaignActorUid(campaignExport, actorId) : undefined;
}

function buildActorsFromProbe(probe, overrideActors = {}, derived = {}) {
  const evidence = isPlainObject(probe?.actorEvidence) ? probe.actorEvidence : {};
  const victimUid =
    overrideActors?.victim?.uid ??
    evidence.victimUid ??
    derived.victimUid ??
    'alice';
  // Only the legacy fixture shape labels roles; a uid taken from a campaign actor is shown as-is.
  const victimName =
    overrideActors?.victim?.name ??
    evidence.victimLabel ??
    (evidence.victimUid === undefined && derived.victimUid
      ? capitalize(victimUid)
      : `${capitalize(victimUid)} (Owner)`);

  const victim = {
    uid: victimUid,
    name: victimName,
    view: overrideActors?.victim?.view ?? '/',
    ...(isPlainObject(evidence.victimClaims) ? { claims: evidence.victimClaims } : {}),
    ...(isPlainObject(overrideActors?.victim) ? overrideActors.victim : {}),
  };

  const hasExplicitAttackerOverride =
    overrideActors && Object.prototype.hasOwnProperty.call(overrideActors, 'attacker');
  const derivedAttackerUid = derived.attackerUid;

  let attacker;
  if (hasExplicitAttackerOverride) {
    if (overrideActors.attacker && isPlainObject(overrideActors.attacker)) {
      const aUid = overrideActors.attacker.uid ?? derivedAttackerUid ?? 'mallory';
      attacker = {
        uid: aUid,
        name: overrideActors.attacker.name ?? evidence.attackerLabel ?? aUid,
        view: overrideActors.attacker.view ?? '/',
        ...(isPlainObject(evidence.attackerClaims) ? { claims: evidence.attackerClaims } : {}),
        ...overrideActors.attacker,
      };
    }
  } else {
    const rawAttackerUid = derivedAttackerUid !== undefined ? derivedAttackerUid : 'mallory';
    if (rawAttackerUid !== null && rawAttackerUid !== '') {
      attacker = {
        uid: rawAttackerUid,
        name:
          evidence.attackerLabel ??
          (evidence.attackerUid === undefined && derivedAttackerUid !== undefined
            ? capitalize(rawAttackerUid)
            : `${capitalize(rawAttackerUid)} (External)`),
        view: '/',
        ...(isPlainObject(evidence.attackerClaims) ? { claims: evidence.attackerClaims } : {}),
      };
    }
  }

  return attacker ? { victim, attacker } : { victim };
}

function parentPath(p) {
  const segs = String(p || '').replace(/\/+$/, '').split('/');
  segs.pop();
  return segs.join('/') || '/';
}

/**
 * Pick the known-good observation that should serve as the victim's control: an allowed
 * operation by a different actor than the probe's, on the mutated path (or a sibling of it).
 * Returns null when the export has no usable observation.
 */
export function selectControlObservation({
  campaignExport,
  probe,
  exploitOperation,
  victimUid = null,
}) {
  const observations = campaignExport?.observations;
  if (!Array.isArray(observations) || observations.length === 0 || !exploitOperation) {
    return null;
  }
  const probeActorUid = resolveProbeActorUid(campaignExport, probe) ?? null;
  const probeInvariantId = probe?.invariant?.id ?? probe?.invariantId ?? null;
  const targetParent = parentPath(exploitOperation.path);

  let best = null;
  for (const obs of observations) {
    if (!isPlainObject(obs) || !isPlainObject(obs.operation)) continue;
    if (obs.result !== undefined && String(obs.result).toUpperCase() !== 'ALLOW') continue;
    if (obs.invariantId && probeInvariantId && obs.invariantId !== probeInvariantId) continue;
    let op;
    try {
      op = normalizeAssuranceOperation(obs.operation, { service: exploitOperation.service });
    } catch {
      continue;
    }
    if (op.service !== exploitOperation.service) continue;
    const uid = obs.uid ?? resolveCampaignActorUid(campaignExport, obs.actorId);
    if (!uid) continue;
    if (probeActorUid && uid === probeActorUid) continue;
    if (victimUid && uid !== victimUid) continue;

    let score;
    if (op.path === exploitOperation.path) score = 2;
    else if (parentPath(op.path) === targetParent) score = 1;
    else continue;
    if (op.method === exploitOperation.method) score += 0.5;

    if (!best || score > best.score) {
      best = { score, obs, uid, op };
    }
  }
  if (!best) return null;
  return {
    observationId: best.obs.id ?? null,
    actorId: best.obs.actorId ?? null,
    uid: best.uid,
    description: typeof best.obs.description === 'string' ? best.obs.description : null,
    operation: { ...best.op, uid: best.uid },
  };
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

  const overrideControl = isPlainObject(override.controlOperation);
  // The probe's own control is the attacker's known-good write. When the export carries
  // observations, the victim's allowed write on the mutated path is the honest control.
  const controlObservation = overrideControl
    ? null
    : selectControlObservation({
        campaignExport,
        probe,
        exploitOperation,
        victimUid: override.actors?.victim?.uid ?? probe?.actorEvidence?.victimUid ?? null,
      });

  const actors = buildActorsFromProbe(probe, override.actors, {
    attackerUid: resolveProbeActorUid(campaignExport, probe),
    victimUid: controlObservation?.uid,
  });
  const template = inferStoryTemplate(
    { ...probe, ...(override.template ? { template: override.template } : {}) },
    actors,
  );

  let controlOperation;
  let controlSource;
  if (overrideControl) {
    controlOperation = normalizeAssuranceOperation(override.controlOperation, {
      service: exploitOperation.service,
    });
    controlSource = { kind: 'override' };
  } else if (controlObservation) {
    controlOperation = controlObservation.operation;
    controlSource = {
      kind: 'observation',
      observationId: controlObservation.observationId,
      actorId: controlObservation.actorId,
      uid: controlObservation.uid,
    };
  } else {
    controlOperation = deriveControlOperation({ probe, exploitOperation, actors });
    controlSource = {
      kind: isPlainObject(probe?.control?.operation) || isPlainObject(probe?.mutationSpec?.controlOperation)
        ? 'probe-control'
        : 'synthesized',
    };
  }

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

  // Copy defaults use only what the export states; nothing here should invent a claim.
  const humanProbeId =
    typeof probe?.probeId === 'string' && probe.probeId.trim()
      ? capitalize(probe.probeId.trim().replace(/[-_]+/g, ' '))
      : null;
  const defaultTitle =
    probe?.invariant?.name ||
    humanProbeId ||
    `${exploitOperation.service}.${exploitOperation.method} on ${exploitOperation.path} is allowed`;
  const defaultExploit =
    probe?.mutationSpec?.exploitDescription ||
    probe?.mutationSpec?.description ||
    `${attackerLabel} executes ${exploitOperation.service}.${exploitOperation.method} on ${exploitOperation.path} and the rules allow it.`;
  const defaultWhy =
    probe?.invariant?.description ||
    probe?.invariant?.statement ||
    `Security rules on ${exploitOperation.path} failed to enforce caller authorization.`;
  const defaultBaseline =
    controlObservation?.description ||
    `${victimLabel} performs a legitimate ${controlOperation.service}.${controlOperation.method} operation on ${controlOperation.path}.`;
  // Real exports carry no severity; say so instead of defaulting to HIGH.
  const defaultSeverity = probe?.invariant?.severity || probe?.severity || 'UNRATED';

  const copy = {
    severity: String(defaultSeverity).toUpperCase(),
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

  // Real exports report stateDiff as { changed, before, after } for the mutated path;
  // older fixtures key `before` by path.
  const stateDiffBefore =
    isPlainObject(probe?.stateDiff) && 'changed' in probe.stateDiff
      ? probe.stateDiff.before
      : probe?.stateDiff?.before?.[exploitOperation.path];
  const initialSeedValue =
    probe?.mutation?.before ??
    stateDiffBefore ??
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
    controlSource,
    exploitOperation,
    exploitSnippet: formatSdkSnippet(exploitOperation),
    controlSnippet: formatSdkSnippet(controlOperation),
    initialSeedValue: initialSeedValue !== undefined ? structuredClone(initialSeedValue) : undefined,
    fixedRuleSnippet: readRuleSnippetText(mergedFixRules),
  };
}

/**
 * Deterministic JSON serialization with sorted keys, matching the assurance runner's
 * `stableStringify` so target hashes can be recomputed locally.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

/**
 * Hash a `pyric.assurance.target.v1` object the way the assurance runner does
 * (FNV-1a 32 over the stable serialization).
 */
export function assuranceTargetHash(target) {
  const input = stableStringify(target);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * The rules and state an assurance campaign actually ran against, when the export carries
 * them inline (`campaign.target.rules` / `campaign.target.state`). Null fields are absent.
 */
export function extractInlineTarget(campaignExport) {
  const target = campaignExport?.campaign?.target;
  if (!isPlainObject(target)) {
    return { rtdbRules: null, rtdbState: null, firestoreRules: null, storageRules: null };
  }
  const rules = isPlainObject(target.rules) ? target.rules : {};
  const state = isPlainObject(target.state) ? target.state : {};
  return {
    rtdbRules: isPlainObject(rules.rtdb) ? rules.rtdb : null,
    rtdbState: state.rtdb !== undefined && state.rtdb !== null ? state.rtdb : null,
    firestoreRules: typeof rules.firestore === 'string' ? rules.firestore : null,
    storageRules: typeof rules.storage === 'string' ? rules.storage : null,
  };
}

/**
 * Write the export's inline rules/state to files under `dir` so the sandbox can load them.
 * Returns the paths written (null for anything the export does not carry).
 */
export function materializeInlineTarget(campaignExport, dir) {
  const inline = extractInlineTarget(campaignExport);
  const out = { rtdbRulesPath: null, seedPath: null, firestoreRulesPath: null, storageRulesPath: null };
  if (inline.rtdbRules) {
    out.rtdbRulesPath = path.join(dir, 'campaign.database.rules.json');
    fs.writeFileSync(out.rtdbRulesPath, `${JSON.stringify(inline.rtdbRules, null, 2)}\n`, 'utf8');
  }
  if (inline.rtdbState !== null) {
    out.seedPath = path.join(dir, 'campaign.seed.json');
    fs.writeFileSync(out.seedPath, `${JSON.stringify({ database: inline.rtdbState }, null, 2)}\n`, 'utf8');
  }
  if (inline.firestoreRules) {
    out.firestoreRulesPath = path.join(dir, 'campaign.firestore.rules');
    fs.writeFileSync(out.firestoreRulesPath, inline.firestoreRules, 'utf8');
  }
  if (inline.storageRules) {
    out.storageRulesPath = path.join(dir, 'campaign.storage.rules');
    fs.writeFileSync(out.storageRulesPath, inline.storageRules, 'utf8');
  }
  return out;
}

const READ_METHODS = new Set(['get', 'list', 'getdoc', 'getdocs', 'getbytes', 'getdownloadurl', 'onvalue', 'onsnapshot']);

function fixAssuranceNote(reason, method) {
  const noun = READ_METHODS.has(String(method || '').toLowerCase()) ? 'read' : 'write';
  const shown = `The sandbox recording shows the ${noun} denied.`;
  switch (reason) {
    case 'engine-gap':
      return `Assurance could not confirm this fix (engine gap). ${shown}`;
    case 'counterexample':
      return `Assurance found a counterexample under this fix. ${shown}`;
    case 'no-verification':
      return `Assurance has not verified this fix. ${shown}`;
    default:
      return `Assurance did not verify this fix. ${shown}`;
  }
}

/**
 * Decide whether the export's assurance `verify` runs confirmed the fix being recorded.
 *
 * The verification is matched by recomputing the target hash with the fix rules swapped in.
 * Anything other than a `no-counterexample` result with an allowed control is "not verified":
 * the video then carries a quiet note, because the sandbox DENY alone is weaker evidence.
 *
 * @param {object} args
 * @param {object} args.campaignExport normalized export (parseCampaignExport)
 * @param {object} args.probe the selected probe result
 * @param {{rtdbRules?: object, firestoreRules?: string, storageRules?: string}} args.fixRules
 * @param {string} [args.method] exploit method, used to word the note
 */
export function assessFixAssurance({ campaignExport, probe, fixRules, method } = {}) {
  const probeId = probe?.probeId ?? null;
  const verifications = Array.isArray(campaignExport?.verifications) ? campaignExport.verifications : [];
  const notVerified = (reason, extra = {}) => ({
    verified: false,
    reason,
    ...extra,
    note: fixAssuranceNote(reason, method),
  });

  const target = campaignExport?.campaign?.target;
  let fixTargetHash = null;
  if (isPlainObject(target) && isPlainObject(fixRules)) {
    const rules = { ...(isPlainObject(target.rules) ? target.rules : {}) };
    if (isPlainObject(fixRules.rtdbRules)) rules.rtdb = fixRules.rtdbRules;
    if (typeof fixRules.firestoreRules === 'string') rules.firestore = fixRules.firestoreRules;
    if (typeof fixRules.storageRules === 'string') rules.storage = fixRules.storageRules;
    fixTargetHash = assuranceTargetHash({ ...target, rules });
  }

  if (verifications.length === 0) {
    return notVerified('no-verification', fixTargetHash ? { targetHash: fixTargetHash } : {});
  }
  const verification = fixTargetHash
    ? verifications.find((v) => v?.targetHash === fixTargetHash)
    : null;
  if (!verification) {
    return notVerified('no-verification', fixTargetHash ? { targetHash: fixTargetHash } : {});
  }

  const verificationId = verification.campaignId ?? null;
  const result = Array.isArray(verification.results)
    ? verification.results.find((r) => r?.probeId === probeId)
    : null;
  if (!result) {
    return notVerified('no-verification', { verificationId, targetHash: fixTargetHash });
  }

  const classification = result.classification ?? null;
  const controlDecision = result.control?.decision ?? null;
  if (classification === 'no-counterexample' && (controlDecision === null || controlDecision === 'ALLOW')) {
    return { verified: true, reason: 'verified', verificationId, targetHash: fixTargetHash, classification };
  }

  const gapDetail = Array.isArray(result.qualification?.requirements)
    ? result.qualification.requirements.find((r) => r && r.supported === false)?.reason
    : undefined;
  const reason =
    classification === 'engine-gap'
      ? 'engine-gap'
      : classification === 'local-counterexample' || classification === 'confirmed'
        ? 'counterexample'
        : 'not-verified';
  return notVerified(reason, {
    verificationId,
    targetHash: fixTargetHash,
    classification,
    ...(gapDetail ? { detail: gapDetail } : {}),
  });
}
