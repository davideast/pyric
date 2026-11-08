#!/usr/bin/env node
/**
 * Offline HTML Stage Renderer CLI & module for Pyric security-audit evidence bundles.
 * Usage:
 *   node render.mjs <evidenceDir> [--stage <customStage.html>] [--size <WxH>] [--formats mp4,gif] [--fps 30] [--out <videoPath>] [--json]
 * Zero external npm dependencies.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BUNDLE_SCHEMA,
  parseSizeString,
  validateScenario,
  validateRawCapture,
  buildLockedProvenanceText,
  buildStagePayload,
  isReadOperationMethod,
  validateBundleManifest,
} from './lib/contracts.mjs';
import {
  findProjectPlaywright,
  loadPlaywright,
  resolveChromiumExecutable,
  probeSystemTools,
  RuntimeMissingError,
} from './lib/runtime.mjs';
import {
  computeStageTimeline,
  buildResampledPassFrames,
} from './lib/render-timeline.mjs';
import {
  extractActorFramesFromVideo,
  createH264PipeEncoder,
  transcodePreviewGif,
  probeMedia,
} from './lib/ffmpeg.mjs';
import { evaluateGateG6, writeFailureBundle } from './lib/gates.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(SCRIPT_DIR, '../assets');
const STAGES_DIR = path.join(ASSETS_DIR, 'stages');

const BUILTIN_STAGES = Object.freeze({
  'split-actors': path.join(STAGES_DIR, 'split-actors.html'),
  'single-hero': path.join(STAGES_DIR, 'single-hero.html'),
  'data-plane': path.join(STAGES_DIR, 'data-plane.html'),
});

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
});

export class EvidenceRenderError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EvidenceRenderError';
    this.code = code;
    this.details = details;
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pickFirstDefined(...candidates) {
  for (const val of candidates) {
    if (val !== undefined && val !== null) {
      return val;
    }
  }
  return undefined;
}

function pickFirstPresent(...candidates) {
  for (const val of candidates) {
    if (val !== undefined) {
      return val;
    }
  }
  return undefined;
}

function parseFormats(formatsStr) {
  const items = String(formatsStr)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (items.length === 0) {
    throw new EvidenceRenderError('INVALID_CLI_ARGS', '--formats must include at least one of: mp4, gif');
  }
  const unique = [];
  for (const item of items) {
    if (item !== 'mp4' && item !== 'gif') {
      throw new EvidenceRenderError('INVALID_CLI_ARGS', `Unsupported format "${item}": expected mp4 or gif`);
    }
    if (!unique.includes(item)) {
      unique.push(item);
    }
  }
  return unique;
}

function readFlagValue(argv, index, flagName) {
  const arg = argv[index];
  const prefix = `${flagName}=`;
  if (arg.startsWith(prefix)) {
    const val = arg.slice(prefix.length);
    if (!val) {
      throw new EvidenceRenderError('INVALID_CLI_ARGS', `${flagName} requires a value`);
    }
    return { value: val, nextIndex: index };
  }
  const nextVal = argv[index + 1];
  if (!nextVal) {
    throw new EvidenceRenderError('INVALID_CLI_ARGS', `${flagName} requires a value`);
  }
  return { value: nextVal, nextIndex: index + 1 };
}

function parseCliArgs(argv) {
  let evidenceDir = null;
  let stagePath = null;
  let sizeStr = null;
  let formats = ['mp4'];
  let fps = 30;
  let outPath = null;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--stage' || arg.startsWith('--stage=')) {
      const parsed = readFlagValue(argv, i, '--stage');
      stagePath = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--size' || arg.startsWith('--size=')) {
      const parsed = readFlagValue(argv, i, '--size');
      sizeStr = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--formats' || arg.startsWith('--formats=')) {
      const parsed = readFlagValue(argv, i, '--formats');
      formats = parseFormats(parsed.value);
      i = parsed.nextIndex;
    } else if (arg === '--fps' || arg.startsWith('--fps=')) {
      const parsed = readFlagValue(argv, i, '--fps');
      const parsedFps = Number(parsed.value);
      if (!Number.isInteger(parsedFps) || parsedFps < 1 || parsedFps > 120) {
        throw new EvidenceRenderError('INVALID_CLI_ARGS', `--fps must be an integer between 1 and 120 (got "${parsed.value}")`);
      }
      fps = parsedFps;
      i = parsed.nextIndex;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const parsed = readFlagValue(argv, i, '--out');
      outPath = parsed.value;
      i = parsed.nextIndex;
    } else if (arg.startsWith('--')) {
      throw new EvidenceRenderError('INVALID_CLI_ARGS', `Unknown option "${arg}"`);
    } else if (evidenceDir !== null) {
      throw new EvidenceRenderError('INVALID_CLI_ARGS', `Unexpected extra positional argument "${arg}"`);
    } else {
      evidenceDir = arg;
    }
  }

  if (!help && !evidenceDir) {
    throw new EvidenceRenderError(
      'INVALID_CLI_ARGS',
      'Usage: node render.mjs <evidenceDir> [--stage <customStage.html>] [--size <WxH>] [--formats mp4,gif] [--fps 30] [--out <videoPath>] [--json]',
    );
  }

  return {
    evidenceDir: evidenceDir ? path.resolve(evidenceDir) : null,
    stagePath: stagePath ? path.resolve(stagePath) : null,
    sizeStr,
    formats,
    fps,
    outPath: outPath ? path.resolve(outPath) : null,
    json,
    help,
  };
}

function resolveCaptureMediaPath(evidenceDir, rawPath) {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  const direct = path.resolve(evidenceDir, rawPath);
  if (fs.existsSync(direct)) {
    return direct;
  }
  const underRaw = path.resolve(evidenceDir, 'raw', rawPath);
  if (fs.existsSync(underRaw)) {
    return underRaw;
  }
  return direct;
}

function resolveStageHtmlPath(layout, customStagePath) {
  if (customStagePath) {
    if (!fs.existsSync(customStagePath)) {
      throw new EvidenceRenderError('MISSING_STAGE_TEMPLATE', `Custom stage template not found: ${customStagePath}`);
    }
    return customStagePath;
  }
  const builtIn = BUILTIN_STAGES[layout] || BUILTIN_STAGES['split-actors'];
  if (!fs.existsSync(builtIn)) {
    throw new EvidenceRenderError('MISSING_STAGE_TEMPLATE', `Built-in stage template not found: ${builtIn}`);
  }
  return builtIn;
}

function extractStageEvidence({ scenario, eventsData, extraEvidence, existingManifest }) {
  const eventsObj = eventsData && !Array.isArray(eventsData) && typeof eventsData === 'object' ? eventsData : {};
  const eventList = Array.isArray(eventsData) ? eventsData : (Array.isArray(eventsObj.events) ? eventsObj.events : []);

  let reproEvent = null;
  let fixEvent = null;
  for (const ev of eventList) {
    if (!ev || typeof ev !== 'object') continue;
    const phase = String(ev.phase ?? ev.type ?? ev.kind ?? '').toLowerCase();
    const decision = String(ev.decision ?? '').toUpperCase();
    if (!reproEvent && (phase === 'repro' || phase === 'mutation' || phase === 'attack')) {
      reproEvent = ev;
    }
    if (!fixEvent && (phase === 'fix' || phase === 'verify' || phase === 'patched' || decision === 'DENY')) {
      fixEvent = ev;
    }
  }
  if (!reproEvent && eventList.length > 0) {
    reproEvent = eventList.find((ev) => ev.path || ev.method || ev.data) || eventList[0];
  }

  const ownerUid = scenario.actors?.owner?.uid || 'alice';
  const peerUid = scenario.actors?.peer?.uid || 'mallory';

  const service = pickFirstDefined(extraEvidence?.service, eventsObj.service, reproEvent?.service, 'database');
  const method = pickFirstDefined(extraEvidence?.method, eventsObj.method, reproEvent?.method, reproEvent?.op, 'set');
  const isRead = isReadOperationMethod(method);
  const targetPath = pickFirstDefined(extraEvidence?.path, eventsObj.path, reproEvent?.path, '/channels/general/messages/msg_alice_1');
  const before = pickFirstPresent(
    extraEvidence?.before,
    eventsObj.before,
    reproEvent?.stateBefore,
    reproEvent?.stateDiff?.before,
    reproEvent?.before,
    fixEvent?.before,
    { authorUid: ownerUid, text: 'Verified baseline state' },
  );
  const after = pickFirstPresent(
    extraEvidence?.after,
    eventsObj.after,
    reproEvent?.stateAfter,
    reproEvent?.stateDiff?.after,
    reproEvent?.after,
    reproEvent?.data,
    isRead ? before : { authorUid: ownerUid, text: `Mutated by ${peerUid}` },
  );
  const changedPaths = pickFirstDefined(
    extraEvidence?.changedPaths,
    eventsObj.changedPaths,
    reproEvent?.stateDiff?.changedPaths,
    isRead ? [] : [targetPath],
  );
  const matchedRule = pickFirstDefined(
    extraEvidence?.matchedRule,
    eventsObj.matchedRule,
    reproEvent?.matchedRule,
    scenario.fixRules?.before,
    isRead ? '".read": "auth != null"' : '".write": "auth != null"',
  );
  const rawFixRules = pickFirstDefined(scenario.fixRules, extraEvidence?.fixRules, eventsObj.fixRules, null);
  const fixRules =
    rawFixRules && typeof rawFixRules === 'object'
      ? {
          ...(scenario.fixRules && typeof scenario.fixRules === 'object' ? scenario.fixRules : {}),
          ...(extraEvidence?.fixRules && typeof extraEvidence.fixRules === 'object' ? extraEvidence.fixRules : {}),
        }
      : null;
  const hasFix = Boolean(fixRules || scenario.copy?.fixed || fixEvent);
  const decision = pickFirstDefined(extraEvidence?.decision, eventsObj.decision, reproEvent?.decision, 'ALLOW');
  const fixedDecision = pickFirstDefined(extraEvidence?.fixedDecision, eventsObj.fixedDecision, fixEvent?.decision, hasFix ? 'DENY' : undefined);

  const actorLabel = pickFirstDefined(
    reproEvent?.actorLabel,
    scenario.actors?.peer?.uid,
    scenario.actors?.peer?.name,
    scenario.actors?.owner?.uid,
    scenario.actors?.owner?.name,
  );
  let provenanceText = '';
  if (typeof existingManifest?.provenanceText === 'string' && existingManifest.provenanceText.trim().length > 0) {
    provenanceText = existingManifest.provenanceText.trim();
  } else if (typeof eventsObj.provenanceText === 'string' && eventsObj.provenanceText.trim().length > 0) {
    provenanceText = eventsObj.provenanceText.trim();
  } else {
    provenanceText = buildLockedProvenanceText({ decision, fixedDecision, service, method, path: targetPath, actorLabel });
  }

  const gateEvents = eventList.map((ev) => {
    if (ev === reproEvent && ev && typeof ev === 'object' && ev.actorLabel === undefined && actorLabel) {
      return Object.assign({}, ev, { actorLabel });
    }
    return ev;
  });

  const evidence = {
    service,
    method,
    path: targetPath,
    decision,
    before,
    after,
    changedPaths,
    matchedRule,
    events: gateEvents,
  };
  if (fixedDecision) {
    evidence.fixedDecision = fixedDecision;
  }
  if (fixRules) {
    evidence.fixRules = fixRules;
  }
  const uiFocus = pickFirstDefined(extraEvidence?.uiFocus, eventsObj.uiFocus, null);
  if (uiFocus && typeof uiFocus === 'object') {
    evidence.uiFocus = uiFocus;
  }
  const fixAssurance = pickFirstDefined(extraEvidence?.fixAssurance, existingManifest?.fixAssurance, null);
  if (fixAssurance && typeof fixAssurance === 'object') {
    evidence.fixAssurance = fixAssurance;
  }

  return { evidence, provenanceText };
}

function startStageHttpServer({ evidenceDir, stageHtmlPath, externalFilesMap }) {
  const stageHtml = fs.readFileSync(stageHtmlPath, 'utf8');
  const resolvedEvidenceDir = path.resolve(evidenceDir);

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pathname === '/' || pathname === '/__pyric_stage.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(stageHtml);
      return;
    }

    let fileToServe = null;
    if (pathname.startsWith('/__pyric_external/')) {
      const token = pathname.slice('/__pyric_external/'.length).split('/')[0];
      fileToServe = externalFilesMap.get(token) || null;
    } else if (pathname.startsWith('/__pyric_stage_assets/')) {
      const relAsset = pathname.slice('/__pyric_stage_assets/'.length).replace(/^\/+/, '');
      const candidate = path.resolve(ASSETS_DIR, relAsset);
      if (candidate !== ASSETS_DIR && !candidate.startsWith(ASSETS_DIR + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fileToServe = candidate;
    } else {
      const candidate = path.resolve(resolvedEvidenceDir, pathname.replace(/^\/+/, ''));
      if (candidate !== resolvedEvidenceDir && !candidate.startsWith(resolvedEvidenceDir + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fileToServe = candidate;
    }

    if (!fileToServe || !fs.existsSync(fileToServe) || !fs.statSync(fileToServe).isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(fileToServe).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(fileToServe).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function resolvePlaywrightProjectDir(evidenceDir) {
  if (findProjectPlaywright(process.cwd())) return process.cwd();
  if (findProjectPlaywright(SCRIPT_DIR)) return SCRIPT_DIR;
  return evidenceDir;
}

function buildShareMarkdown({ scenario, provenanceText, evidenceDir }) {
  const severity = scenario.copy?.severity || 'HIGH';
  const title = scenario.copy?.title || 'Security Audit Finding';
  const reproSummary = scenario.copy?.repro || scenario.copy?.summary || '';
  const relDir = path.basename(evidenceDir);
  return [
    `### [${severity}] ${title}`,
    `**Verdict:** \`${provenanceText}\` - ${reproSummary}`,
    `**Reproduce:** \`npx pyric verify --campaign ${scenario.finding.campaign} --probe ${scenario.finding.probe}\` | \`node render.mjs ${relDir}\``,
    '',
  ].join('\n');
}

function toBundleArtifactPath(evidenceDir, filePath) {
  const rel = path.relative(path.resolve(evidenceDir), path.resolve(filePath));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return path.resolve(filePath);
}

async function runGateG6(gateContext) {
  const result = evaluateGateG6(gateContext);
  if (result.pass === false) {
    throw new EvidenceRenderError(
      result.code || 'GATE_G6_FAILED',
      result.message || `Gate G6 verification failed: ${result.reasons.join('; ')}`,
      result,
    );
  }
  return true;
}

async function verifyRenderedProvenance(page) {
  const check = await page.evaluate(() => {
    const el = document.querySelector('[data-pyric-provenance]');
    if (!el) return { ok: false, reason: 'Missing [data-pyric-provenance] element in stage DOM' };
    const text = (el.textContent || '').trim();
    if (text.length === 0) return { ok: false, reason: '[data-pyric-provenance] textContent is empty' };
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return { ok: false, reason: '[data-pyric-provenance] is hidden via CSS' };
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { ok: false, reason: '[data-pyric-provenance] has zero bounding box' };
    }
    if (rect.bottom > window.innerHeight + 2 || rect.right > window.innerWidth + 2 || rect.top < -2 || rect.left < -2) {
      return { ok: false, reason: `[data-pyric-provenance] is clipped outside viewport (${JSON.stringify(rect)})` };
    }
    return { ok: true, text };
  });
  if (!check.ok) {
    throw new EvidenceRenderError('PROVENANCE_MISSING_OR_HIDDEN', check.reason);
  }
  return check.text;
}

async function buildReproducePass({
  captureArtifact,
  evidenceDir,
  timeline,
  presentation = null,
  fps,
  ffmpegPath,
  log,
}) {
  const effectiveDurationMs = presentation ? presentation.totalMs : timeline.totalMs;
  const totalFrames = Math.max(1, Math.round((effectiveDurationMs / 1000) * fps));
  const externalFilesMap = new Map();
  let externalSeq = 0;

  if (!captureArtifact) {
    return {
      reproPass: { fps, totalFrames, startMs: 0, durationMs: effectiveDurationMs, frames: [] },
      externalFilesMap,
    };
  }

  let extractedMap = null;
  if (captureArtifact.mode === 'video') {
    const videoFile = resolveCaptureMediaPath(evidenceDir, captureArtifact.videoPath);
    log(`Extracting actor crops from ${videoFile}...`);
    extractedMap = await extractActorFramesFromVideo({
      ffmpegPath,
      videoPath: videoFile,
      cropRects: captureArtifact.cropRects,
      outputDir: path.join(evidenceDir, 'raw', 'extracted'),
      fps,
      packetTimestampsMs: captureArtifact.packetTimestampsMs,
    });
  } else if (captureArtifact.mode === 'frames') {
    const mappedFrames = captureArtifact.frames.map((entry) => {
      const files = {};
      for (const [role, rawFile] of Object.entries(entry.files || {})) {
        const absFile = resolveCaptureMediaPath(evidenceDir, rawFile);
        const rel = path.relative(path.resolve(evidenceDir), absFile);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          files[role] = absFile;
        } else {
          const token = String(externalSeq++);
          externalFilesMap.set(token, absFile);
          files[role] = `/__pyric_external/${token}/${path.basename(absFile)}`;
        }
      }
      return { tMs: entry.tMs, files };
    });
    extractedMap = { frames: mappedFrames };
  }

  const reproPass = buildResampledPassFrames({
    captureArtifact,
    extractedFrameMap: extractedMap,
    startMs: 0,
    durationMs: effectiveDurationMs,
    fps,
    baseDir: evidenceDir,
    presentation,
  });

  return { reproPass, externalFilesMap };
}

/**
 * Render an evidence directory into MP4 video, preview GIF, storyboard keyframes,
 * poster PNG, share.md, and validated manifest.json.
 */
