
function normalizeAliases(raw) {
  if (!isPlainObject(raw)) return;
  if (isPlainObject(raw.actors)) {
    if (raw.actors.victim && !raw.actors.owner) raw.actors.owner = raw.actors.victim;
    if (raw.actors.attacker && !raw.actors.peer) raw.actors.peer = raw.actors.attacker;
  }
  if (isPlainObject(raw.copy) && raw.copy.exploit && !raw.copy.summary) {
    raw.copy.summary = raw.copy.exploit;
  }
  if (isPlainObject(raw.behavior) && isPlainObject(raw.behavior.action)) {
    if (raw.behavior.action.actor === 'victim') raw.behavior.action.actor = 'owner';
    if (raw.behavior.action.actor === 'attacker') raw.behavior.action.actor = 'peer';
  }
  if (isPlainObject(raw.behavior) && Array.isArray(raw.behavior.operations)) {
    for (const op of raw.behavior.operations) {
      if (op.phase === 'exploit') op.phase = 'repro';
    }
  }
  if (Array.isArray(raw.beats)) {
    for (const b of raw.beats) {
      if (b.phase === 'exploit') b.phase = 'repro';
    }
  }
}

/**
 * Shared schemas, constants, and payload builders for Pyric audit video scripts.
 * Zero external runtime dependencies so scripts run directly from any plugin cache directory.
 */

export const SCENARIO_SCHEMA = 'pyric.evidence.scenario.v1';
export const RAW_CAPTURE_SCHEMA = 'pyric.evidence.capture.v1';
export const STAGE_PAYLOAD_SCHEMA = 'pyric.evidence.stage.v1';
export const BUNDLE_SCHEMA = 'pyric.evidence.bundle.v1';
export const ASSURANCE_EXPORT_SCHEMA = 'pyric.assurance.export.v1';

export const STORY_TEMPLATES = Object.freeze([
  'tamper',
  'spoof',
  'exposure',
  'escalation',
  'unauthenticated',
]);

export const STAGE_LAYOUTS = Object.freeze([
  'split-actors',
  'single-hero',
  'data-plane',
  'before-after',
]);

export const MVP_STAGE_LAYOUTS = Object.freeze([
  'split-actors',
  'single-hero',
  'data-plane',
]);

export const STAGE_ASPECTS = Object.freeze({
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
});

export const CAPTION_STYLES = Object.freeze(['pill', 'bar', 'minimal', 'none']);

export const CAPTURE_BACKENDS = Object.freeze([
  'x11-xvfb',
  'macos-avfoundation',
  'cdp-surface',
]);

export const DEFAULT_VIEWPORT_DIP = Object.freeze({ width: 900, height: 675 });
export const DEFAULT_DPR = 2;
export const DEFAULT_PHYSICAL_SIZE = Object.freeze({
  width: DEFAULT_VIEWPORT_DIP.width * DEFAULT_DPR,
  height: DEFAULT_VIEWPORT_DIP.height * DEFAULT_DPR,
});

export const DEFAULT_STAGE_THEME = Object.freeze({
  surface: '#212121',
  panel: '#2a2a2a',
  ink: '#f5f5f5',
  muted: '#b3b3b3',
  accent: '#f5f5f5',
  danger: '#d4d4d4',
  success: '#a3a3a3',
  border: 'rgba(255, 255, 255, 0.12)',
  radius: '10px',
  fontSans: '"PyricSans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontMono: '"PyricMono", "Noto Sans Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
});

export const DEFAULT_STAGE_SLOTS = Object.freeze({
  captionStyle: 'pill',
  highlights: true,
  showRuleDiff: true,
  showRequestCard: true,
  showTitleCard: true,
  showOutroCard: true,
  collapseSidebar: true,
});

export class ContractValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ContractValidationError';
    this.code = 'EVIDENCE_CONTRACT_INVALID';
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyString(value, field, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
    return '';
  }
  return value.trim();
}

/**
 * Parse a `<width>x<height>` string (e.g. `1920x1080` or `1080x1080`).
 */
