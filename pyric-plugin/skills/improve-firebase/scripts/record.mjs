#!/usr/bin/env node

/**
 * Isolated security-finding reproducer & recorder for Pyric evidence videos.
 *
 * Spins up an ephemeral in-memory Pyric sandbox (`--hosted --bridge --fresh --port 0 --json`,
 * never `--persist`, never mutating active `.pyric/`), verifies Gates G1-G5 against real
 * rule evaluation, captures `2x` actor views via the OS-appropriate `CaptureBackend` when
 * in app-view mode, and emits a validated evidence bundle directory ready for `render.mjs`.
 *
 * Zero external runtime dependencies (Node >=22.15 built-ins + local modules).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  BUNDLE_SCHEMA,
  ContractValidationError,
  DEFAULT_VIEWPORT_DIP,
  SCENARIO_SCHEMA,
  buildLockedProvenanceText,
  validateBundleManifest,
  validateScenario,
} from './lib/contracts.mjs';
import { findProjectPlaywright, loadPlaywright, resolveChromiumExecutable } from './lib/runtime.mjs';
import { selectCaptureBackend } from './lib/capture/backend.mjs';
import {
  buildScenarioFromAssurance,
  normalizeAssuranceOperation,
  parseCampaignExport,
  selectProbeFromExport,
} from './lib/from-assurance.mjs';
import {
  extractFocusedRuleSnippet,
  formatSdkSnippet,
  normalizeServiceName,
  parseJsonWithComments,
} from './lib/op-snippet.mjs';
import { IsolatedSandbox } from './lib/sandbox-client.mjs';
import { ensureActorPageHydrated, signInActorPage, withOffOriginNavigationGuard } from './lib/identity.mjs';
import { executeStep } from './lib/steps.mjs';
import {
  evaluateGateG1,
  evaluateGateG2,
  evaluateGateG3,
  evaluateGateG4,
  evaluateGateG5,
  writeFailureBundle,
} from './lib/gates.mjs';

export class EvidenceRecordError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EvidenceRecordError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonFile(filePath, label = 'JSON file') {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new EvidenceRecordError(
      'INVALID_JSON',
      `Failed to parse ${label} at ${filePath}: ${err.message}`,
    );
  }
}

function slugify(value) {
  const cleaned = String(value || 'finding')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'finding';
}

function readFlagValue(argv, index, flagName) {
  const arg = argv[index];
  const eqIdx = arg.indexOf('=');
  if (eqIdx !== -1) {
    return { value: arg.slice(eqIdx + 1), nextIndex: index };
  }
  if (index + 1 >= argv.length) {
    throw new EvidenceRecordError('INVALID_CLI_ARGS', `Flag ${flagName} requires a value`);
  }
  return { value: argv[index + 1], nextIndex: index + 1 };
}

export function parseRecordCliArgs(argv) {
  const opts = {
    campaignPath: null,
    probeId: null,
    scenarioPath: null,
    fixRulesPath: null,
    rtdbRulesPath: null,
    firestoreRulesPath: null,
    storageRulesPath: null,
    firebaseConfigPath: null,
    seedDir: null,
    projectDir: process.cwd(),
    appUrl: null,
    backend: 'auto',
    outDir: null,
    exactOut: false,
    strictTargetHash: false,
    rebuild: false,
    render: false,
    stagePath: null,
    sizeStr: null,
    formats: ['mp4'],
    fps: 30,
    outVideoPath: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--exact-out') {
      opts.exactOut = true;
    } else if (arg === '--strict-target-hash') {
      opts.strictTargetHash = true;
    } else if (arg === '--rebuild') {
      opts.rebuild = true;
    } else if (arg === '--render') {
      opts.render = true;
    } else if (arg === '--campaign' || arg.startsWith('--campaign=')) {
      const parsed = readFlagValue(argv, i, '--campaign');
      opts.campaignPath = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--probe' || arg.startsWith('--probe=')) {
      const parsed = readFlagValue(argv, i, '--probe');
      opts.probeId = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--scenario' || arg.startsWith('--scenario=')) {
      const parsed = readFlagValue(argv, i, '--scenario');
      opts.scenarioPath = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--fix-rules' || arg.startsWith('--fix-rules=')) {
      const parsed = readFlagValue(argv, i, '--fix-rules');
      opts.fixRulesPath = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (
      arg === '--rtdb-rules' ||
      arg.startsWith('--rtdb-rules=') ||
      arg === '--database-rules' ||
      arg.startsWith('--database-rules=')
    ) {
      const parsed = readFlagValue(argv, i, '--rtdb-rules');
      opts.rtdbRulesPath = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--firestore-rules' || arg.startsWith('--firestore-rules=')) {
      const parsed = readFlagValue(argv, i, '--firestore-rules');
      opts.firestoreRulesPath = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--storage-rules' || arg.startsWith('--storage-rules=')) {
      const parsed = readFlagValue(argv, i, '--storage-rules');
      opts.storageRulesPath = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--firebase-config' || arg.startsWith('--firebase-config=')) {
      const parsed = readFlagValue(argv, i, '--firebase-config');
      opts.firebaseConfigPath = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--seed' || arg.startsWith('--seed=')) {
      const parsed = readFlagValue(argv, i, '--seed');
      opts.seedDir = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--project' || arg.startsWith('--project=')) {
      const parsed = readFlagValue(argv, i, '--project');
      opts.projectDir = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--app-url' || arg.startsWith('--app-url=')) {
      const parsed = readFlagValue(argv, i, '--app-url');
      opts.appUrl = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--backend' || arg.startsWith('--backend=')) {
      const parsed = readFlagValue(argv, i, '--backend');
      opts.backend = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const parsed = readFlagValue(argv, i, '--out');
      opts.outDir = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--stage' || arg.startsWith('--stage=')) {
      const parsed = readFlagValue(argv, i, '--stage');
      opts.stagePath = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--size' || arg.startsWith('--size=')) {
      const parsed = readFlagValue(argv, i, '--size');
      opts.sizeStr = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--formats' || arg.startsWith('--formats=')) {
      const parsed = readFlagValue(argv, i, '--formats');
      opts.formats = parsed.value
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      i = parsed.nextIndex;
    } else if (arg === '--fps' || arg.startsWith('--fps=')) {
      const parsed = readFlagValue(argv, i, '--fps');
      const parsedFps = Number(parsed.value);
      if (!Number.isInteger(parsedFps) || parsedFps < 1 || parsedFps > 120) {
        throw new EvidenceRecordError('INVALID_CLI_ARGS', `--fps must be an integer between 1 and 120`);
      }
      opts.fps = parsedFps;
      i = parsed.nextIndex;
    } else if (arg === '--out-video' || arg.startsWith('--out-video=')) {
      const parsed = readFlagValue(argv, i, '--out-video');
      opts.outVideoPath = path.resolve(parsed.value);
      i = parsed.nextIndex;
    } else {
      throw new EvidenceRecordError('INVALID_CLI_ARGS', `Unknown argument "${arg}"`);
    }
  }

  if (!opts.help) {
    if (!opts.campaignPath && !opts.scenarioPath) {
      throw new EvidenceRecordError(
        'INVALID_CLI_ARGS',
        'Must provide --campaign <export.json> or --scenario <scenario.json>',
      );
    }
    if (!opts.outDir) {
      throw new EvidenceRecordError('INVALID_CLI_ARGS', 'Must provide --out <evidenceDir>');
    }
  }

  return opts;
}

function collectTargetDisplayTexts(scenario, exploitOperation) {
  const texts = [];
  const push = (val) => {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed.length >= 3 && !texts.includes(trimmed)) {
        texts.push(trimmed);
      }
    }
  };
  push(exploitOperation?.data?.text);
  push(exploitOperation?.data?.title);
  push(exploitOperation?.data?.body);
  push(scenario?.actors?.victim?.expect?.after?.text);
  push(scenario?.actors?.victim?.expect?.before?.text);
  push(scenario?.actors?.attacker?.expect?.before?.text);
  return texts;
}

export async function prepareActorUiForRecording(page, { targetTexts = [], collapseSidebar = true } = {}) {
  if (!page || typeof page.evaluate !== 'function') return;
  await page
    .evaluate(
      ({ texts, shouldCollapseSidebar }) => {
        const vw = window.innerWidth || 900;
        const vh = window.innerHeight || 675;

        const containsTarget = (el) => {
          if (!el || !texts.length) return false;
          const raw = el.innerText || el.textContent || '';
          return texts.some((t) => raw.includes(t));
        };

        let styleEl = document.getElementById('__pyric-stage-ui-clean');
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = '__pyric-stage-ui-clean';
          styleEl.textContent = `
            [data-pyric-collapsed="1"],
            [data-pyric-collapsed="1"] * {
              display: none !important;
              width: 0 !important;
              min-width: 0 !important;
              flex: 0 0 0 !important;
              overflow: hidden !important;
              backdrop-filter: none !important;
              -webkit-backdrop-filter: none !important;
              filter: none !important;
              opacity: 0 !important;
              pointer-events: none !important;
            }
          `;
          (document.head || document.documentElement).appendChild(styleEl);
        }

        // 1. Dismiss first-run modals, ToS gates, tours, and notification dialogs that obscure content
        const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
        let hidAnyDialog = false;
        for (const dlg of dialogs) {
          if (containsTarget(dlg)) continue;
          const scrollAreas = dlg.querySelectorAll('[class*="overflow-y-auto"], [style*="overflow"]');
          for (const area of scrollAreas) {
            area.scrollTop = area.scrollHeight;
          }
          const buttons = dlg.querySelectorAll('button, [role="button"]');
          let clicked = false;
          for (const btn of buttons) {
            const label = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
            if (/^(accept|i agree|agree|continue|skip|not right now|not now|dismiss|close|later|no thanks|got it|done)$/i.test(label)) {
              btn.click();
              clicked = true;
              break;
            }
          }
          if (!clicked) {
            const rect = dlg.getBoundingClientRect();
            if (rect.width > vw * 0.18 || rect.height > vh * 0.14) {
              dlg.setAttribute('data-pyric-collapsed', '1');
              hidAnyDialog = true;
            }
          }
        }
        if (hidAnyDialog) {
          const overlays = document.querySelectorAll(
            '[data-slot="dialog-overlay"], [data-radix-dialog-overlay], [class*="backdrop-blur"]',
          );
          for (const ov of overlays) {
            if (!containsTarget(ov)) {
              ov.setAttribute('data-pyric-collapsed', '1');
            }
          }
        }

        // 2. Collapse redundant flush-left navigation rails when requested
        if (shouldCollapseSidebar) {
          const railCandidates = document.querySelectorAll(
            'aside, nav, [class*="leftPane" i], [class*="sidebar" i], [class*="navRail" i], [class*="drawer" i]',
          );
          for (const rail of railCandidates) {
            if (containsTarget(rail)) continue;
            const rect = rail.getBoundingClientRect();
            const isFlushLeftRail =
              rect.left <= 24 &&
              rect.width >= 150 &&
              rect.width <= Math.min(460, vw * 0.52) &&
              rect.height >= vh * 0.5;
            if (isFlushLeftRail) {
              rail.setAttribute('data-pyric-collapsed', '1');
            }
          }
        }

        // 3. Center target content in viewport if present
        if (texts.length > 0 && document.body) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let matchedNode = null;
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const str = node.nodeValue || '';
            if (!str.trim()) continue;
            const parent = node.parentElement;
            if (!parent || parent.closest('[data-pyric-collapsed="1"]')) continue;
            const pr = parent.getBoundingClientRect();
            if (pr.width <= 0 || pr.height <= 0) continue;
            if (texts.some((t) => str.includes(t))) {
              matchedNode = node;
              break;
            }
          }
          if (matchedNode?.parentElement) {
            let focusEl = matchedNode.parentElement;
            for (let depth = 0; depth < 6 && focusEl.parentElement; depth += 1) {
              const r = focusEl.parentElement.getBoundingClientRect();
              if (r.height > vh * 0.45 || r.width > vw * 0.94) break;
              focusEl = focusEl.parentElement;
            }
            focusEl.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
          }
        }
      },
      { texts: targetTexts, shouldCollapseSidebar: collapseSidebar },
    )
    .catch(() => {});
}

export async function measureActorTargetFocus(page, targetTexts = []) {
  if (!page || typeof page.evaluate !== 'function' || targetTexts.length === 0) {
    return null;
  }
  return page
    .evaluate((texts) => {
      const vw = window.innerWidth || 900;
      const vh = window.innerHeight || 675;
      if (!document.body) return null;

      const findMatch = (caseInsensitive) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const str = node.nodeValue || '';
          if (!str.trim()) continue;
          const parent = node.parentElement;
          if (!parent || parent.closest('[data-pyric-collapsed="1"]')) continue;
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const pr = parent.getBoundingClientRect();
          if (pr.width <= 0 || pr.height <= 0) continue;
          const hit = caseInsensitive
            ? texts.some((t) => str.toLowerCase().includes(t.toLowerCase()))
            : texts.some((t) => str.includes(t));
          if (hit) {
            return parent;
          }
        }
        return null;
      };

      const leafEl = findMatch(false) || findMatch(true);
      if (!leafEl) return null;

      let chosenRect = leafEl.getBoundingClientRect();
      let bestCardRect = null;
      let cur = leafEl;
      for (let depth = 0; depth < 8 && cur && cur !== document.body; depth += 1) {
        if (cur.getAttribute?.('data-pyric-collapsed') === '1') break;
        const r = cur.getBoundingClientRect();
        if (r.width >= 80 && r.width <= vw * 0.90 && r.height >= 24 && r.height <= vh * 0.40) {
          if (bestCardRect && bestCardRect.width <= vw * 0.62 && r.width > vw * 0.66) {
            break;
          }
          const cs = window.getComputedStyle(cur);
          const hasBg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
          const hasBorder = parseFloat(cs.borderTopWidth || '0') > 0 || parseFloat(cs.borderLeftWidth || '0') > 0;
          const hasRadius = parseFloat(cs.borderRadius || '0') >= 4;
          const semanticCard = cur.matches?.('[data-message-id], [class*="message" i], [class*="bubble" i], [class*="card" i], [class*="item" i], article, li');
          if (semanticCard || hasBg || hasBorder || hasRadius) {
            bestCardRect = r;
          } else if (!bestCardRect && (cs.display === 'block' || cs.display === 'flex' || cs.display === 'grid')) {
            chosenRect = r;
          }
        } else if (r.height > vh * 0.44 || r.width > vw * 0.90) {
          break;
        }
        cur = cur.parentElement;
      }

      const targetRect = bestCardRect || chosenRect;
      if (!targetRect || targetRect.width <= 0 || targetRect.height <= 0) {
        return null;
      }

      const pad = 6;
      const left = Math.max(0, targetRect.left - pad);
      const top = Math.max(0, targetRect.top - pad);
      const right = Math.min(vw, targetRect.right + pad);
      const bottom = Math.min(vh, targetRect.bottom + pad);
      return {
        vw,
        vh,
        x: Number((left / vw).toFixed(4)),
        y: Number((top / vh).toFixed(4)),
        w: Number(((right - left) / vw).toFixed(4)),
        h: Number(((bottom - top) / vh).toFixed(4)),
      };
    }, targetTexts)
    .catch(() => null);
}

async function measureAllActorsFocus(pages, targetTexts) {
  if (!pages || Object.keys(pages).length === 0) return null;
  const out = {};
  for (const role of Object.keys(pages)) {
    const rect = await measureActorTargetFocus(pages[role], targetTexts);
    if (rect) {
      out[role] = rect;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function classifyFixRuleFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new EvidenceRecordError('MISSING_FIX_RULES', `Fix rules file does not exist: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    return { rtdb: filePath };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (/service\s+firebase\.storage\b/i.test(raw) || /storage/i.test(path.basename(filePath))) {
    return { storage: filePath };
  }
  return { firestore: filePath };
}

function resolveScenarioRelativePaths(rawScenario, baseDir) {
  if (!isPlainObject(rawScenario) || !baseDir) return rawScenario;
  const cloned = structuredClone(rawScenario);
  const resolveIfRel = (p) => (typeof p === 'string' && p.trim().length > 0 && !path.isAbsolute(p)
    ? path.resolve(baseDir, p.trim())
    : p);

  if (isPlainObject(cloned.app) && cloned.app.dist) {
    cloned.app.dist = resolveIfRel(cloned.app.dist);
  }
  if (isPlainObject(cloned.fixRules)) {
    for (const key of ['rtdb', 'database', 'firestore', 'storage']) {
      if (cloned.fixRules[key]) {
        const candidate = resolveIfRel(cloned.fixRules[key]);
        if (fs.existsSync(candidate)) {
          cloned.fixRules[key] = candidate;
        }
      }
    }
  }
  if (isPlainObject(cloned.rules)) {
    for (const key of ['rtdb', 'database', 'firestore', 'storage']) {
      if (cloned.rules[key]) {
        cloned.rules[key] = resolveIfRel(cloned.rules[key]);
      }
    }
  }
  return cloned;
}

function synthesizeProbeFromScenario(scenario, rawScenario) {
  let exploitOp = rawScenario?.exploitOperation ?? null;
  if (!exploitOp && Array.isArray(scenario.steps)) {
    const step = scenario.steps.find(
      (s) =>
        isPlainObject(s) &&
        String(s.kind || s.type || '').toLowerCase() === 'sdk' &&
        isPlainObject(s.operation || s.op),
    );
    if (step) {
      const baseOp = step.operation || step.op;
      const frames = Array.isArray(step.frames)
        ? step.frames
        : Array.isArray(step.trajectory)
          ? step.trajectory
          : null;
      exploitOp =
        baseOp.data === undefined && baseOp.value === undefined && frames && frames.length > 0
          ? { ...baseOp, data: frames[frames.length - 1] }
          : baseOp;
    }
  }
  if (!exploitOp && isPlainObject(rawScenario?.operation)) {
    exploitOp = rawScenario.operation;
  }
  if (!exploitOp) {
    throw new EvidenceRecordError(
      'MISSING_EXPLOIT_OPERATION',
      'Scenario without --campaign must specify an SDK step with operation or exploitOperation',
    );
  }

  return {
    campaignId: scenario.finding.campaign,
    probeId: scenario.finding.probe,
    targetHash: rawScenario?.finding?.targetHash ?? 'scenario-inline',
    classification: rawScenario?.finding?.classification ?? 'confirmed',
    actorEvidence: {
      victimUid: scenario.actors.victim?.uid || 'alice',
      victimLabel: scenario.actors.victim?.name,
      ...(scenario.actors.attacker
        ? {
            attackerUid: scenario.actors.attacker.uid,
            actorLabel: scenario.actors.attacker.name,
          }
        : { attackerUid: null }),
    },
    invariant: {
      id: scenario.finding.probe,
      name: scenario.copy.title,
      severity: scenario.copy.severity || 'HIGH',
      description: scenario.copy.why,
    },
    mutationSpec: {
      operation: exploitOp,
      exploitDescription: scenario.copy.exploit,
    },
    ...(isPlainObject(rawScenario?.seed) ? { mutation: { before: rawScenario.seed } } : {}),
  };
}

function resolveFixRulesSpec(fixRulesObj, baseDir) {
  if (!isPlainObject(fixRulesObj)) return null;
  const spec = {};
  let hasAny = false;

  const rtdbSpec = fixRulesObj.rtdb ?? fixRulesObj.database;
  if (typeof rtdbSpec === 'string' && rtdbSpec.trim().length > 0) {
    const resolved = path.isAbsolute(rtdbSpec) ? rtdbSpec : path.resolve(baseDir, rtdbSpec);
    const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : rtdbSpec;
    spec.rtdbRules = parseJsonWithComments(content);
    spec.rawSnippet = content.trim();
    hasAny = true;
  } else if (isPlainObject(rtdbSpec)) {
    spec.rtdbRules = rtdbSpec;
    spec.rawSnippet = JSON.stringify(rtdbSpec, null, 2);
    hasAny = true;
  }

  if (typeof fixRulesObj.firestore === 'string' && fixRulesObj.firestore.trim().length > 0) {
    const resolved = path.isAbsolute(fixRulesObj.firestore)
      ? fixRulesObj.firestore
      : path.resolve(baseDir, fixRulesObj.firestore);
    const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : fixRulesObj.firestore;
    spec.firestoreRules = content;
    spec.rawSnippet = content.trim();
    hasAny = true;
  }

  if (typeof fixRulesObj.storage === 'string' && fixRulesObj.storage.trim().length > 0) {
    const resolved = path.isAbsolute(fixRulesObj.storage)
      ? fixRulesObj.storage
      : path.resolve(baseDir, fixRulesObj.storage);
    const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : fixRulesObj.storage;
    spec.storageRules = content;
    spec.rawSnippet = content.trim();
    hasAny = true;
  }

  return hasAny ? spec : null;
}

function computeStateDiff(beforeVal, afterVal, basePath) {
  if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) {
    return { changedPaths: [], before: beforeVal ?? null, after: afterVal ?? null };
  }
  const changedPaths = [];
  if (isPlainObject(beforeVal) && isPlainObject(afterVal)) {
    const keys = new Set([...Object.keys(beforeVal), ...Object.keys(afterVal)]);
    for (const k of keys) {
      if (JSON.stringify(beforeVal[k]) !== JSON.stringify(afterVal[k])) {
        changedPaths.push(`${basePath.replace(/\/+$/, '')}/${k}`);
      }
    }
  }
  if (changedPaths.length === 0) {
    changedPaths.push(basePath);
  }
  return {
    changedPaths,
    before: beforeVal ?? null,
    after: afterVal ?? null,
  };
}

function prepareIsolatedSandboxInputs({
  projectDir,
  firebaseConfigPath,
  scenario,
  rawScenario,
  campaignExport,
  exploitOperation,
  initialSeedValue,
  seedDir,
}) {
  const scratchCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-rec-cfg-'));
  let resolvedConfigPath = firebaseConfigPath && fs.existsSync(firebaseConfigPath) ? firebaseConfigPath : null;
  if (!resolvedConfigPath) {
    const defaultCfg = path.join(projectDir, 'firebase.json');
    if (fs.existsSync(defaultCfg)) {
      resolvedConfigPath = defaultCfg;
    }
  }

  let baseCfg = resolvedConfigPath ? readJsonFile(resolvedConfigPath, 'firebase.json') : {};
  if (!isPlainObject(baseCfg)) baseCfg = {};
  const cfgDir = resolvedConfigPath ? path.dirname(resolvedConfigPath) : projectDir;
  const synthesizedCfg = structuredClone(baseCfg);

  // Resolve rules paths relative to original config dir so they stay valid from scratchCfgDir
  const arrayRtdbEntry = Array.isArray(synthesizedCfg.database)
    ? synthesizedCfg.database.find((d) => isPlainObject(d) && d.target === 'main' && typeof d.rules === 'string') ||
      synthesizedCfg.database.find((d) => isPlainObject(d) && d.target === 'default' && typeof d.rules === 'string') ||
      synthesizedCfg.database.find((d) => isPlainObject(d) && typeof d.rules === 'string')
    : null;

  const rtdbRuleCandidate =
    rawScenario?.rules?.rtdb ??
    rawScenario?.rules?.database ??
    (campaignExport?.target?.databaseRulesPath
      ? path.resolve(projectDir, campaignExport.target.databaseRulesPath)
      : null) ??
    (arrayRtdbEntry?.rules
      ? path.resolve(cfgDir, arrayRtdbEntry.rules)
      : synthesizedCfg.database?.rules
        ? path.resolve(cfgDir, synthesizedCfg.database.rules)
        : null);

  const explicitRtdbRuleOverride =
    rawScenario?.rules?.rtdb ??
    rawScenario?.rules?.database ??
    (campaignExport?.target?.databaseRulesPath
      ? path.resolve(projectDir, campaignExport.target.databaseRulesPath)
      : null);

  if (explicitRtdbRuleOverride && fs.existsSync(explicitRtdbRuleOverride)) {
    const resolvedOverride = path.resolve(explicitRtdbRuleOverride);
    const overrideBase = path.basename(resolvedOverride);
    const overrideDir = path.dirname(resolvedOverride);
    if (Array.isArray(synthesizedCfg.database)) {
      const hasMultipleDistinctRuleFiles =
        new Set(
          synthesizedCfg.database
            .filter((d) => isPlainObject(d) && typeof d.rules === 'string')
            .map((d) => path.basename(d.rules)),
        ).size > 1;
      synthesizedCfg.database = synthesizedCfg.database.map((d) => {
        if (!isPlainObject(d)) return d;
        const entryBase = typeof d.rules === 'string' ? path.basename(d.rules) : '';
        if (!hasMultipleDistinctRuleFiles || entryBase === overrideBase || d.target === 'main') {
          return { ...d, rules: resolvedOverride };
        }
        const siblingRule = entryBase ? path.join(overrideDir, entryBase) : null;
        if (siblingRule && fs.existsSync(siblingRule)) {
          return { ...d, rules: siblingRule };
        }
        return typeof d.rules === 'string'
          ? { ...d, rules: path.resolve(cfgDir, d.rules) }
          : { ...d, rules: resolvedOverride };
      });
    } else {
      synthesizedCfg.database = {
        ...(isPlainObject(synthesizedCfg.database) ? synthesizedCfg.database : {}),
        rules: resolvedOverride,
      };
    }
  } else if (Array.isArray(synthesizedCfg.database)) {
    synthesizedCfg.database = synthesizedCfg.database.map((d) =>
      isPlainObject(d) && typeof d.rules === 'string'
        ? { ...d, rules: path.resolve(cfgDir, d.rules) }
        : d,
    );
  } else if (rtdbRuleCandidate && fs.existsSync(rtdbRuleCandidate)) {
    synthesizedCfg.database = {
      ...(isPlainObject(synthesizedCfg.database) ? synthesizedCfg.database : {}),
      rules: path.resolve(rtdbRuleCandidate),
    };
  } else if (exploitOperation.service === 'database' && !synthesizedCfg.database) {
    const openRulesPath = path.join(scratchCfgDir, 'database.rules.json');
    fs.writeFileSync(
      openRulesPath,
      JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } }, null, 2),
      'utf8',
    );
    synthesizedCfg.database = { rules: openRulesPath };
  }

  const fsRuleCandidate =
    rawScenario?.rules?.firestore ??
    (campaignExport?.target?.rulesPath
      ? path.resolve(projectDir, campaignExport.target.rulesPath)
      : null) ??
    (synthesizedCfg.firestore?.rules ? path.resolve(cfgDir, synthesizedCfg.firestore.rules) : null);

  if (fsRuleCandidate && fs.existsSync(fsRuleCandidate)) {
    synthesizedCfg.firestore = {
      ...(isPlainObject(synthesizedCfg.firestore) ? synthesizedCfg.firestore : {}),
      rules: path.resolve(fsRuleCandidate),
    };
    if (synthesizedCfg.firestore.indexes) {
      synthesizedCfg.firestore.indexes = path.resolve(cfgDir, synthesizedCfg.firestore.indexes);
    }
  }

  const storageRuleCandidate =
    rawScenario?.rules?.storage ??
    (synthesizedCfg.storage?.rules ? path.resolve(cfgDir, synthesizedCfg.storage.rules) : null);
  if (storageRuleCandidate && fs.existsSync(storageRuleCandidate)) {
    synthesizedCfg.storage = {
      ...(isPlainObject(synthesizedCfg.storage) ? synthesizedCfg.storage : {}),
      rules: path.resolve(storageRuleCandidate),
    };
  }

  // Wire app dist into Pyric hosting when scenario.app.dist is specified
  if (scenario.app?.dist) {
    const absDist = path.resolve(scenario.app.dist);
    if (!fs.existsSync(absDist)) {
      throw new EvidenceRecordError(
        'MISSING_APP_DIST',
        `Built app directory not found at ${absDist}. Run build first or provide scenario.app.build.`,
      );
    }
    synthesizedCfg.hosting = {
      public: absDist,
      rewrites: [{ source: '**', destination: '/index.html' }],
    };
  } else if (synthesizedCfg.hosting) {
    if (Array.isArray(synthesizedCfg.hosting)) {
      synthesizedCfg.hosting = synthesizedCfg.hosting.map((h) =>
        isPlainObject(h) && typeof h.public === 'string'
          ? { ...h, public: path.resolve(cfgDir, h.public) }
          : h,
      );
    } else if (isPlainObject(synthesizedCfg.hosting) && typeof synthesizedCfg.hosting.public === 'string') {
      synthesizedCfg.hosting = {
        ...synthesizedCfg.hosting,
        public: path.resolve(cfgDir, synthesizedCfg.hosting.public),
      };
    }
  }

  const outFirebaseConfigPath = path.join(scratchCfgDir, 'firebase.json');
  fs.writeFileSync(outFirebaseConfigPath, `${JSON.stringify(synthesizedCfg, null, 2)}\n`, 'utf8');

  let resolvedSeedPath = seedDir;
  if (!resolvedSeedPath && rawScenario?.seedFile) {
    resolvedSeedPath = path.resolve(projectDir, rawScenario.seedFile);
  }
  if (!resolvedSeedPath && initialSeedValue !== undefined && exploitOperation.service === 'database') {
    const seedTree = {};
    const parts = exploitOperation.path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let cursor = seedTree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    if (parts.length > 0) {
      cursor[parts[parts.length - 1]] = structuredClone(initialSeedValue);
    }
    resolvedSeedPath = path.join(scratchCfgDir, 'seed.json');
    fs.writeFileSync(resolvedSeedPath, JSON.stringify({ database: seedTree }, null, 2), 'utf8');
  }

  const serviceRuleMap = {
    database: rtdbRuleCandidate,
    firestore: fsRuleCandidate,
    storage: storageRuleCandidate,
  };
  const primaryRuleCandidate = serviceRuleMap[exploitOperation.service] || rtdbRuleCandidate || fsRuleCandidate || storageRuleCandidate;
  const initialRuleFile =
    primaryRuleCandidate && fs.existsSync(primaryRuleCandidate)
      ? path.resolve(primaryRuleCandidate)
      : null;

  return {
    scratchCfgDir,
    firebaseConfigPath: outFirebaseConfigPath,
    seedDir: resolvedSeedPath,
    initialRuleFile,
  };
}

async function checkVictimDomExpectation(page, expectSpec, timeoutMs = 6000) {
  if (!expectSpec || !isPlainObject(expectSpec) || Object.keys(expectSpec).length === 0) {
    return { pass: true, reason: null };
  }
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    let ok = true;
    let reason = null;

    if (expectSpec.text !== undefined && !bodyText.includes(String(expectSpec.text))) {
      ok = false;
      reason = `Expected text "${expectSpec.text}" not visible in victim DOM`;
    }
    if (ok && expectSpec.notText !== undefined && bodyText.includes(String(expectSpec.notText))) {
      ok = false;
      reason = `Forbidden text "${expectSpec.notText}" still visible in victim DOM`;
    }
    if (ok && expectSpec.selector) {
      const visible = await page
        .locator(expectSpec.selector)
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) {
        ok = false;
        reason = `Expected selector "${expectSpec.selector}" not visible`;
      }
    }
    if (ok) {
      return { pass: true, reason: null };
    }
    await sleep(60);
  }
  const finalBody = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return {
    pass: false,
    reason:
      expectSpec.text !== undefined && !finalBody.includes(String(expectSpec.text))
        ? `Expected text "${expectSpec.text}" not found in victim DOM (got: ${finalBody.slice(0, 120)})`
        : expectSpec.notText !== undefined
          ? `Forbidden text "${expectSpec.notText}" still present in victim DOM`
          : 'Expectation timed out',
  };
}

async function saveFailureTraces(contexts, bundleDir) {
  const ctxList = Object.values(contexts || {}).filter(
    (c) => c && c.tracing && typeof c.tracing.stop === 'function',
  );
  if (ctxList.length === 0) return undefined;
  const tracePath = path.join(bundleDir, 'trace.zip');
  try {
    await ctxList[0].tracing.stop({ path: tracePath });
    for (let i = 1; i < ctxList.length; i += 1) {
      await ctxList[i].tracing.stop().catch(() => {});
    }
    return fs.existsSync(tracePath) ? 'trace.zip' : undefined;
  } catch {
    return undefined;
  }
}

async function stopTracingQuietly(contexts) {
  for (const ctx of Object.values(contexts || {})) {
    if (ctx && ctx.tracing && typeof ctx.tracing.stop === 'function') {
      await ctx.tracing.stop().catch(() => {});
    }
  }
}

/**
 * Reproduce, verify (Gates G1-G5), and record an evidence bundle for one security finding.
 */