export async function renderEvidenceBundle({
  evidenceDir,
  stagePath = null,
  sizeStr = null,
  formats = ['mp4'],
  fps = 30,
  outPath = null,
  log = () => {},
}) {
  if (!evidenceDir || !fs.existsSync(evidenceDir)) {
    throw new EvidenceRenderError('MISSING_EVIDENCE_DIR', `Evidence directory does not exist: ${evidenceDir}`);
  }

  const manifestPath = path.join(evidenceDir, 'manifest.json');
  const existingManifest = fs.existsSync(manifestPath)
    ? validateBundleManifest(readJsonFile(manifestPath))
    : null;

  if (existingManifest && existingManifest.status === 'not-reproduced') {
    throw new EvidenceRenderError(
      'UNVERIFIED_FINDING',
      'Refusing to render video: manifest.json status is "not-reproduced".',
      { finding: existingManifest.finding },
    );
  }

  const scenarioPath = path.join(evidenceDir, 'scenario.json');
  if (!fs.existsSync(scenarioPath)) {
    throw new EvidenceRenderError('MISSING_SCENARIO', `Missing scenario.json in ${evidenceDir}`);
  }

  const baseScenario = validateScenario(readJsonFile(scenarioPath));
  const dimensions = sizeStr ? parseSizeString(sizeStr) : baseScenario.stage.dimensions;
  const scenario = Object.assign({}, baseScenario, {
    stage: Object.assign({}, baseScenario.stage, { dimensions }),
  });

  const eventsPath = path.join(evidenceDir, 'events.json');
  const eventsData = fs.existsSync(eventsPath) ? readJsonFile(eventsPath) : [];
  const extraEvidencePath = path.join(evidenceDir, 'evidence.json');
  const extraEvidence = fs.existsSync(extraEvidencePath) ? readJsonFile(extraEvidencePath) : null;
  const capturePath = path.join(evidenceDir, 'raw', 'capture.json');
  const captureArtifact = fs.existsSync(capturePath) ? validateRawCapture(readJsonFile(capturePath)) : null;

  const tools = probeSystemTools();
  if (!tools.ffmpegPath) {
    throw new RuntimeMissingError('VIDEO_FFMPEG_MISSING', 'ffmpeg binary not found on PATH.', 'Install ffmpeg.');
  }

  const { chromium } = await loadPlaywright({ projectDir: resolvePlaywrightProjectDir(evidenceDir), log });
  const executablePath = resolveChromiumExecutable(chromium);
  if (!executablePath) {
    throw new RuntimeMissingError('VIDEO_CHROMIUM_MISSING', 'Chromium executable not found.', 'Run `npx playwright install chromium`.');
  }

  const { evidence, provenanceText } = extractStageEvidence({ scenario, eventsData, extraEvidence, existingManifest });
  const timeline = computeStageTimeline({
    scenario,
    events: eventsData,
    durationMs: captureArtifact?.durationMs,
    evidence,
  });
  const activePresentation = (scenario.stage.layout === 'split-actors' || !scenario.app) && timeline.presentation ? timeline.presentation : null;
  const renderTotalSec = activePresentation ? activePresentation.totalSec : timeline.totalSec;
  const totalFrames = Math.max(1, Math.round(renderTotalSec * fps));
  const { reproPass, externalFilesMap } = await buildReproducePass({
    captureArtifact,
    evidenceDir,
    timeline,
    presentation: activePresentation,
    fps,
    ffmpegPath: tools.ffmpegPath,
    log,
  });

  const payload = buildStagePayload({
    scenario,
    fps,
    beats: timeline.beats,
    slides: activePresentation ? activePresentation.slides : undefined,
    passes: { repro: reproPass },
    evidence,
    provenanceText,
  });

  const layout = (!scenario.app && scenario.stage.layout !== 'split-actors') ? 'split-actors' : scenario.stage.layout;
  const stageHtmlPath = resolveStageHtmlPath(layout, stagePath);
  const { server, origin } = await startStageHttpServer({ evidenceDir, stageHtmlPath, externalFilesMap });

  const wantMp4 = formats.includes('mp4');
  const wantGif = formats.includes('gif');
  const finalMp4Path = outPath || path.join(evidenceDir, 'video.mp4');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-render-mp4-'));
  const workingMp4Path = path.join(tempDir, 'temp-video.mp4');
  const workingGifPath = path.join(tempDir, 'temp-preview.gif');

  const storyboardDir = path.join(evidenceDir, 'storyboard');
  fs.mkdirSync(storyboardDir, { recursive: true });
  for (const existingFile of fs.readdirSync(storyboardDir)) {
    if (/^beat-\d+-.*\.png$/i.test(existingFile)) {
      fs.unlinkSync(path.join(storyboardDir, existingFile));
    }
  }

  const eventList = Array.isArray(eventsData)
    ? eventsData
    : Array.isArray(eventsData?.events)
      ? eventsData.events
      : [];
  const controlEvent = eventList.find(
    (ev) => ev && (String(ev.phase || '').toLowerCase() === 'control' || String(ev.id || '').toLowerCase() === 'control'),
  );
  const reproEvent = eventList.find(
    (ev) => ev && (String(ev.phase || '').toLowerCase() === 'repro' || String(ev.id || '').toLowerCase() === 'repro'),
  );

  const beatMidpointMap = new Map();
  let reproMidFrameIndex = Math.min(totalFrames - 1, Math.floor(totalFrames / 2));
  const presentationSlides = Array.isArray(activePresentation?.slides) ? activePresentation.slides : null;
  const findSlide = (id) => presentationSlides?.find((s) => s.id === id) || null;

  timeline.beats.forEach((beat, idx) => {
    let targetSec = (beat.startSec + beat.endSec) / 2;
    if (presentationSlides) {
      let targetSlide = null;
      if (beat.id === 'hook' || beat.phase === 'hook') {
        targetSlide = findSlide('attach-demo') || findSlide('path-slide') || findSlide('baseline-video') || findSlide('baseline-slide') || presentationSlides[0];
      } else if (beat.id === 'repro') {
        targetSlide = findSlide('problem-video') || findSlide('problem-slide');
      } else if (beat.id === 'fix') {
        targetSlide = findSlide('why-slide') || findSlide('fix-slide') || findSlide('fix-video');
      } else if (beat.id === 'takeaway') {
        targetSlide = findSlide('fix-video') || findSlide('fix-slide');
      }
      if (targetSlide) {
        const span = Math.max(0.2, targetSlide.endSec - targetSlide.startSec);
        targetSec =
          targetSlide.kind === 'video'
            ? targetSlide.startSec + span * 0.72
            : targetSlide.startSec + span * 0.5;
      }
    } else if ((beat.id === 'hook' || beat.phase === 'hook') && controlEvent) {
      const controlMs =
        typeof controlEvent.executedAtMs === 'number' ? controlEvent.executedAtMs : controlEvent.tMs;
      if (typeof controlMs === 'number' && Number.isFinite(controlMs) && controlMs >= 0) {
        const controlSec = controlMs / 1000;
        if (controlSec >= beat.startSec && beat.endSec - controlSec >= 0.4) {
          targetSec = Math.min(
            beat.endSec - 0.15,
            Math.max(controlSec + 0.2, (controlSec + beat.endSec) / 2),
          );
        }
      }
    } else if ((beat.id === 'repro' || beat.phase === 'repro') && reproEvent) {
      const executedMs =
        typeof reproEvent.executedAtMs === 'number' ? reproEvent.executedAtMs : reproEvent.tMs;
      if (typeof executedMs === 'number' && Number.isFinite(executedMs) && executedMs >= 0) {
        const executedSec = executedMs / 1000;
        if (executedSec >= beat.startSec && beat.endSec - executedSec >= 1.0) {
          const breachWindowEndSec = Math.min(beat.endSec - 0.5, executedSec + 2.2);
          const breachWindowStartSec = Math.min(breachWindowEndSec, executedSec + 0.5);
          targetSec = (breachWindowStartSec + breachWindowEndSec) / 2;
        }
      }
    }
    const midFrame = Math.min(totalFrames - 1, Math.max(0, Math.round(targetSec * fps)));
    if (beat.id === 'repro' || beat.phase === 'repro') {
      reproMidFrameIndex = midFrame;
    }
    const list = beatMidpointMap.get(midFrame) || [];
    list.push({ fileName: `beat-${String(idx + 1).padStart(2, '0')}-${beat.id}.png` });
    beatMidpointMap.set(midFrame, list);
  });

  let browser = null;
  let encoder = null;
  const storyboardRelPaths = [];
  const posterPath = path.join(evidenceDir, 'poster.png');
  let reproPosterSource = null;
  let domProvenanceText = provenanceText;

  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox', '--headless=new'],
    });
    const context = await browser.newContext({
      viewport: { width: dimensions.width, height: dimensions.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.addInitScript((injectedPayload) => {
      window.__PYRIC_EVIDENCE__ = injectedPayload;
    }, payload);

    await page.goto(`${origin}/__pyric_stage.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => typeof window.setFrame === 'function', { timeout: 10000 });

    encoder = createH264PipeEncoder({
      ffmpegPath: tools.ffmpegPath,
      width: dimensions.width,
      height: dimensions.height,
      fps,
      outMp4Path: workingMp4Path,
    });

    log(`Rendering ${totalFrames} frames (${dimensions.width}x${dimensions.height} @ ${fps}fps)...`);

    const deckSlides = activePresentation?.slides || null;
    let cachedStaticSlide = { id: null, buffer: null, settled: false };
    let cachedVideoFrame = { key: null, buffer: null };

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const tSec = frameIndex / fps;
      const tMs = tSec * 1000;
      const currentSlide = deckSlides
        ? deckSlides.find((s, i) => tMs >= s.startMs && (tMs < s.endMs || i === deckSlides.length - 1))
        : null;

      if (!currentSlide || currentSlide.kind !== 'slide' || cachedStaticSlide.id !== currentSlide.id) {
        cachedStaticSlide = { id: currentSlide?.id || null, buffer: null, settled: false };
      }

      let pngBuffer;
      const elapsedSlideMs = currentSlide ? tMs - currentSlide.startMs : 0;
      let videoRenderKey = null;
      if (currentSlide && currentSlide.kind === 'video' && elapsedSlideMs >= 100) {
        const videoFiles = reproPass?.frames?.[frameIndex]?.files || {};
        const impactOffsetSec =
          typeof currentSlide.impactOffsetSec === 'number' ? currentSlide.impactOffsetSec : 0.45;
        const slideSec = elapsedSlideMs / 1000;
        const hasImpacted = slideSec >= impactOffsetSec;
        const overlaySettled =
          elapsedSlideMs >= 100 && Math.abs(slideSec - impactOffsetSec) >= 0.05;
        if (overlaySettled) {
          videoRenderKey = `${currentSlide.id}|${hasImpacted ? 1 : 0}|${videoFiles.owner || ''}|${videoFiles.peer || ''}`;
        }
      } else if (!currentSlide) {
        const videoFiles = reproPass?.frames?.[frameIndex]?.files || {};
        const activeBeat = timeline.beats.find(
          (b, i) => tMs >= b.startMs && (tMs < b.endMs || i === timeline.beats.length - 1),
        );
        if (elapsedSlideMs >= 120) {
          videoRenderKey = `beat:${activeBeat?.id || 'main'}|${videoFiles.owner || ''}|${videoFiles.peer || ''}`;
        }
      }

      if (
        frameIndex > 0 &&
        currentSlide &&
        currentSlide.kind === 'slide' &&
        elapsedSlideMs >= 100 &&
        cachedStaticSlide.settled &&
        cachedStaticSlide.buffer
      ) {
        pngBuffer = cachedStaticSlide.buffer;
      } else if (
        frameIndex > 0 &&
        videoRenderKey &&
        cachedVideoFrame.key === videoRenderKey &&
        cachedVideoFrame.buffer
      ) {
        pngBuffer = cachedVideoFrame.buffer;
      } else {
        await page.evaluate(
          ({ t, idx, total }) => window.setFrame(t, idx, total),
          { t: tSec, idx: frameIndex, total: totalFrames },
        );

        if (frameIndex === 0) {
          domProvenanceText = await verifyRenderedProvenance(page);
        }

        pngBuffer = await page.screenshot({ type: 'png' });

        if (currentSlide && currentSlide.kind === 'slide' && elapsedSlideMs >= 120) {
          if (cachedStaticSlide.buffer && Buffer.compare(pngBuffer, cachedStaticSlide.buffer) === 0) {
            cachedStaticSlide.settled = true;
          }
          cachedStaticSlide.buffer = pngBuffer;
        }
        if (videoRenderKey) {
          cachedVideoFrame = { key: videoRenderKey, buffer: pngBuffer };
        }
      }

      await encoder.writeFrame(pngBuffer);

      const midEntries = beatMidpointMap.get(frameIndex);
      if (midEntries) {
        for (const entry of midEntries) {
          const outKeyframe = path.join(storyboardDir, entry.fileName);
          fs.writeFileSync(outKeyframe, pngBuffer);
          storyboardRelPaths.push(`storyboard/${entry.fileName}`);
          if (frameIndex === reproMidFrameIndex) {
            reproPosterSource = outKeyframe;
          }
        }
      }
    }

    await encoder.finish();

    if (reproPosterSource && fs.existsSync(reproPosterSource)) {
      fs.copyFileSync(reproPosterSource, posterPath);
    } else if (storyboardRelPaths.length > 0) {
      fs.copyFileSync(path.join(evidenceDir, storyboardRelPaths[0]), posterPath);
    }

    const previewGifPath = path.join(evidenceDir, 'preview.gif');
    if (wantGif) {
      const gifWidth = Math.min(960, dimensions.width);
      log(`Transcoding preview GIF (${gifWidth}px wide)...`);
      await transcodePreviewGif({
        ffmpegPath: tools.ffmpegPath,
        inputMp4Path: workingMp4Path,
        outGifPath: workingGifPath,
        fps: 12,
        width: gifWidth,
        maxSeconds: 8,
      });
    }

    const shareMarkdown = buildShareMarkdown({ scenario, provenanceText, evidenceDir });

    const mediaProbe = tools.ffprobePath && fs.existsSync(workingMp4Path)
      ? await probeMedia({ ffprobePath: tools.ffprobePath, mediaPath: workingMp4Path })
      : null;

    const g6Pass = await runGateG6({
      videoPath: workingMp4Path,
      ffprobeResult: mediaProbe,
      expectedWidth: dimensions.width,
      expectedHeight: dimensions.height,
      captureArtifact,
      posterPath,
      storyboardPaths: storyboardRelPaths.map((rel) => path.join(evidenceDir, rel)),
      domProvenanceText,
      expectedProvenanceText: provenanceText,
      copy: scenario.copy,
      slides: activePresentation ? activePresentation.slides : [],
      beats: timeline.beats,
      shareMarkdown,
      events: eventList.length > 0 ? eventList : evidence.events,
    });

    if (wantMp4) {
      fs.mkdirSync(path.dirname(finalMp4Path), { recursive: true });
      fs.copyFileSync(workingMp4Path, finalMp4Path);
    }
    if (wantGif) {
      fs.copyFileSync(workingGifPath, previewGifPath);
    }
    fs.writeFileSync(path.join(evidenceDir, 'share.md'), shareMarkdown, 'utf8');

    const artifacts = Object.assign({}, existingManifest?.artifacts || {}, {
      poster: 'poster.png',
      storyboard: storyboardRelPaths,
      share: 'share.md',
    });
    if (wantMp4) {
      artifacts.reproMp4 = toBundleArtifactPath(evidenceDir, finalMp4Path);
    }
    if (wantGif) {
      artifacts.previewGif = 'preview.gif';
    }

    const mergedGates = Object.assign({}, existingManifest?.gates || {}, { g6: g6Pass });
    const nextManifest = validateBundleManifest(
      Object.assign({}, existingManifest || {}, {
        schema: BUNDLE_SCHEMA,
        status: 'reproduced',
        finding: scenario.finding,
        gates: mergedGates,
        provenanceText,
        renderedAt: new Date().toISOString(),
        timeline: {
          fps,
          totalSec: renderTotalSec,
          totalFrames,
          dimensions,
          layout: stagePath ? 'custom' : layout,
          beats: timeline.beats,
          ...(activePresentation ? { slides: activePresentation.slides } : {}),
        },
        artifacts,
      }),
    );

    fs.writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n', 'utf8');

    return {
      ok: true,
      evidenceDir,
      manifestPath,
      provenanceText,
      gates: mergedGates,
      dimensions,
      fps,
      totalFrames,
      totalSec: renderTotalSec,
      beats: timeline.beats,
      ...(activePresentation ? { slides: activePresentation.slides } : {}),
      artifacts,
      media: wantMp4 ? mediaProbe : null,
    };
  } catch (err) {
    if (encoder) {
      encoder.abort();
      encoder = null;
    }
    if (
      err instanceof EvidenceRenderError &&
      (err.code === 'GATE_G6_FAILED' || err.code === 'PROVENANCE_MISSING_OR_HIDDEN')
    ) {
      if (fs.existsSync(finalMp4Path)) {
        fs.rmSync(finalMp4Path, { force: true });
      }
      for (const staleRel of ['poster.png', 'share.md']) {
        const p = path.join(evidenceDir, staleRel);
        if (fs.existsSync(p)) {
          fs.rmSync(p, { force: true });
        }
      }
      writeFailureBundle({
        outDir: evidenceDir,
        finding: scenario.finding,
        failedGate: 'G6',
        reasons: err.details?.reasons || [err.message],
        provenanceText,
        gates: Object.assign(
          { g1: true, g2: true, g3: true, g4: true, g5: 'skipped' },
          existingManifest?.gates || {},
          { g6: false },
        ),
      });
    }
    throw err;
  } finally {
    if (encoder) {
      encoder.abort();
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(() => resolve()));
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  let cli = { json: false };
  try {
    cli = parseCliArgs(process.argv.slice(2));
    if (cli.help) {
      process.stdout.write(
        'Usage: node render.mjs <evidenceDir> [--stage <customStage.html>] [--size <WxH>] [--formats mp4,gif] [--fps 30] [--out <videoPath>] [--json]\n',
      );
      return;
    }
    const result = await renderEvidenceBundle({
      evidenceDir: cli.evidenceDir,
      stagePath: cli.stagePath,
      sizeStr: cli.sizeStr,
      formats: cli.formats,
      fps: cli.fps,
      outPath: cli.outPath,
      log: (msg) => {
        if (!cli.json) {
          process.stderr.write(`${msg}\n`);
        }
      },
    });
    if (cli.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(`Rendered evidence bundle in ${result.evidenceDir} (${result.totalFrames} frames, ${result.totalSec}s)\n`);
    }
  } catch (err) {
    const code = err?.code || 'RENDER_ERROR';
    const message = err?.message || String(err);
    if (cli.json) {
      const errorPayload = { ok: false, error: { code, message } };
      if (err?.details) {
        errorPayload.error.details = err.details;
      }
      process.stdout.write(JSON.stringify(errorPayload, null, 2) + '\n');
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
  await main();
}