export function parseSizeString(sizeStr) {
  if (typeof sizeStr !== 'string') {
    throw new ContractValidationError('size must be a string in "<width>x<height>" format');
  }
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(sizeStr.trim());
  if (!match) {
    throw new ContractValidationError(`Invalid size "${sizeStr}": expected "<width>x<height>" (e.g. 1920x1080)`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 320 || width % 2 !== 0 || height % 2 !== 0) {
    throw new ContractValidationError(`Invalid size "${sizeStr}": dimensions must be even integers >= 320`);
  }
  return { width, height };
}

/**
 * Validate and normalize a `pyric.evidence.scenario.v1` object.
 */
export function validateScenario(raw) {
  normalizeAliases(raw);
  const errors = [];
  if (!isPlainObject(raw)) {
    throw new ContractValidationError('Scenario must be a JSON object');
  }

  if (raw.schema !== SCENARIO_SCHEMA) {
    errors.push(`schema must be "${SCENARIO_SCHEMA}" (got ${JSON.stringify(raw.schema)})`);
  }

  const template = raw.template ?? 'tamper';
  if (!STORY_TEMPLATES.includes(template)) {
    errors.push(`template must be one of: ${STORY_TEMPLATES.join(', ')}`);
  }

  // Finding metadata (required)
  if (!isPlainObject(raw.finding)) {
    errors.push('finding must be an object with campaign and probe');
  }
  const campaign = isPlainObject(raw.finding)
    ? assertNonEmptyString(raw.finding.campaign, 'finding.campaign', errors)
    : '';
  const probe = isPlainObject(raw.finding)
    ? assertNonEmptyString(raw.finding.probe, 'finding.probe', errors)
    : '';

  // Actors (owner required; peer optional for single-hero/unauthenticated/data-plane)
  if (!isPlainObject(raw.actors) || !isPlainObject(raw.actors.owner)) {
    errors.push('actors.owner must be an object');
  }
  const actors = {};
  if (isPlainObject(raw.actors)) {
    for (const role of ['owner', 'peer']) {
      const entry = raw.actors[role];
      if (!entry) continue;
      if (!isPlainObject(entry)) {
        errors.push(`actors.${role} must be an object`);
        continue;
      }
      const uid = typeof entry.uid === 'string' ? entry.uid : '';
      const name = assertNonEmptyString(entry.name ?? (uid || role), `actors.${role}.name`, errors);
      const view = typeof entry.view === 'string' ? entry.view : '/';
      actors[role] = {
        ...entry,
        uid,
        name,
        view,
      };
    }
  }

  // Copy
  if (!isPlainObject(raw.copy)) {
    errors.push('copy must be an object with title, repro, and why');
  }
  const copy = isPlainObject(raw.copy)
    ? {
        title: assertNonEmptyString(raw.copy.title, 'copy.title', errors),
        summary: assertNonEmptyString(raw.copy.summary || raw.copy.summary, 'copy.summary', errors),
        why: assertNonEmptyString(raw.copy.why, 'copy.why', errors),
        severity: typeof raw.copy.severity === 'string' ? raw.copy.severity.toUpperCase() : 'HIGH',
        baseline: typeof raw.copy.baseline === 'string' ? raw.copy.baseline : undefined,
        fixed: typeof raw.copy.fixed === 'string' ? raw.copy.fixed : undefined,
        pathTitle: typeof raw.copy.pathTitle === 'string' ? raw.copy.pathTitle : undefined,
        pathContext: typeof raw.copy.pathContext === 'string' ? raw.copy.pathContext : undefined,
        attackTitle: typeof raw.copy.attackTitle === 'string' ? raw.copy.attackTitle : undefined,
        attackContext: typeof raw.copy.attackContext === 'string' ? raw.copy.attackContext : undefined,
        targetContext: typeof raw.copy.targetContext === 'string' ? raw.copy.targetContext : undefined,
        whyDetail: typeof raw.copy.whyDetail === 'string' ? raw.copy.whyDetail : undefined,
        fixTitle: typeof raw.copy.fixTitle === 'string' ? raw.copy.fixTitle : undefined,
        fixContext: typeof raw.copy.fixContext === 'string' ? raw.copy.fixContext : undefined,
        missingCheckCode: typeof raw.copy.missingCheckCode === 'string' ? raw.copy.missingCheckCode : undefined,
        pathTokens: Array.isArray(raw.copy.pathTokens) ? raw.copy.pathTokens : undefined,
        pathSegments: Array.isArray(raw.copy.pathSegments)
          ? raw.copy.pathSegments
              .filter(
                (s) =>
                  isPlainObject(s) &&
                  (typeof s.path === 'string' || typeof s.segment === 'string') &&
                  typeof s.label === 'string',
              )
              .map((s) => ({
                path: String(s.path ?? s.segment).trim(),
                label: String(s.label).trim(),
                ...(typeof s.detail === 'string' && s.detail.trim() ? { detail: s.detail.trim() } : {}),
                ...(typeof s.tone === 'string' && s.tone.trim() ? { tone: s.tone.trim() } : {}),
              }))
          : undefined,
        rulePathBefore: typeof raw.copy.rulePathBefore === 'string' ? raw.copy.rulePathBefore : undefined,
        rulePathBeforeContext:
          typeof raw.copy.rulePathBeforeContext === 'string' ? raw.copy.rulePathBeforeContext : undefined,
        rulePathAfter: typeof raw.copy.rulePathAfter === 'string' ? raw.copy.rulePathAfter : undefined,
        rulePathAfterContext:
          typeof raw.copy.rulePathAfterContext === 'string' ? raw.copy.rulePathAfterContext : undefined,
        ruleBreakdown: Array.isArray(raw.copy.ruleBreakdown)
          ? raw.copy.ruleBreakdown
              .filter((b) => isPlainObject(b) && typeof b.label === 'string')
              .map((b) => ({
                label: String(b.label).trim(),
                ...(typeof b.detail === 'string' && b.detail.trim() ? { detail: b.detail.trim() } : {}),
                ...(typeof b.code === 'string' && b.code.trim() ? { code: b.code.trim() } : {}),
                ...(typeof b.status === 'string' && b.status.trim() ? { status: b.status.trim() } : {}),
              }))
          : undefined,
      }
    : { title: '', repro: '', why: '', severity: 'HIGH' };

  // Stage configuration (3-tier loose customization)
  const rawStage = isPlainObject(raw.stage) ? raw.stage : {};
  const layout = rawStage.layout ?? (raw.app ? 'split-actors' : 'data-plane');
  if (!STAGE_LAYOUTS.includes(layout)) {
    errors.push(`stage.layout must be one of: ${STAGE_LAYOUTS.join(', ')}`);
  }
  const aspect = rawStage.aspect ?? '16:9';
  if (!(aspect in STAGE_ASPECTS)) {
    errors.push(`stage.aspect must be one of: ${Object.keys(STAGE_ASPECTS).join(', ')}`);
  }

  const theme = {
    ...DEFAULT_STAGE_THEME,
    ...(isPlainObject(rawStage.theme) ? rawStage.theme : {}),
  };

  const slots = {
    ...DEFAULT_STAGE_SLOTS,
    ...(isPlainObject(rawStage.slots) ? rawStage.slots : {}),
  };
  if (!CAPTION_STYLES.includes(slots.captionStyle)) {
    errors.push(`stage.slots.captionStyle must be one of: ${CAPTION_STYLES.join(', ')}`);
  }

  let viewport = null;
  if (rawStage.viewport !== undefined && rawStage.viewport !== null) {
    if (!isPlainObject(rawStage.viewport)) {
      errors.push('stage.viewport must be an object with width and height');
    } else {
      const vw = Number(rawStage.viewport.width);
      const vh = Number(rawStage.viewport.height);
      if (!Number.isInteger(vw) || vw < 320 || vw % 2 !== 0) {
        errors.push('stage.viewport.width must be an even integer >= 320');
      }
      if (!Number.isInteger(vh) || vh < 240 || vh % 2 !== 0) {
        errors.push('stage.viewport.height must be an even integer >= 240');
      }
      if (Number.isInteger(vw) && vw >= 320 && vw % 2 === 0 && Number.isInteger(vh) && vh >= 240 && vh % 2 === 0) {
        viewport = { width: vw, height: vh };
      }
    }
  }

  const app = isPlainObject(raw.app)
    ? {
        build: typeof raw.app.build === 'string' ? raw.app.build : undefined,
        dist: typeof raw.app.dist === 'string' ? raw.app.dist : undefined,
        command: typeof raw.app.command === 'string' ? raw.app.command : undefined,
      }
    : undefined;

  const fixRules = isPlainObject(raw.fixRules) ? { ...raw.fixRules } : undefined;
  const steps = Array.isArray(raw.steps) ? raw.steps : undefined;

  // Behavior findings (app-code fixes): before/after app builds instead of before/after rules.
  let behavior;
  if (raw.behavior !== undefined && raw.behavior !== null) {
    if (!isPlainObject(raw.behavior)) {
      errors.push('behavior must be an object');
    } else {
      const b = raw.behavior;
      if (!isPlainObject(b.fixApp) || typeof b.fixApp.dist !== 'string' || !b.fixApp.dist.trim()) {
        errors.push('behavior.fixApp.dist must be the built "after" app directory');
      }
      if (!isPlainObject(b.action) || b.action.kind !== 'sign-out') {
        errors.push('behavior.action.kind must be "sign-out"');
      }
      if (!isPlainObject(b.check) || b.check.kind !== 'presence-entry' || typeof b.check.path !== 'string') {
        errors.push('behavior.check must be { kind: "presence-entry", path, uid }');
      }
      behavior = { ...b };
    }
  }

  if (errors.length > 0) {
    throw new ContractValidationError(`Invalid scenario spec:\n- ${errors.join('\n- ')}`, errors);
  }

  return {
    schema: SCENARIO_SCHEMA,
    finding: { campaign, probe },
    template,
    ...(app ? { app } : {}),
    actors,
    copy,
    stage: {
      layout,
      aspect,
      dimensions: STAGE_ASPECTS[aspect],
      theme,
      slots,
      ...(viewport ? { viewport } : {}),
    },
    ...(steps ? { steps } : {}),
    ...(fixRules ? { fixRules } : {}),
    ...(behavior ? { behavior } : {}),
  };
}

/**
 * Validate a `pyric.evidence.capture.v1` RawCaptureArtifact produced by any CaptureBackend.
 */
export function validateRawCapture(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    throw new ContractValidationError('Raw capture metadata must be a JSON object');
  }
  if (raw.schema !== RAW_CAPTURE_SCHEMA) {
    errors.push(`schema must be "${RAW_CAPTURE_SCHEMA}"`);
  }
  if (!CAPTURE_BACKENDS.includes(raw.backend)) {
    errors.push(`backend must be one of: ${CAPTURE_BACKENDS.join(', ')}`);
  }
  if (typeof raw.platform !== 'string' || raw.platform.length === 0) {
    errors.push('platform must be a non-empty string');
  }
  if (!Array.isArray(raw.actorRoles) || raw.actorRoles.length === 0) {
    errors.push('actorRoles must be a non-empty array of actor role names');
  }
  if (typeof raw.durationMs !== 'number' || !Number.isFinite(raw.durationMs) || raw.durationMs <= 0) {
    errors.push('durationMs must be a positive number');
  }

  const mode = raw.mode;
  if (mode !== 'video' && mode !== 'frames') {
    errors.push('mode must be "video" or "frames"');
  }

  if (mode === 'video') {
    assertNonEmptyString(raw.videoPath, 'videoPath', errors);
    if (typeof raw.fps !== 'number' || raw.fps <= 0) {
      errors.push('fps must be a positive number for mode="video"');
    }
    if (!isPlainObject(raw.cropRects)) {
      errors.push('cropRects must be an object mapping actor role to {x,y,width,height}');
    } else if (Array.isArray(raw.actorRoles)) {
      for (const role of raw.actorRoles) {
        const rect = raw.cropRects[role];
        if (
          !isPlainObject(rect) ||
          typeof rect.x !== 'number' ||
          typeof rect.y !== 'number' ||
          typeof rect.width !== 'number' ||
          typeof rect.height !== 'number' ||
          rect.width <= 0 ||
          rect.height <= 0
        ) {
          errors.push(`cropRects.${role} must be a valid {x, y, width, height} rectangle`);
        }
      }
    }
    if (!Array.isArray(raw.packetTimestampsMs) || raw.packetTimestampsMs.length === 0) {
      errors.push('packetTimestampsMs must be a non-empty array of millisecond timestamps');
    }
  } else if (mode === 'frames') {
    if (!Array.isArray(raw.frames) || raw.frames.length === 0) {
      errors.push('frames must be a non-empty array for mode="frames"');
    } else {
      let prevT = -Infinity;
      for (let i = 0; i < raw.frames.length; i++) {
        const f = raw.frames[i];
        if (!isPlainObject(f) || typeof f.tMs !== 'number' || !Number.isFinite(f.tMs) || f.tMs < prevT) {
          errors.push(`frames[${i}].tMs must be a non-decreasing finite number`);
          break;
        }
        prevT = f.tMs;
        if (!isPlainObject(f.files)) {
          errors.push(`frames[${i}].files must map actor roles to image paths`);
          break;
        }
        for (const role of raw.actorRoles ?? []) {
          if (typeof f.files[role] !== 'string' || f.files[role].length === 0) {
            errors.push(`frames[${i}].files.${role} must be a non-empty path`);
            break;
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new ContractValidationError(`Invalid raw capture artifact:\n- ${errors.join('\n- ')}`, errors);
  }
  return raw;
}

/**
 * Construct the mandatory locked provenance strip from verified execution metadata.
 * Custom stages must render this exact factual text in `[data-pyric-provenance]`.
 */
export function buildLockedProvenanceText({
  decision,
  fixedDecision,
  service,
  method,
  path,
  actorLabel,
}) {
  const verdict = fixedDecision ? `${decision} → ${fixedDecision}` : decision;
  const op = `${service}.${method}`;
  const who = actorLabel ? `as ${actorLabel}` : 'anonymous';
  return `${verdict} / ${op} ${path} / ${who} / Local Pyric sandbox`;
}

/**
 * Build the `window.__PYRIC_EVIDENCE__` payload injected into offline stage HTML pages.
 */
export function buildStagePayload({
  passes,
  scenario,
  fps = 30,
  beats,
  slides,
  evidence,
  provenanceText,
  ...rest
}) {
  if (isPlainObject(passes) && passes.exploit && !passes.repro) passes.repro = passes.exploit;
  if (!isPlainObject(passes) || (!isPlainObject(passes.repro) && !isPlainObject(passes.repro))) {
    throw new ContractValidationError('buildStagePayload requires passes.repro frame map');
  }
  return {
    schema: STAGE_PAYLOAD_SCHEMA,
    fps,
    dimensions: scenario.stage.dimensions,
    finding: scenario.finding,
    template: scenario.template,
    actors: scenario.actors,
    copy: scenario.copy,
    stage: scenario.stage,
    beats,
    ...(Array.isArray(slides) ? { slides } : {}),
    passes: passes.repro ? passes : { ...passes, repro: passes.repro },
    evidence,
    provenanceText,
  };
}

/**
 * Validate a `pyric.evidence.bundle.v1` manifest.json object.
 */
export function validateBundleManifest(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    throw new ContractValidationError('Bundle manifest must be a JSON object');
  }
  if (raw.schema !== BUNDLE_SCHEMA) {
    errors.push(`schema must be "${BUNDLE_SCHEMA}"`);
  }
  if (raw.status !== 'reproduced' && raw.status !== 'not-reproduced') {
    errors.push('status must be "reproduced" or "not-reproduced"');
  }
  if (!isPlainObject(raw.finding)) {
    errors.push('finding must be an object');
  }
  if (!isPlainObject(raw.gates)) {
    errors.push('gates must be an object');
  }
  if (raw.status === 'reproduced') {
    assertNonEmptyString(raw.provenanceText, 'provenanceText', errors);
    if (!isPlainObject(raw.artifacts) || typeof raw.artifacts.poster !== 'string') {
      errors.push('reproduced bundle must include artifacts.poster');
    }
  }
  if (errors.length > 0) {
    throw new ContractValidationError(`Invalid bundle manifest:\n- ${errors.join('\n- ')}`, errors);
  }
  return raw;
}