export async function recordEvidence(options = {}) {
  const {
    campaignPath = null,
    probeId = null,
    scenarioPath = null,
    fixRulesPath = null,
    rtdbRulesPath = null,
    firestoreRulesPath = null,
    storageRulesPath = null,
    firebaseConfigPath = null,
    seedDir = null,
    projectDir = process.cwd(),
    appUrl = null,
    backend = 'auto',
    outDir,
    exactOut = false,
    strictTargetHash = false,
    rebuild = false,
    render = false,
    stagePath = null,
    sizeStr = null,
    formats = ['mp4', 'gif'],
    fps = 30,
    outVideoPath = null,
    log = () => {},
  } = options;

  if (!outDir) {
    throw new EvidenceRecordError('INVALID_ARGS', 'recordEvidence requires outDir');
  }

  const baseDir = path.resolve(projectDir);
  const cliFixRules = {
    ...(fixRulesPath ? classifyFixRuleFile(fixRulesPath) : {}),
    ...(rtdbRulesPath ? { rtdb: rtdbRulesPath } : {}),
    ...(firestoreRulesPath ? { firestore: firestoreRulesPath } : {}),
    ...(storageRulesPath ? { storage: storageRulesPath } : {}),
  };
  const hasCliFixRules = Object.keys(cliFixRules).length > 0;

  let rawScenario = null;
  let scenarioBaseDir = baseDir;
  if (scenarioPath) {
    scenarioBaseDir = path.dirname(path.resolve(scenarioPath));
    rawScenario = resolveScenarioRelativePaths(
      readJsonFile(scenarioPath, 'scenario.json'),
      scenarioBaseDir,
    );
  }

  let campaignExport = null;
  let selectedProbe = null;
  let resolvedPlan = null;

  if (campaignPath) {
    campaignExport = parseCampaignExport(readJsonFile(campaignPath, 'campaign export'));
    selectedProbe = selectProbeFromExport(campaignExport, probeId);
    resolvedPlan = buildScenarioFromAssurance({
      campaignExport,
      probe: selectedProbe,
      scenarioOverride: rawScenario,
      fixRules: hasCliFixRules ? cliFixRules : null,
    });
  } else if (rawScenario) {
    const mergedRaw = {
      ...rawScenario,
      schema: rawScenario.schema || SCENARIO_SCHEMA,
      ...(hasCliFixRules
        ? { fixRules: { ...(rawScenario.fixRules || {}), ...cliFixRules } }
        : {}),
    };
    const validatedPre = validateScenario(mergedRaw);
    selectedProbe = synthesizeProbeFromScenario(validatedPre, mergedRaw);
    campaignExport = parseCampaignExport({
      schema: 'pyric.assurance.export.v1',
      campaignId: validatedPre.finding.campaign,
      target: {
        service: normalizeServiceName(
          selectedProbe.mutationSpec.operation.service || 'database',
        ),
        databaseRulesPath: rawScenario.rules?.rtdb || rawScenario.rules?.database,
        rulesPath: rawScenario.rules?.firestore || rawScenario.rules?.storage,
      },
      probes: [selectedProbe],
    });
    resolvedPlan = buildScenarioFromAssurance({
      campaignExport,
      probe: selectedProbe,
      scenarioOverride: mergedRaw,
      fixRules: hasCliFixRules ? cliFixRules : null,
    });
  } else {
    throw new EvidenceRecordError(
      'INVALID_ARGS',
      'recordEvidence requires either campaignPath or scenarioPath',
    );
  }

  const {
    scenario,
    probe,
    controlOperation,
    exploitOperation,
    exploitSnippet,
    controlSnippet,
    initialSeedValue,
  } = resolvedPlan;

  const probeSlug = slugify(scenario.finding.probe);
  const resolvedOutRoot = path.resolve(outDir);
  const bundleDir =
    exactOut || path.basename(resolvedOutRoot) === probeSlug
      ? resolvedOutRoot
      : path.join(resolvedOutRoot, probeSlug);

  fs.mkdirSync(bundleDir, { recursive: true });
  for (const stale of ['video.mp4', 'preview.gif', 'trace.zip']) {
    const p = path.join(bundleDir, stale);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }

  const actorLabel =
    scenario.actors.attacker?.uid ||
    scenario.actors.attacker?.name ||
    'anonymous';
  const fixRulesSpec = resolveFixRulesSpec(scenario.fixRules, scenarioBaseDir);
  const hasFix = Boolean(fixRulesSpec);

  const partialProvenance = buildLockedProvenanceText({
    decision: 'PENDING',
    fixedDecision: hasFix ? 'PENDING' : undefined,
    service: exploitOperation.service,
    method: exploitOperation.method,
    path: exploitOperation.path,
    actorLabel,
  });

  // Gate G1: Preconditions (must pass before launching sandbox/browsers)
  const expectedTargetHash = strictTargetHash
    ? campaignExport.target?.databaseRulesHash ?? campaignExport.target?.rulesHash
    : undefined;
  const g1 = evaluateGateG1(probe, { expectedTargetHash });
  if (!g1.pass) {
    writeFailureBundle({
      outDir: bundleDir,
      finding: scenario.finding,
      failedGate: 'G1',
      reasons: g1.reasons,
      provenanceText: partialProvenance,
    });
    throw new EvidenceRecordError('GATE_G1_FAILED', g1.reasons.join('; '), { gate: g1 });
  }

  // Optional build step if scenario.app.build is present and dist is absent or --rebuild passed
  if (scenario.app?.build && !appUrl) {
    const needsBuild = rebuild || !scenario.app.dist || !fs.existsSync(scenario.app.dist);
    if (needsBuild) {
      log(`Running app build: ${scenario.app.build}`);
      execSync(scenario.app.build, { cwd: baseDir, stdio: 'inherit' });
    }
  }

  const hasUiSteps =
    Array.isArray(scenario.steps) &&
    scenario.steps.some((s) => {
      const k = String(s?.kind || s?.type || '').toLowerCase();
      return k === 'ui' || k === 'wait-expect' || k === 'sign-in';
    });
  const isAppView =
    scenario.stage.layout !== 'data-plane' &&
    Boolean(appUrl || scenario.app || hasUiSteps);

  const cfgSetup = prepareIsolatedSandboxInputs({
    projectDir: baseDir,
    firebaseConfigPath,
    scenario,
    rawScenario,
    campaignExport,
    exploitOperation,
    initialSeedValue,
    seedDir,
  });

  let sandbox = null;
  let captureBackend = null;
  let contexts = {};
  let signalCleanup = null;

  try {
    sandbox = await IsolatedSandbox.start({
      projectDir: baseDir,
      projectId:
        typeof rawScenario?.project === 'string' && rawScenario.project.trim()
          ? rawScenario.project.trim()
          : undefined,
      firebaseConfigPath: cfgSetup.firebaseConfigPath,
      seedDir: cfgSetup.seedDir,
      functions: false,
    });

    const effectiveAppUrl = appUrl || sandbox.uiUrl || sandbox.url;

    const cleanupOnSignal = async () => {
      if (captureBackend) await captureBackend.dispose().catch(() => {});
      if (sandbox) await sandbox.dispose().catch(() => {});
    };
    const sigHandler = () => {
      void cleanupOnSignal().finally(() => process.exit(130));
    };
    process.once('SIGINT', sigHandler);
    process.once('SIGTERM', sigHandler);
    signalCleanup = () => {
      process.removeListener('SIGINT', sigHandler);
      process.removeListener('SIGTERM', sigHandler);
    };

    // Provision actors and mint local sandbox auth tokens
    const tokenMap = new Map();
    for (const [role, actor] of Object.entries(scenario.actors)) {
      if (!actor || !actor.uid) continue;
      await sandbox.ensureUser({
        uid: actor.uid,
        email: actor.email || `${actor.uid}@pyric.local`,
        password: actor.password || `sandbox-${actor.uid}-pw`,
        displayName: actor.name || actor.uid,
        customClaims: actor.claims || {},
      });
      const tok = await sandbox.mintCustomToken(actor.uid, actor.claims || {});
      tokenMap.set(role, tok);
      tokenMap.set(actor.uid, tok);
    }

    const victimRole = 'victim';
    const victimToken = tokenMap.get(victimRole) || null;
    const attackerRole = scenario.actors.attacker ? 'attacker' : null;
    const attackerToken = attackerRole ? tokenMap.get(attackerRole) ?? null : null;

    // Seed baseline target state if not already seeded
    if (initialSeedValue !== undefined) {
      const existingBefore = await sandbox
        .readState(exploitOperation.service, exploitOperation.path, victimToken)
        .catch(() => null);
      if (existingBefore === null || existingBefore === undefined) {
        await sandbox.executeOperation({
          operation: {
            service: exploitOperation.service,
            method: exploitOperation.service === 'firestore' ? 'setDoc' : 'set',
            path: exploitOperation.path,
            data: structuredClone(initialSeedValue),
          },
          idToken: victimToken,
        });
      }
    }

    const recordedEvents = [];
    let pages = {};
    let captureArtifact = null;
    let captureStartMs = performance.now();
    let uiReadyAtMs = null;

    if (isAppView) {
      const pwSearchDir = findProjectPlaywright(baseDir)
        ? baseDir
        : findProjectPlaywright(process.cwd())
          ? process.cwd()
          : path.dirname(fileURLToPath(import.meta.url));
      const pw = await loadPlaywright({ projectDir: pwSearchDir, log });
      const executablePath = resolveChromiumExecutable(pw.chromium);
      captureBackend = selectCaptureBackend({ backend });
      log(`Starting ${captureBackend.name} capture for ${Object.keys(scenario.actors).join(', ')}...`);
      const started = await captureBackend.start({
        actors: scenario.actors,
        outputDir: bundleDir,
        viewport: scenario.stage?.viewport || DEFAULT_VIEWPORT_DIP,
        fps,
        chromium: pw.chromium,
        executablePath,
      });
      pages = started.pages || {};
      contexts = started.contexts || {};
      captureStartMs = performance.now();

      for (const ctx of Object.values(contexts)) {
        if (ctx?.tracing && typeof ctx.tracing.start === 'function') {
          await ctx.tracing.start({ screenshots: false, snapshots: true }).catch(() => {});
        }
      }

      // Sign in each actor page to its initial route
      for (const [role, actor] of Object.entries(scenario.actors)) {
        const page = pages[role];
        if (!page) continue;
        await signInActorPage({
          page,
          sandbox,
          actor,
          appUrl: effectiveAppUrl,
        });
      }

      // Verify all actor pages remained on the sandbox origin and hydrated DOM text
      // after subsequent actors signed in.
      const targetUiTexts = collectTargetDisplayTexts(scenario, exploitOperation);
      const shouldCollapseSidebar = scenario.stage?.slots?.collapseSidebar !== false;
      for (const [role, actor] of Object.entries(scenario.actors)) {
        const page = pages[role];
        if (!page) continue;
        await ensureActorPageHydrated({
          page,
          uid: actor.uid ?? null,
          idToken: tokenMap.get(role) ?? null,
          appUrl: effectiveAppUrl,
          actor,
          minStabilityMs: 350,
        });
        await prepareActorUiForRecording(page, {
          targetTexts: targetUiTexts,
          collapseSidebar: shouldCollapseSidebar,
        });
      }
      // Capture-relative time when every actor view is signed in and prepared;
      // the attach-demo slide starts after this so startup dialogs never show.
      uiReadyAtMs = Math.round(performance.now() - captureStartMs);

      await sleep(900);
    }

    // 1. Baseline Control Operation (Gate G2)
    const beforeStateRaw = await sandbox
      .readState(exploitOperation.service, exploitOperation.path, victimToken)
      .catch(() => initialSeedValue ?? null);
    const baselineSnapshot = structuredClone(beforeStateRaw ?? initialSeedValue ?? null);

    const controlOffsetMs = isAppView
      ? Math.max(200, Math.round(performance.now() - captureStartMs))
      : 300;
    const beforeRuleRaw =
      scenario.fixRules?.before ||
      (cfgSetup.initialRuleFile && fs.existsSync(cfgSetup.initialRuleFile)
        ? fs.readFileSync(cfgSetup.initialRuleFile, 'utf8')
        : null);
    const beforeRuleSummary =
      extractFocusedRuleSnippet(beforeRuleRaw, exploitOperation) ||
      sandbox.databaseRulesHash ||
      sandbox.rulesHash ||
      'active-rules';
    const beforeRuleFull =
      extractFocusedRuleSnippet(beforeRuleRaw, exploitOperation, { maxLen: 900 }) ||
      beforeRuleSummary;

    const controlDispatchedMs = isAppView
      ? Math.max(200, Math.round(performance.now() - captureStartMs))
      : controlOffsetMs;
    const controlResult = await sandbox.executeOperation({
      operation: controlOperation,
      idToken: victimToken,
    });
    const controlSettledMs = isAppView
      ? Math.max(controlDispatchedMs, Math.round(performance.now() - captureStartMs))
      : controlDispatchedMs + 100;
    recordedEvents.push({
      phase: 'control',
      tMs: controlOffsetMs,
      dispatchedAtMs: controlDispatchedMs,
      executedAtMs: controlSettledMs,
      settledAtMs: controlSettledMs,
      actor: scenario.actors.victim.uid,
      actorLabel: scenario.actors.victim.name,
      service: controlOperation.service,
      method: controlOperation.method,
      path: controlOperation.path,
      decision: controlResult.decision,
      status: controlResult.status,
      error: controlResult.error ?? null,
      sdkCall: controlSnippet,
      matchedRule: beforeRuleSummary,
      ...(uiReadyAtMs != null ? { uiReadyAtMs } : {}),
    });

    const g2 = evaluateGateG2(controlResult);
    if (!g2.pass) {
      const traceRel = await saveFailureTraces(contexts, bundleDir);
      writeFailureBundle({
        outDir: bundleDir,
        finding: scenario.finding,
        failedGate: 'G2',
        reasons: g2.reasons,
        provenanceText: buildLockedProvenanceText({
          decision: controlResult.decision || 'ERROR',
          service: controlOperation.service,
          method: controlOperation.method,
          path: controlOperation.path,
          actorLabel: scenario.actors.victim.uid,
        }),
        tracePath: traceRel,
      });
      throw new EvidenceRecordError('GATE_G2_FAILED', g2.reasons.join('; '), { gate: g2 });
    }

    // Restore exact pre-exploit state if baseline write modified anything
    if (baselineSnapshot !== null && baselineSnapshot !== undefined) {
      await sandbox.executeOperation({
        operation: {
          service: exploitOperation.service,
          method: exploitOperation.service === 'firestore' ? 'setDoc' : 'set',
          path: exploitOperation.path,
          data: structuredClone(baselineSnapshot),
        },
        idToken: victimToken,
      });
    }

    const targetUiTexts = collectTargetDisplayTexts(scenario, exploitOperation);
    const shouldCollapseSidebar = scenario.stage?.slots?.collapseSidebar !== false;
    const uiFocus = {};

    if (isAppView) {
      if (scenario.actors.victim?.expect?.before && pages.victim) {
        await checkVictimDomExpectation(pages.victim, scenario.actors.victim.expect.before, 6000);
      }
      await sleep(1450);
      for (const page of Object.values(pages)) {
        await prepareActorUiForRecording(page, {
          targetTexts: targetUiTexts,
          collapseSidebar: shouldCollapseSidebar,
        });
      }
      const controlFocus = await measureAllActorsFocus(pages, targetUiTexts);
      if (controlFocus) {
        uiFocus.control = controlFocus;
      }
    }

    // 2. Execute Exploit Step(s) (Gate G3)
    const exploitOffsetMs = isAppView
      ? Math.max(1250, Math.round(performance.now() - captureStartMs))
      : 1200;
    if (captureBackend) {
      await captureBackend.mark('exploit');
    }

    const hasCustomSteps = Array.isArray(scenario.steps) && scenario.steps.length > 0;
    let exploitDispatchedMs = exploitOffsetMs;
    if (isAppView) {
      const preFocus = await measureAllActorsFocus(pages, targetUiTexts);
      if (preFocus) {
        uiFocus.exploitPre = preFocus;
      }
      if (!hasCustomSteps) {
        // Armed preview pause so viewer reads pre-exploit app state before state mutates
        await sleep(900);
      }
    }

    let exploitResult = null;
    if (hasCustomSteps) {
      for (const step of scenario.steps) {
        const sKind = String(step.kind || step.type || '').toLowerCase();
        if (sKind === 'reload-rules' || sKind === 'reload_rules') {
          continue; // Handled in verified Gate G5 phase below
        }
        const beforeStepMs = isAppView
          ? Math.max(exploitOffsetMs, Math.round(performance.now() - captureStartMs))
          : exploitOffsetMs;
        if (sKind === 'sdk') {
          exploitDispatchedMs = beforeStepMs;
        }
        const res = await executeStep({
          step,
          actors: scenario.actors,
          actorPages: pages,
          sandbox,
          tokenCache: tokenMap,
          captureBackend,
          t0Ms: captureStartMs,
          onEvent: (ev) => {
            recordedEvents.push({
              ...ev,
              dispatchedAtMs: beforeStepMs,
              tMs: isAppView ? ev.tMs : exploitOffsetMs,
              actorLabel: actorLabel,
            });
          },
        });
        if (
          sKind === 'sdk' &&
          (!step.phase || String(step.phase).toLowerCase() === 'exploit' || String(step.id || '').toLowerCase() === 'exploit')
        ) {
          exploitResult =
            res && !res.decision && res.lastEvent
              ? { ...res.lastEvent, latencyMs: res.lastEvent.latencyMs ?? 0 }
              : res;
        }
      }
    }

    if (!exploitResult) {
      exploitDispatchedMs = isAppView
        ? Math.max(exploitOffsetMs, Math.round(performance.now() - captureStartMs))
        : exploitOffsetMs;
      exploitResult = await sandbox.executeOperation({
        operation: exploitOperation,
        idToken: attackerToken,
      });
      const exploitExecutedMs = isAppView
        ? Math.max(exploitDispatchedMs, Math.round(performance.now() - captureStartMs))
        : exploitOffsetMs;
      recordedEvents.push({
        phase: 'exploit',
        tMs: exploitOffsetMs,
        dispatchedAtMs: exploitDispatchedMs,
        executedAtMs: exploitExecutedMs,
        actor: scenario.actors.attacker?.uid ?? null,
        actorLabel: actorLabel,
        service: exploitOperation.service,
        method: exploitOperation.method,
        path: exploitOperation.path,
        data: exploitOperation.data,
        decision: exploitResult.decision,
        status: exploitResult.status,
        error: exploitResult.error ?? null,
        sdkCall: exploitSnippet,
        matchedRule: beforeRuleSummary,
      });
    } else {
      // Tag primary exploit event so timeline sync locks onto both pre-step window and exact SDK dispatch/completion
      const tagged = recordedEvents.find((e) => e.decision && e.phase !== 'control');
      if (tagged) {
        const actualExecMs = typeof tagged.tMs === 'number' ? tagged.tMs : exploitOffsetMs;
        tagged.phase = 'exploit';
        tagged.dispatchedAtMs = Math.max(
          exploitOffsetMs,
          typeof tagged.dispatchedAtMs === 'number' ? tagged.dispatchedAtMs : exploitDispatchedMs,
        );
        tagged.executedAtMs = Math.max(tagged.dispatchedAtMs, actualExecMs);
        tagged.tMs = exploitOffsetMs;
        tagged.actorLabel = actorLabel;
        tagged.sdkCall = tagged.sdkCall || exploitSnippet;
        tagged.matchedRule = beforeRuleSummary;
      }
    }

    const afterExploitState = await sandbox
      .readState(exploitOperation.service, exploitOperation.path, victimToken)
      .catch(() => exploitResult.data ?? null);
    const stateDiff = computeStateDiff(baselineSnapshot, afterExploitState, exploitOperation.path);
    const enrichedExploitResult = {
      ...exploitResult,
      changedPaths: stateDiff.changedPaths,
      stateDiff,
    };

    const g3 = evaluateGateG3(enrichedExploitResult, [exploitOperation.path]);
    if (!g3.pass) {
      const traceRel = await saveFailureTraces(contexts, bundleDir);
      writeFailureBundle({
        outDir: bundleDir,
        finding: scenario.finding,
        failedGate: 'G3',
        reasons: g3.reasons,
        provenanceText: buildLockedProvenanceText({
          decision: enrichedExploitResult.decision || 'ERROR',
          service: exploitOperation.service,
          method: exploitOperation.method,
          path: exploitOperation.path,
          actorLabel,
        }),
        tracePath: traceRel,
      });
      throw new EvidenceRecordError('GATE_G3_FAILED', g3.reasons.join('; '), { gate: g3 });
    }

    // 3. Verify Visible Effect (Gate G4)
    let expectResult = { pass: true, reason: null };
    if (isAppView) {
      if (scenario.actors.victim?.expect?.after && pages.victim) {
        expectResult = await checkVictimDomExpectation(
          pages.victim,
          scenario.actors.victim.expect.after,
          8000,
        );
      } else {
        await sleep(180);
      }
    }

    const primaryExploitEvt = recordedEvents.find((e) => e.phase === 'exploit');
    if (primaryExploitEvt) {
      primaryExploitEvt.settledAtMs = isAppView
        ? Math.max(primaryExploitEvt.executedAtMs ?? exploitOffsetMs, Math.round(performance.now() - captureStartMs))
        : (primaryExploitEvt.executedAtMs ?? exploitOffsetMs);
    }

    if (isAppView) {
      await sleep(2400);
      const postFocus = await measureAllActorsFocus(pages, targetUiTexts);
      if (postFocus) {
        uiFocus.exploitPost = postFocus;
      }
    }

    const g4 = evaluateGateG4({
      mode: isAppView ? 'app-view' : 'data-plane',
      expectResult,
      stateDiff,
    });
    if (!g4.pass) {
      const traceRel = await saveFailureTraces(contexts, bundleDir);
      writeFailureBundle({
        outDir: bundleDir,
        finding: scenario.finding,
        failedGate: 'G4',
        reasons: g4.reasons,
        provenanceText: buildLockedProvenanceText({
          decision: enrichedExploitResult.decision,
          service: exploitOperation.service,
          method: exploitOperation.method,
          path: exploitOperation.path,
          actorLabel,
        }),
        tracePath: traceRel,
      });
      throw new EvidenceRecordError('GATE_G4_FAILED', g4.reasons.join('; '), { gate: g4 });
    }

    // 4. Optional Fix Verification (Gate G5)
    let fixControlResult = null;
    let fixExploitResult = null;
    let fixStateDiff = null;
    const afterRuleSummary = hasFix
      ? extractFocusedRuleSnippet(scenario.fixRules?.after || fixRulesSpec.rawSnippet, exploitOperation) ||
        'candidate-fix-rules'
      : null;

    if (hasFix) {
      // Restore clean pre-exploit baseline BEFORE activating restrictive candidate rules
      if (baselineSnapshot !== null && baselineSnapshot !== undefined) {
        await sandbox.executeOperation({
          operation: {
            service: exploitOperation.service,
            method: exploitOperation.service === 'firestore' ? 'setDoc' : 'set',
            path: exploitOperation.path,
            data: structuredClone(baselineSnapshot),
          },
          idToken: victimToken,
        });
      }

      await sandbox.updateRules({
        rtdbRules: fixRulesSpec.rtdbRules,
        firestoreRules: fixRulesSpec.firestoreRules,
        storageRules: fixRulesSpec.storageRules,
      });

      fixControlResult = await sandbox.executeOperation({
        operation: controlOperation,
        idToken: victimToken,
      });

      // Re-seed clean state in case control write modified anything
      const controlMethodLower = String(controlOperation.method || '').toLowerCase();
      if (
        baselineSnapshot !== null &&
        baselineSnapshot !== undefined &&
        controlMethodLower !== 'get' &&
        controlMethodLower !== 'getdoc'
      ) {
        await sandbox.executeOperation({
          operation: {
            service: exploitOperation.service,
            method: exploitOperation.service === 'firestore' ? 'setDoc' : 'set',
            path: exploitOperation.path,
            data: structuredClone(baselineSnapshot),
          },
          idToken: victimToken,
        });
      }

      if (isAppView) {
        let listenerUpdated = false;
        if (scenario.actors.victim?.expect?.before && pages.victim) {
          const check = await checkVictimDomExpectation(pages.victim, scenario.actors.victim.expect.before, 1500);
          listenerUpdated = Boolean(check?.pass);
        } else {
          await sleep(450);
          listenerUpdated = true;
        }

        if (!listenerUpdated) {
          await captureBackend.pause?.().catch(() => {});
          try {
            for (const page of Object.values(pages)) {
              if (page && typeof page.reload === 'function') {
                await withOffOriginNavigationGuard(page, effectiveAppUrl, async () => {
                  await page.reload({ waitUntil: 'load' }).catch(() => {});
                });
              }
            }
            if (scenario.actors.victim?.expect?.before && pages.victim) {
              await checkVictimDomExpectation(pages.victim, scenario.actors.victim.expect.before, 6000);
            } else {
              await sleep(450);
            }
            for (const page of Object.values(pages)) {
              await prepareActorUiForRecording(page, {
                targetTexts: targetUiTexts,
                collapseSidebar: shouldCollapseSidebar,
              });
            }
          } finally {
            await captureBackend.resume?.().catch(() => {});
          }
        }

        for (const [role, actor] of Object.entries(scenario.actors)) {
          const page = pages[role];
          if (!page) continue;
          await ensureActorPageHydrated({
            page,
            uid: actor.uid ?? null,
            idToken: tokenMap.get(role) ?? null,
            appUrl: effectiveAppUrl,
            actor,
            minStabilityMs: 250,
          });
          await prepareActorUiForRecording(page, {
            targetTexts: targetUiTexts,
            collapseSidebar: shouldCollapseSidebar,
          });
        }
      }

      const fixOffsetMs = isAppView
        ? Math.max(exploitOffsetMs + 700, Math.round(performance.now() - captureStartMs))
        : 3100;
      if (captureBackend) {
        await captureBackend.mark('fix');
      }

      if (isAppView) {
        // Brief armed pause in fix beat before re-running the identical exploit SDK call
        await sleep(950);
      }

      const fixDispatchedMs = isAppView
        ? Math.max(fixOffsetMs, Math.round(performance.now() - captureStartMs))
        : fixOffsetMs + 250;
      fixExploitResult = await sandbox.executeOperation({
        operation: exploitOperation,
        idToken: attackerToken,
      });
      const fixExecutedMs = isAppView
        ? Math.max(fixDispatchedMs, Math.round(performance.now() - captureStartMs))
        : fixDispatchedMs + 50;

      const postFixState = await sandbox
        .readState(exploitOperation.service, exploitOperation.path, victimToken)
        .catch(() => baselineSnapshot);
      fixStateDiff = computeStateDiff(baselineSnapshot, postFixState, exploitOperation.path);

      recordedEvents.push({
        phase: 'fix',
        tMs: fixOffsetMs,
        dispatchedAtMs: fixDispatchedMs,
        executedAtMs: fixExecutedMs,
        settledAtMs: fixExecutedMs,
        actor: scenario.actors.attacker?.uid ?? null,
        actorLabel,
        service: exploitOperation.service,
        method: exploitOperation.method,
        path: exploitOperation.path,
        data: exploitOperation.data,
        decision: fixExploitResult.decision,
        status: fixExploitResult.status,
        error: fixExploitResult.error ?? 'permission-denied',
        sdkCall: exploitSnippet,
        matchedRule: afterRuleSummary,
      });

      if (isAppView) {
        await sleep(1250);
        const fixFocus = await measureAllActorsFocus(pages, targetUiTexts);
        if (fixFocus) {
          uiFocus.fixPost = fixFocus;
        }
      }

      const g5 = evaluateGateG5({
        enabled: true,
        fixControlResult,
        fixExploitResult,
        fixStateDiff,
      });
      if (!g5.pass) {
        const traceRel = await saveFailureTraces(contexts, bundleDir);
        writeFailureBundle({
          outDir: bundleDir,
          finding: scenario.finding,
          failedGate: 'G5',
          reasons: g5.reasons,
          provenanceText: buildLockedProvenanceText({
            decision: enrichedExploitResult.decision,
            fixedDecision: fixExploitResult?.decision || 'ERROR',
            service: exploitOperation.service,
            method: exploitOperation.method,
            path: exploitOperation.path,
            actorLabel,
          }),
          tracePath: traceRel,
        });
        throw new EvidenceRecordError('GATE_G5_FAILED', g5.reasons.join('; '), { gate: g5 });
      }
    }

    // All recording gates passed — stop tracing & finalize CaptureBackend if active
    await stopTracingQuietly(contexts);
    if (captureBackend) {
      captureArtifact = await captureBackend.stop();
    }

    const denials = await sandbox.getDenials().catch(() => []);
    const finalProvenanceText = buildLockedProvenanceText({
      decision: enrichedExploitResult.decision,
      fixedDecision: hasFix ? fixExploitResult.decision : undefined,
      service: exploitOperation.service,
      method: exploitOperation.method,
      path: exploitOperation.path,
      actorLabel,
    });

    const scenarioOutPath = path.join(bundleDir, 'scenario.json');
    fs.writeFileSync(scenarioOutPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');

    const eventsOutPath = path.join(bundleDir, 'events.json');
    fs.writeFileSync(eventsOutPath, `${JSON.stringify(recordedEvents, null, 2)}\n`, 'utf8');

    const evidencePayload = {
      service: exploitOperation.service,
      method: exploitOperation.method,
      path: exploitOperation.path,
      decision: enrichedExploitResult.decision,
      ...(hasFix ? { fixedDecision: fixExploitResult.decision } : {}),
      before: stateDiff.before,
      after: stateDiff.after,
      changedPaths: stateDiff.changedPaths,
      matchedRule: beforeRuleSummary,
      ...(hasFix
        ? {
            fixRules: {
              before: beforeRuleSummary,
              after: afterRuleSummary,
              beforeFull: beforeRuleFull,
              afterFull:
                extractFocusedRuleSnippet(
                  scenario.fixRules?.after || fixRulesSpec.rawSnippet,
                  exploitOperation,
                  { maxLen: 900 },
                ) || afterRuleSummary,
            },
          }
        : {}),
      denials,
      events: recordedEvents,
      ...(Object.keys(uiFocus).length > 0 ? { uiFocus } : {}),
    };
    fs.writeFileSync(
      path.join(bundleDir, 'evidence.json'),
      `${JSON.stringify(evidencePayload, null, 2)}\n`,
      'utf8',
    );

    const verifiedManifest = {
      schema: BUNDLE_SCHEMA,
      status: 'reproduced',
      finding: scenario.finding,
      backend: captureArtifact ? captureArtifact.backend : 'data-plane',
      platform: process.platform,
      provenanceText: finalProvenanceText,
      gates: {
        g1: true,
        g2: true,
        g3: true,
        g4: true,
        g5: hasFix ? true : 'skipped',
        g6: false, // Updated to true once render.mjs completes
      },
      artifacts: {
        poster: 'pending-render.png',
        scenario: 'scenario.json',
        events: 'events.json',
        evidence: 'evidence.json',
        ...(captureArtifact ? { rawCapture: 'raw/capture.json' } : {}),
      },
      recordedAt: new Date().toISOString(),
    };
    validateBundleManifest(verifiedManifest);
    fs.writeFileSync(
      path.join(bundleDir, 'manifest.json'),
      `${JSON.stringify(verifiedManifest, null, 2)}\n`,
      'utf8',
    );

    // Tear down live sandbox & capture before invoking render.mjs
    await captureBackend?.dispose().catch(() => {});
    captureBackend = null;
    await sandbox.dispose().catch(() => {});
    sandbox = null;

    if (render) {
      const renderMod = await import('./render.mjs');
      const rendered = await renderMod.renderEvidenceBundle({
        evidenceDir: bundleDir,
        stagePath,
        sizeStr,
        formats,
        fps,
        outPath: outVideoPath,
        log,
      });
      return {
        ok: true,
        status: 'reproduced',
        bundleDir,
        provenanceText: finalProvenanceText,
        gates: { g1: true, g2: true, g3: true, g4: true, g5: hasFix ? true : 'skipped', g6: true },
        rendered,
      };
    }

    return {
      ok: true,
      status: 'reproduced',
      bundleDir,
      provenanceText: finalProvenanceText,
      backend: captureArtifact ? captureArtifact.backend : 'data-plane',
      gates: { g1: true, g2: true, g3: true, g4: true, g5: hasFix ? true : 'skipped', g6: false },
    };
  } catch (err) {
    // If an unexpected runtime error occurred before a gate handler wrote a failure bundle,
    // make sure no stale video exists and record a failure manifest if none was written yet.
    const manifestPath = path.join(bundleDir, 'manifest.json');
    if (!(err instanceof EvidenceRecordError && err.code?.startsWith('GATE_'))) {
      const traceRel = await saveFailureTraces(contexts, bundleDir).catch(() => undefined);
      if (!fs.existsSync(manifestPath)) {
        writeFailureBundle({
          outDir: bundleDir,
          finding: scenario.finding,
          failedGate: 'G4',
          reasons: [err?.message || String(err)],
          provenanceText: partialProvenance,
          tracePath: traceRel,
        });
      }
    }
    throw err;
  } finally {
    if (typeof signalCleanup === 'function') {
      signalCleanup();
    }
    if (captureBackend) {
      await captureBackend.dispose().catch(() => {});
    }
    if (sandbox) {
      await sandbox.dispose().catch(() => {});
    }
    if (cfgSetup.scratchCfgDir && fs.existsSync(cfgSetup.scratchCfgDir)) {
      fs.rmSync(cfgSetup.scratchCfgDir, { recursive: true, force: true });
    }
  }
}

/**
 * Returns true when the scenario file describes a build-variant finding
 * (same rules, two app builds) via a `behavior` block.
 */
export function isBehaviorScenarioFile(scenarioPath) {
  if (!scenarioPath) return false;
  const raw = readJsonFile(scenarioPath, 'scenario.json');
  return isPlainObject(raw) && isPlainObject(raw.behavior);
}

/**
 * Single entry point for both recording variants.
 *
 * - Build variant (`scenario.behavior` present): delegates to
 *   `recordBehaviorEvidence()` from record-behavior.mjs.
 * - Rules variant (everything else): runs `recordEvidence()` unchanged.
 *
 * Dependencies are injectable so the dispatch can be tested without a browser.
 */
export async function dispatchRecord(cli, {
  log = () => {},
  recordRules = recordEvidence,
  loadBehaviorRecorder = async () => (await import('./record-behavior.mjs')).recordBehaviorEvidence,
} = {}) {
  if (cli.scenarioPath && isBehaviorScenarioFile(cli.scenarioPath)) {
    const rulesOnly = [
      ['--campaign', cli.campaignPath],
      ['--fix-rules', cli.fixRulesPath],
      ['--rtdb-rules', cli.rtdbRulesPath],
      ['--firestore-rules', cli.firestoreRulesPath],
      ['--storage-rules', cli.storageRulesPath],
    ].filter(([, value]) => value);
    if (rulesOnly.length > 0) {
      throw new EvidenceRecordError(
        'INVALID_CLI_ARGS',
        `${rulesOnly.map(([flag]) => flag).join(', ')} only apply to rules scenarios; ` +
          'a behavior scenario compares two app builds (behavior.fixApp.dist)',
      );
    }
    const recordBehavior = await loadBehaviorRecorder();
    const result = await recordBehavior({
      scenarioPath: cli.scenarioPath,
      seedPath: cli.seedDir || undefined,
      outDir: cli.outDir,
      render: cli.render,
      formats: cli.formats,
      fps: cli.fps,
      log,
    });
    const manifestPath = result?.bundleDir ? path.join(result.bundleDir, 'manifest.json') : null;
    const gates = manifestPath && fs.existsSync(manifestPath)
      ? readJsonFile(manifestPath, 'manifest.json').gates
      : undefined;
    return { variant: 'build', ...result, ...(gates ? { gates } : {}) };
  }
  return recordRules({ ...cli, log });
}

async function main() {
  let cli = { json: false };
  try {
    cli = parseRecordCliArgs(process.argv.slice(2));
    if (cli.help) {
      process.stdout.write(
        [
          'Usage: node record.mjs [options]',
          '  A --scenario with a `behavior` block records the build variant',
          '  (before/after app builds); anything else records the rules variant.',
          '  --campaign <export.json>     Pyric CampaignExport JSON',
          '  --probe <probeId>            Probe ID inside campaign export',
          '  --scenario <scenario.json>   Scenario JSON (standalone or override)',
          '  --seed <seed.json>           Sandbox seed (defaults to scenario.seedFile)',
          '  --fix-rules <path>           Candidate fixed rules file for Gate G5 proof',
          '  --rtdb-rules <path>          Candidate fixed RTDB rules JSON',
          '  --firestore-rules <path>     Candidate fixed Firestore rules',
          '  --storage-rules <path>       Candidate fixed Storage rules',
          '  --backend <auto|x11|avfoundation|cdp>',
          '  --out <evidenceDir>          Output evidence bundle directory (required)',
          '  --render                     Immediately render video bundle after recording',
          '  --stage <custom.html>        Custom stage template (when --render is set)',
          '  --size <WxH>                 Output dimensions (when --render is set)',
          '  --formats <mp4,gif>          Output formats (when --render is set)',
          '  --fps <n>                    Output frame rate (when --render is set)',
          '  --json                       Emit structured JSON output',
        ].join('\n') + '\n',
      );
      return;
    }

    const result = await dispatchRecord(cli, {
      log: (msg) => {
        if (!cli.json) {
          process.stderr.write(`${msg}\n`);
        }
      },
    });

    if (cli.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Recorded verified evidence bundle in ${result.bundleDir}\n`);
    }
  } catch (err) {
    const code = err?.code || 'RECORD_ERROR';
    const message = err?.message || String(err);
    if (cli.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code, message, details: err?.details || null } }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`[${code}] ${message}\n`);
    }
    process.exitCode = 1;
  }
}

const isDirectEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectEntry) {
  // Not awaited: record-behavior.mjs imports this module, so a top-level await
  // here would deadlock the build-variant dispatch. main() handles its errors.
  main();
}
