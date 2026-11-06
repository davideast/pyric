/**
 * Verification Gates (G1-G6), pure-Node PNG inspection, and provenance/secret guards
 * for Pyric security-audit evidence videos.
 *
 * Zero external runtime dependencies (Node >=22.15 built-ins only) so scripts run
 * directly from any plugin cache directory even when node_modules is absent.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  BUNDLE_SCHEMA,
  buildLockedProvenanceText,
  validateBundleManifest,
} from './contracts.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SAFE_SYNTHETIC_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'pyric.local',
  'test.local',
  'localhost',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode an 8-bit PNG file into raw unfiltered scanline bytes.
 */
function decodePngFile(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('PNG file path must be a non-empty string');
  }
  const buf = fs.readFileSync(filePath);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`Invalid PNG header in ${filePath}`);
  }

  let offset = 8;
  let ihdr = null;
  const idatChunks = [];

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated PNG chunk "${type}" in ${filePath}`);
    }
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === 'IHDR') {
      if (length !== 13) {
        throw new Error(`Invalid IHDR length ${length} in ${filePath}`);
      }
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        compressionMethod: data.readUInt8(10),
        filterMethod: data.readUInt8(11),
        interlaceMethod: data.readUInt8(12),
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) {
    throw new Error(`Missing IHDR chunk in ${filePath}`);
  }
  if (ihdr.width === 0 || ihdr.height === 0) {
    throw new Error(`Invalid PNG dimensions ${ihdr.width}x${ihdr.height} in ${filePath}`);
  }
  if (ihdr.compressionMethod !== 0 || ihdr.filterMethod !== 0) {
    throw new Error(`Unsupported PNG compression/filter method in ${filePath}`);
  }
  if (ihdr.interlaceMethod !== 0) {
    throw new Error(`Interlaced PNG is not supported in ${filePath}`);
  }
  if (ihdr.bitDepth !== 8) {
    throw new Error(`Unsupported PNG bitDepth ${ihdr.bitDepth} in ${filePath} (expected 8)`);
  }

  let bpp;
  if (ihdr.colorType === 2) {
    bpp = 3; // RGB
  } else if (ihdr.colorType === 6) {
    bpp = 4; // RGBA
  } else if (ihdr.colorType === 0) {
    bpp = 1; // Grayscale
  } else if (ihdr.colorType === 4) {
    bpp = 2; // Grayscale + Alpha
  } else {
    throw new Error(`Unsupported PNG colorType ${ihdr.colorType} in ${filePath}`);
  }

  if (idatChunks.length === 0) {
    throw new Error(`Missing IDAT chunks in ${filePath}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = ihdr.width * bpp;
  const expectedRawBytes = ihdr.height * (stride + 1);
  if (raw.length < expectedRawBytes) {
    throw new Error(
      `Decompressed PNG payload too small in ${filePath}: got ${raw.length} bytes, expected ${expectedRawBytes}`,
    );
  }

  const unfiltered = new Uint8Array(ihdr.height * stride);
  for (let y = 0; y < ihdr.height; y++) {
    const inRow = y * (stride + 1);
    const filterType = raw[inRow];
    const outRow = y * stride;
    const prevRow = (y - 1) * stride;

    for (let i = 0; i < stride; i++) {
      const x = raw[inRow + 1 + i];
      const a = i >= bpp ? unfiltered[outRow + i - bpp] : 0;
      const b = y > 0 ? unfiltered[prevRow + i] : 0;
      const c = y > 0 && i >= bpp ? unfiltered[prevRow + i - bpp] : 0;

      let recon;
      switch (filterType) {
        case 0:
          recon = x;
          break;
        case 1:
          recon = (x + a) & 0xff;
          break;
        case 2:
          recon = (x + b) & 0xff;
          break;
        case 3:
          recon = (x + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          recon = (x + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG scanline filterType ${filterType} in ${filePath}`);
      }
      unfiltered[outRow + i] = recon;
    }
  }

  return {
    width: ihdr.width,
    height: ihdr.height,
    bitDepth: ihdr.bitDepth,
    colorType: ihdr.colorType,
    bpp,
    unfiltered,
  };
}

/**
 * Pure-Node PNG Inspector.
 * Parses PNG chunks, unfilters 8-bit RGB/RGBA scanlines, and computes luma stats and hash.
 */
export function inspectPngFile(filePath) {
  const { width, height, bpp, unfiltered } = decodePngFile(filePath);
  const pixelCount = width * height;

  let meanLuma = 0;
  let m2 = 0;
  let minLuma = Infinity;
  let maxLuma = -Infinity;

  for (let p = 0; p < pixelCount; p++) {
    const idx = p * bpp;
    let r;
    let g;
    let b;
    let alphaScale = 1;

    if (bpp === 3) {
      r = unfiltered[idx];
      g = unfiltered[idx + 1];
      b = unfiltered[idx + 2];
    } else if (bpp === 4) {
      r = unfiltered[idx];
      g = unfiltered[idx + 1];
      b = unfiltered[idx + 2];
      alphaScale = unfiltered[idx + 3] / 255;
    } else if (bpp === 1) {
      r = g = b = unfiltered[idx];
    } else {
      r = g = b = unfiltered[idx];
      alphaScale = unfiltered[idx + 1] / 255;
    }

    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) * alphaScale;
    if (luma < minLuma) minLuma = luma;
    if (luma > maxLuma) maxLuma = luma;

    const delta = luma - meanLuma;
    meanLuma += delta / (p + 1);
    const delta2 = luma - meanLuma;
    m2 += delta * delta2;
  }

  const lumaStdDev = Math.sqrt(m2 / pixelCount);
  const isBlank = lumaStdDev < 1.5 || maxLuma - minLuma < 8;
  const sampleHash = crypto
    .createHash('sha256')
    .update(`${width}x${height}x${bpp}:`)
    .update(unfiltered)
    .digest('hex');

  return {
    width,
    height,
    pixelCount,
    meanLuma,
    lumaStdDev,
    minLuma,
    maxLuma,
    isBlank,
    sampleHash,
  };
}

/**
 * Compare two PNG frames pixel-by-pixel for motion delta checks.
 */
export function comparePngFrames(fileA, fileB) {
  const frameA = decodePngFile(fileA);
  const frameB = decodePngFile(fileB);

  if (frameA.width !== frameB.width || frameA.height !== frameB.height) {
    return {
      identical: false,
      meanAbsDiff: 255,
    };
  }

  if (frameA.bpp === frameB.bpp) {
    const len = frameA.unfiltered.length;
    let totalAbsDiff = 0;
    for (let i = 0; i < len; i++) {
      totalAbsDiff += Math.abs(frameA.unfiltered[i] - frameB.unfiltered[i]);
    }
    return {
      identical: totalAbsDiff === 0,
      meanAbsDiff: len > 0 ? totalAbsDiff / len : 0,
    };
  }

  // Cross-channel fallback (e.g. RGB vs RGBA)
  const pixelCount = frameA.width * frameA.height;
  let totalAbsDiff = 0;
  for (let p = 0; p < pixelCount; p++) {
    const idxA = p * frameA.bpp;
    const idxB = p * frameB.bpp;
    const rA = frameA.unfiltered[idxA];
    const gA = frameA.bpp >= 3 ? frameA.unfiltered[idxA + 1] : rA;
    const bA = frameA.bpp >= 3 ? frameA.unfiltered[idxA + 2] : rA;
    const aA = frameA.bpp === 4 ? frameA.unfiltered[idxA + 3] : frameA.bpp === 2 ? frameA.unfiltered[idxA + 1] : 255;

    const rB = frameB.unfiltered[idxB];
    const gB = frameB.bpp >= 3 ? frameB.unfiltered[idxB + 1] : rB;
    const bB = frameB.bpp >= 3 ? frameB.unfiltered[idxB + 2] : rB;
    const aB = frameB.bpp === 4 ? frameB.unfiltered[idxB + 3] : frameB.bpp === 2 ? frameB.unfiltered[idxB + 1] : 255;

    totalAbsDiff += Math.abs(rA - rB) + Math.abs(gA - gB) + Math.abs(bA - bB) + Math.abs(aA - aB);
  }
  const totalChannels = pixelCount * 4;
  return {
    identical: totalAbsDiff === 0,
    meanAbsDiff: totalChannels > 0 ? totalAbsDiff / totalChannels : 0,
  };
}

function formatSample(raw) {
  if (raw.length <= 80) return raw;
  return `${raw.slice(0, 77)}...`;
}

function isAllowedSyntheticDomain(domain, allowedSet) {
  if (SAFE_SYNTHETIC_EMAIL_DOMAINS.has(domain)) return true;
  for (const safe of SAFE_SYNTHETIC_EMAIL_DOMAINS) {
    if (domain.endsWith(`.${safe}`)) return true;
  }
  return allowedSet.has(domain);
}

/**
 * Scan copy fields, captions, overlays, and event strings for secrets and non-synthetic PII.
 */
export function scanTextForSecretsAndPii(text, { allowedEmails = [] } = {}) {
  if (text === null || text === undefined) {
    return { clean: true, findings: [] };
  }
  const source = typeof text === 'string' ? text : JSON.stringify(text);
  if (!source) {
    return { clean: true, findings: [] };
  }

  const findings = [];
  const allowedEmailSet = new Set();
  const allowedDomainSet = new Set();
  for (const entry of allowedEmails ?? []) {
    const normalized = String(entry).trim().toLowerCase();
    if (!normalized) continue;
    if (normalized.includes('@')) {
      allowedEmailSet.add(normalized);
    } else {
      allowedDomainSet.add(normalized.replace(/^@/, ''));
    }
  }

  // 1. Private keys
  const privateKeyRe = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
  for (const match of source.matchAll(privateKeyRe)) {
    findings.push({ type: 'private_key', sample: formatSample(match[0]) });
  }

  // 2. AWS access keys
  const awsKeyRe = /AKIA[0-9A-Z]{16}/g;
  for (const match of source.matchAll(awsKeyRe)) {
    findings.push({ type: 'aws_access_key', sample: formatSample(match[0]) });
  }

  // 3. GCP / Firebase live API keys (allow explicit emulator/synthetic markers unless leak suspected)
  const gcpKeyRe = /AIza[0-9A-Za-z_-]{35}/g;
  for (const match of source.matchAll(gcpKeyRe)) {
    const key = match[0];
    const idx = match.index ?? 0;
    const context = source.slice(Math.max(0, idx - 160), Math.min(source.length, idx + key.length + 160));
    const explicitlyEmulatorOrSynthetic =
      /(?:^|[^a-z])(emulator|synthetic|mock|fake|dummy)/i.test(context) ||
      /(emulator|synthetic)/i.test(key);
    const suspectedLeak =
      /(?:^|[^a-z])(leak|leaked|credential|secret|prod|production|live|private|service[-_]?account|dotenv|\.env)/i.test(
        context,
      );
    if (!explicitlyEmulatorOrSynthetic || suspectedLeak) {
      findings.push({ type: 'gcp_api_key', sample: formatSample(key) });
    }
  }

  // 4. JWT & Bearer tokens
  const jwtSpans = [];
  const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
  for (const match of source.matchAll(jwtRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    jwtSpans.push([start, end]);
    findings.push({ type: 'jwt_token', sample: formatSample(match[0]) });
  }

  const bearerRe = /Bearer\s+[A-Za-z0-9._-]{20,}/gi;
  for (const match of source.matchAll(bearerRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const overlapsJwt = jwtSpans.some(([jStart, jEnd]) => jStart >= start && jEnd <= end);
    if (!overlapsJwt) {
      findings.push({ type: 'bearer_token', sample: formatSample(match[0]) });
    }
  }

  // 5. GitHub / Slack / generic sk- secrets
  const githubRe = /gh[pousr]_[A-Za-z0-9]{36}/g;
  for (const match of source.matchAll(githubRe)) {
    findings.push({ type: 'github_token', sample: formatSample(match[0]) });
  }

  const slackRe = /xox[baprs]-[A-Za-z0-9-]{10,}/g;
  for (const match of source.matchAll(slackRe)) {
    findings.push({ type: 'slack_token', sample: formatSample(match[0]) });
  }

  const skSecretRe = /(?<![A-Za-z0-9])sk-(?:proj-|live-|test-)?[A-Za-z0-9]{20,}/g;
  for (const match of source.matchAll(skSecretRe)) {
    findings.push({ type: 'secret_key', sample: formatSample(match[0]) });
  }

  // 6. Real non-synthetic email addresses
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  for (const match of source.matchAll(emailRe)) {
    const email = match[0];
    const lowerEmail = email.toLowerCase();
    const atIdx = lowerEmail.lastIndexOf('@');
    const domain = lowerEmail.slice(atIdx + 1);
    if (allowedEmailSet.has(lowerEmail) || isAllowedSyntheticDomain(domain, allowedDomainSet)) {
      continue;
    }
    findings.push({ type: 'email_pii', sample: formatSample(email) });
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}

/**
 * Verify locked provenance text and copy consistency against verified execution events.
 */
export function checkCopyAgainstEvents({
  copy,
  provenanceText,
  exploitEvent,
  fixEvent,
} = {}) {
  const reasons = [];

  if (!exploitEvent || typeof exploitEvent !== 'object') {
    reasons.push('Missing exploitEvent for provenance and copy consistency check');
    return { pass: false, reasons };
  }

  const service = exploitEvent.service ?? exploitEvent.operation?.service;
  const method = exploitEvent.method ?? exploitEvent.operation?.method;
  const targetPath = exploitEvent.path ?? exploitEvent.operation?.path;
  const actorLabel = exploitEvent.actorLabel;

  let expectedProvenanceText = '';
  if (!exploitEvent.decision || !service || !method || !targetPath) {
    reasons.push(
      'Cannot construct locked provenance text: exploitEvent requires decision, service, method, and path',
    );
  } else {
    expectedProvenanceText = buildLockedProvenanceText({
      decision: exploitEvent.decision,
      fixedDecision: fixEvent?.decision,
      service,
      method,
      path: targetPath,
      actorLabel,
    });
    if (typeof provenanceText !== 'string' || provenanceText.trim() !== expectedProvenanceText) {
      reasons.push(
        `Provenance text mismatch: expected "${expectedProvenanceText}", got "${provenanceText ?? ''}"`,
      );
    }
  }

  if (copy !== undefined && copy !== null) {
    const exploitCopyText =
      typeof copy === 'string'
        ? copy
        : isPlainObject(copy)
          ? [copy.title, copy.exploit, copy.why, copy.baseline].filter(Boolean).join(' ')
          : '';

    if (exploitEvent.decision === 'ALLOW' && exploitCopyText) {
      if (/(?<!\bnot\s)\b(DENIED|BLOCKED)\b/i.test(exploitCopyText)) {
        reasons.push(
          'Copy contradicts exploit event: exploit decision is ALLOW, but copy claims DENIED or BLOCKED',
        );
      }
    }

    if (fixEvent && fixEvent.decision !== 'DENY') {
      const fixCopyText =
        typeof copy === 'string'
          ? copy
          : isPlainObject(copy)
            ? [copy.fixed, copy.title, copy.exploit, copy.why].filter(Boolean).join(' ')
            : '';
      if (fixCopyText && /(?<!\bnot\s)\b(FIXED|BLOCKED)\b/i.test(fixCopyText)) {
        reasons.push(
          `Copy contradicts fix event: fix decision is ${fixEvent.decision ?? 'missing'} (expected DENY), but copy claims FIXED or BLOCKED`,
        );
      }
    }
  }

  return {
    pass: reasons.length === 0,
    reasons,
    expectedProvenanceText,
  };
}

/**
 * Gate G1: Preconditions (probe classification, target hash, mutationSpec path, invariant).
 */
export function evaluateGateG1(probe, { expectedTargetHash } = {}) {
  const reasons = [];

  if (!isPlainObject(probe)) {
    reasons.push('Missing or invalid probe object');
    return { pass: false, gate: 'G1', name: 'Preconditions', reasons };
  }

  if (probe.classification !== 'confirmed' && probe.classification !== 'local-counterexample') {
    reasons.push(
      `Probe classification must be "confirmed" or "local-counterexample" (got ${JSON.stringify(probe.classification)})`,
    );
  }

  if (expectedTargetHash !== undefined && expectedTargetHash !== null && expectedTargetHash !== '') {
    if (probe.targetHash !== expectedTargetHash) {
      reasons.push(
        `Probe targetHash mismatch: expected "${expectedTargetHash}", got "${probe.targetHash ?? ''}"`,
      );
    }
  }

  const opPath = probe.mutationSpec?.operation?.path;
  if (typeof opPath !== 'string' || opPath.trim().length === 0) {
    reasons.push('Missing probe.mutationSpec.operation.path');
  }

  const hasInvariant =
    probe.invariant !== null &&
    probe.invariant !== undefined &&
    (typeof probe.invariant !== 'string' || probe.invariant.trim().length > 0);
  if (!hasInvariant) {
    reasons.push('Missing probe.invariant');
  }

  return {
    pass: reasons.length === 0,
    gate: 'G1',
    name: 'Preconditions',
    reasons,
  };
}

/**
 * Gate G2: Baseline (control operation must be ALLOW).
 */
export function evaluateGateG2(controlResult) {
  const reasons = [];

  if (!isPlainObject(controlResult)) {
    reasons.push('Missing controlResult object');
  } else if (controlResult.decision !== 'ALLOW') {
    reasons.push(
      `Control baseline decision must be "ALLOW" (got ${JSON.stringify(controlResult.decision)})`,
    );
  }

  return {
    pass: reasons.length === 0,
    gate: 'G2',
    name: 'Baseline',
    reasons,
  };
}

function normalizeResourcePath(p) {
  if (typeof p !== 'string') return '';
  const trimmed = p.trim();
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

function pathsMatchOrRelated(a, b) {
  const na = normalizeResourcePath(a);
  const nb = normalizeResourcePath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na === '/' || nb === '/') return true;
  return nb.startsWith(`${na}/`) || na.startsWith(`${nb}/`);
}

/**
 * Gate G3: Exploit (attacker exploit must be ALLOW and affect expected path when changedPaths provided).
 */
export function evaluateGateG3(exploitResult, expectedPaths = []) {
  const reasons = [];

  if (!isPlainObject(exploitResult)) {
    reasons.push('Missing exploitResult object');
    return { pass: false, gate: 'G3', name: 'Exploit', reasons };
  }

  if (exploitResult.decision !== 'ALLOW') {
    reasons.push(
      `Exploit decision must be "ALLOW" (got ${JSON.stringify(exploitResult.decision)})`,
    );
  }

  const expectedList = Array.isArray(expectedPaths)
    ? expectedPaths.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : typeof expectedPaths === 'string' && expectedPaths.trim().length > 0
      ? [expectedPaths]
      : [];

  if (expectedList.length > 0 && Array.isArray(exploitResult.changedPaths)) {
    const matched = expectedList.some((expected) =>
      exploitResult.changedPaths.some((changed) => pathsMatchOrRelated(expected, changed)),
    );
    if (!matched) {
      reasons.push(
        `Exploit changedPaths ${JSON.stringify(exploitResult.changedPaths)} do not match expected paths ${JSON.stringify(expectedList)}`,
      );
    }
  }

  return {
    pass: reasons.length === 0,
    gate: 'G3',
    name: 'Exploit',
    reasons,
  };
}

/**
 * Gate G4: Visible effect (app-view assertion or data-plane stateDiff).
 */
export function evaluateGateG4({ mode = 'data-plane', expectResult, stateDiff } = {}) {
  const reasons = [];

  if (mode === 'app-view') {
    if (expectResult?.pass !== true) {
      const detail =
        typeof expectResult?.reason === 'string' && expectResult.reason.length > 0
          ? `: ${expectResult.reason}`
          : '';
      reasons.push(`App-view visible effect check failed (expected expectResult.pass === true)${detail}`);
    }
  } else if (mode === 'data-plane') {
    const hasChangedPaths = Array.isArray(stateDiff?.changedPaths) && stateDiff.changedPaths.length > 0;
    const hasAfterState = stateDiff?.after !== undefined;
    if (!stateDiff || (!hasChangedPaths && !hasAfterState)) {
      reasons.push('Data-plane visible effect check failed: stateDiff requires changedPaths or after state');
    }
  } else {
    reasons.push(`Unsupported G4 mode "${mode}" (expected "data-plane" or "app-view")`);
  }

  return {
    pass: reasons.length === 0,
    gate: 'G4',
    name: 'Visible effect',
    reasons,
  };
}

/**
 * Gate G5: Fix verification (when enabled, exploit must be DENY, zero changedPaths, control ALLOW).
 */
export function evaluateGateG5({
  enabled = false,
  fixControlResult,
  fixExploitResult,
  fixStateDiff,
} = {}) {
  if (!enabled) {
    return {
      pass: true,
      skipped: true,
      gate: 'G5',
      name: 'Fix',
      reasons: [],
    };
  }

  const reasons = [];

  if (!isPlainObject(fixExploitResult) || fixExploitResult.decision !== 'DENY') {
    reasons.push(
      `Fix exploit decision must be "DENY" (got ${JSON.stringify(fixExploitResult?.decision)})`,
    );
  }

  if (fixStateDiff?.changedPaths?.length) {
    reasons.push(
      `Fix verification requires zero changed paths (got ${JSON.stringify(fixStateDiff.changedPaths)})`,
    );
  }

  if (fixControlResult !== undefined && fixControlResult !== null) {
    if (!isPlainObject(fixControlResult) || fixControlResult.decision !== 'ALLOW') {
      reasons.push(
        `Fix control decision must remain "ALLOW" (got ${JSON.stringify(fixControlResult?.decision)})`,
      );
    }
  }

  return {
    pass: reasons.length === 0,
    skipped: false,
    gate: 'G5',
    name: 'Fix',
    reasons,
  };
}

/**
 * Gate G6: Render integrity (video file, ffprobe dimensions/duration, CFR frame gaps,
 * non-blank PNG poster & storyboard, motion delta, locked provenance strip, secret/PII scan,
 * and copy-vs-events consistency).
 */
export function evaluateGateG6({
  videoPath,
  ffprobeResult,
  expectedWidth,
  expectedHeight,
  minDurationSec = 1.0,
  maxDurationSec = 120.0,
  captureArtifact,
  posterPath,
  storyboardPaths = [],
  domProvenanceText,
  expectedProvenanceText,
  copy,
  events = [],
  exploitEvent,
  fixEvent,
  requireMotion = false,
  allowedEmails = [],
} = {}) {
  const reasons = [];
  const details = {
    videoSizeBytes: 0,
    storyboardFrames: [],
  };

  // 1. Video file existence & non-zero size
  if (typeof videoPath !== 'string' || videoPath.trim().length === 0) {
    reasons.push('Missing videoPath');
  } else if (!fs.existsSync(videoPath)) {
    reasons.push(`Video file does not exist: ${videoPath}`);
  } else {
    const stat = fs.statSync(videoPath);
    details.videoSizeBytes = stat.size;
    if (!stat.isFile() || stat.size <= 0) {
      reasons.push(`Video file is empty (0 bytes): ${videoPath}`);
    }
  }

  // 2. ffprobe dimensions & duration
  if (!isPlainObject(ffprobeResult)) {
    reasons.push('Missing ffprobeResult metadata');
  } else {
    const videoStream = Array.isArray(ffprobeResult.streams)
      ? ffprobeResult.streams.find((s) => s?.codec_type === 'video') ?? ffprobeResult.streams[0]
      : null;
    const width = ffprobeResult.width ?? videoStream?.width;
    const height = ffprobeResult.height ?? videoStream?.height;
    const rawDuration =
      ffprobeResult.durationSec ??
      ffprobeResult.duration ??
      videoStream?.duration ??
      ffprobeResult.format?.duration;
    const durationSec =
      rawDuration !== undefined && rawDuration !== null ? Number(rawDuration) : undefined;

    details.width = width;
    details.height = height;
    details.durationSec = durationSec;

    if (expectedWidth !== undefined && expectedWidth !== null && width !== expectedWidth) {
      reasons.push(`Video width mismatch: expected ${expectedWidth}, got ${width}`);
    }
    if (expectedHeight !== undefined && expectedHeight !== null && height !== expectedHeight) {
      reasons.push(`Video height mismatch: expected ${expectedHeight}, got ${height}`);
    }
    if (
      typeof durationSec !== 'number' ||
      !Number.isFinite(durationSec) ||
      durationSec < minDurationSec ||
      durationSec > maxDurationSec
    ) {
      reasons.push(
        `Video duration ${durationSec}s out of bounds [${minDurationSec}s, ${maxDurationSec}s]`,
      );
    }
  }

  // 3. Dropped CFR frame gap check
  if (
    captureArtifact?.mode === 'video' &&
    Array.isArray(captureArtifact.packetTimestampsMs) &&
    captureArtifact.packetTimestampsMs.length >= 2
  ) {
    const fps = captureArtifact.fps || 30;
    const maxAllowedGapMs = (1000 / fps) * 2.5;
    const timestamps = captureArtifact.packetTimestampsMs;
    let maxGapMs = 0;
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      if (gap < 0) {
        reasons.push(`Non-monotonic packet timestamp at index ${i}: ${timestamps[i]} < ${timestamps[i - 1]}`);
      }
      if (gap > maxGapMs) {
        maxGapMs = gap;
      }
    }
    details.maxInterPacketGapMs = maxGapMs;
    details.maxAllowedGapMs = maxAllowedGapMs;
    if (maxGapMs > maxAllowedGapMs) {
      reasons.push(
        `Dropped CFR frames detected: max inter-packet gap ${maxGapMs.toFixed(1)}ms exceeds ${maxAllowedGapMs.toFixed(1)}ms`,
      );
    }
  }

  // 4. Poster PNG inspection
  if (typeof posterPath !== 'string' || posterPath.trim().length === 0 || !fs.existsSync(posterPath)) {
    reasons.push(`Poster PNG missing or does not exist: ${posterPath ?? ''}`);
  } else {
    try {
      const posterStats = inspectPngFile(posterPath);
      details.poster = posterStats;
      if (posterStats.isBlank) {
        reasons.push(
          `Poster PNG is blank (lumaStdDev=${posterStats.lumaStdDev.toFixed(2)}, range=${(posterStats.maxLuma - posterStats.minLuma).toFixed(2)})`,
        );
      }
    } catch (err) {
      reasons.push(`Failed to inspect poster PNG (${posterPath}): ${err.message}`);
    }
  }

  // 5. Storyboard PNG inspection
  for (let i = 0; i < (storyboardPaths?.length ?? 0); i++) {
    const framePath = storyboardPaths[i];
    if (typeof framePath !== 'string' || framePath.trim().length === 0 || !fs.existsSync(framePath)) {
      reasons.push(`Storyboard frame[${i}] does not exist: ${framePath}`);
      continue;
    }
    try {
      const stats = inspectPngFile(framePath);
      details.storyboardFrames.push({ path: framePath, ...stats });
      if (stats.isBlank) {
        reasons.push(
          `Storyboard frame[${i}] (${framePath}) is blank (lumaStdDev=${stats.lumaStdDev.toFixed(2)})`,
        );
      }
    } catch (err) {
      reasons.push(`Failed to inspect storyboard frame[${i}] (${framePath}): ${err.message}`);
    }
  }

  // 6. Motion frame-delta check
  if (requireMotion && storyboardPaths.length >= 2) {
    const firstFrame = storyboardPaths[0];
    const lastFrame = storyboardPaths[storyboardPaths.length - 1];
    if (
      typeof firstFrame === 'string' &&
      typeof lastFrame === 'string' &&
      fs.existsSync(firstFrame) &&
      fs.existsSync(lastFrame)
    ) {
      try {
        const delta = comparePngFrames(firstFrame, lastFrame);
        details.motionCheck = delta;
        if (delta.identical !== false) {
          reasons.push('Motion check failed: first and last storyboard frames are identical (frozen render)');
        }
      } catch (err) {
        reasons.push(`Motion check failed: ${err.message}`);
      }
    }
  }

  // 7. Locked provenance strip check
  if (typeof domProvenanceText !== 'string' || domProvenanceText.trim().length === 0) {
    reasons.push('Missing or empty domProvenanceText');
  } else if (
    typeof expectedProvenanceText === 'string' &&
    expectedProvenanceText.length > 0 &&
    domProvenanceText.trim() !== expectedProvenanceText.trim()
  ) {
    reasons.push(
      `Provenance text mismatch: expected "${expectedProvenanceText}", got "${domProvenanceText}"`,
    );
  }

  // 8. Secret & PII scan across serialized copy, domProvenanceText, and events
  const serializedCopy =
    copy !== undefined && copy !== null
      ? typeof copy === 'string'
        ? copy
        : JSON.stringify(copy)
      : '';
  const serializedEvents =
    events !== undefined && events !== null
      ? typeof events === 'string'
        ? events
        : JSON.stringify(events)
      : '';
  const combinedText = [serializedCopy, domProvenanceText ?? '', serializedEvents]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join('\n');

  const secretScan = scanTextForSecretsAndPii(combinedText, { allowedEmails });
  details.secretScan = secretScan;
  if (!secretScan.clean) {
    for (const finding of secretScan.findings) {
      reasons.push(`Secret/PII detected (${finding.type}): ${finding.sample}`);
    }
  }

  // 9. Copy vs Events consistency check
  let resolvedExploitEvent = exploitEvent;
  let resolvedFixEvent = fixEvent;
  if (!resolvedExploitEvent && Array.isArray(events)) {
    resolvedExploitEvent = events.find(
      (e) =>
        isPlainObject(e) &&
        (e.phase === 'exploit' || e.type === 'exploit' || e.step === 'exploit' || e.kind === 'exploit') &&
        e.decision &&
        (e.service || e.operation?.service) &&
        (e.method || e.operation?.method) &&
        (e.path || e.operation?.path),
    );
  }
  if (!resolvedFixEvent && Array.isArray(events)) {
    resolvedFixEvent = events.find(
      (e) =>
        isPlainObject(e) &&
        (e.phase === 'fix' || e.type === 'fix' || e.step === 'fix' || e.kind === 'fix') &&
        e.decision !== undefined,
    );
  }

  if (copy && resolvedExploitEvent) {
    const copyCheck = checkCopyAgainstEvents({
      copy,
      provenanceText: domProvenanceText,
      exploitEvent: resolvedExploitEvent,
      fixEvent: resolvedFixEvent,
    });
    details.copyCheck = copyCheck;
    if (!copyCheck.pass) {
      reasons.push(...copyCheck.reasons);
    }
  }

  return {
    pass: reasons.length === 0,
    gate: 'G6',
    name: 'Render integrity',
    reasons,
    details,
  };
}

/**
 * Evaluate all verification gates G1-G6 in sequence and return unified summary.
 */
export function evaluateAllGates(input = {}) {
  const {
    probe,
    expectedTargetHash,
    controlResult,
    exploitResult,
    expectedPaths,
    mode = 'data-plane',
    expectResult,
    stateDiff,
    fix,
    fixEnabled,
    fixControlResult,
    fixExploitResult,
    fixStateDiff,
    ...g6Options
  } = input;

  const resolvedControl = controlResult ?? probe?.control;
  const resolvedStateDiff = stateDiff ?? probe?.stateDiff;
  const baseExploit = exploitResult ?? probe?.mutation;
  const resolvedExploit =
    isPlainObject(baseExploit) && !baseExploit.changedPaths && resolvedStateDiff?.changedPaths
      ? { ...baseExploit, changedPaths: resolvedStateDiff.changedPaths }
      : baseExploit;

  const resolvedExpectedPaths =
    expectedPaths !== undefined
      ? expectedPaths
      : probe?.mutationSpec?.operation?.path
        ? [probe.mutationSpec.operation.path]
        : [];

  const g5Enabled =
    fixEnabled !== undefined
      ? Boolean(fixEnabled)
      : fix?.enabled !== undefined
        ? Boolean(fix.enabled)
        : Boolean(fixExploitResult || fix?.exploitResult);

  const g1 = evaluateGateG1(probe, { expectedTargetHash });
  const g2 = evaluateGateG2(resolvedControl);
  const g3 = evaluateGateG3(resolvedExploit, resolvedExpectedPaths);
  const g4 = evaluateGateG4({ mode, expectResult, stateDiff: resolvedStateDiff });
  const g5 = evaluateGateG5({
    enabled: g5Enabled,
    fixControlResult: fixControlResult ?? fix?.controlResult,
    fixExploitResult: fixExploitResult ?? fix?.exploitResult,
    fixStateDiff: fixStateDiff ?? fix?.stateDiff,
  });
  const g6 = evaluateGateG6(g6Options);

  const ordered = [g1, g2, g3, g4, g5, g6];
  const firstFailed = ordered.find((g) => !g.pass) ?? null;
  const pass = firstFailed === null;
  const reasons = ordered.flatMap((g) => g.reasons);

  return {
    pass,
    status: pass ? 'reproduced' : 'not-reproduced',
    failedGate: firstFailed ? firstFailed.gate : null,
    reasons,
    gates: {
      G1: g1,
      G2: g2,
      G3: g3,
      G4: g4,
      G5: g5,
      G6: g6,
    },
    summary: {
      g1: g1.pass,
      g2: g2.pass,
      g3: g3.pass,
      g4: g4.pass,
      g5: g5.skipped ? 'skipped' : g5.pass,
      g6: g6.pass,
    },
  };
}

/**
 * Remove any stale video.mp4 or preview.gif in outDir and write a validated
 * `not-reproduced` bundle manifest so failed gates never emit a video.
 */
export function writeFailureBundle({
  outDir,
  finding,
  failedGate,
  reasons,
  provenanceText = '',
  tracePath,
  gates,
} = {}) {
  if (typeof outDir !== 'string' || outDir.trim().length === 0) {
    throw new Error('writeFailureBundle requires a non-empty outDir');
  }

  fs.mkdirSync(outDir, { recursive: true });

  for (const staleFile of ['video.mp4', 'preview.gif']) {
    const candidate = path.join(outDir, staleFile);
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { force: true });
    }
  }

  const normalizedGate = typeof failedGate === 'string' ? failedGate.toUpperCase() : null;
  const gateOrder = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
  const failedIndex = normalizedGate ? gateOrder.indexOf(normalizedGate) : -1;

  const resolvedGates = isPlainObject(gates)
    ? gates
    : Object.fromEntries(
        gateOrder.map((g, idx) => [
          g.toLowerCase(),
          failedIndex === -1 ? false : idx < failedIndex,
        ]),
      );

  const normalizedReasons = Array.isArray(reasons)
    ? reasons.map((r) => String(r))
    : reasons
      ? [String(reasons)]
      : [];

  const manifest = {
    schema: BUNDLE_SCHEMA,
    status: 'not-reproduced',
    finding: isPlainObject(finding) ? finding : { campaign: 'unknown', probe: 'unknown' },
    failedGate: normalizedGate,
    reasons: normalizedReasons,
    gates: resolvedGates,
    provenanceText: typeof provenanceText === 'string' ? provenanceText : '',
    ...(typeof tracePath === 'string' && tracePath.trim().length > 0
      ? { artifacts: { trace: tracePath } }
      : {}),
    generatedAt: new Date().toISOString(),
  };

  validateBundleManifest(manifest);

  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return manifest;
}
