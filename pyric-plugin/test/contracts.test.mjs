import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCENARIO_SCHEMA,
  RAW_CAPTURE_SCHEMA,
  STAGE_PAYLOAD_SCHEMA,
  BUNDLE_SCHEMA,
  DEFAULT_STAGE_THEME,
  DEFAULT_STAGE_SLOTS,
  ContractValidationError,
  parseSizeString,
  validateScenario,
  validateRawCapture,
  buildLockedProvenanceText,
  buildStagePayload,
  validateBundleManifest,
} from '../skills/improve-firebase/scripts/lib/contracts.mjs';
import {
  getVideoRuntimeDir,
  findProjectPlaywright,
  resolveChromiumExecutable,
  probeSystemTools,
} from '../skills/improve-firebase/scripts/lib/runtime.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');

test('parseSizeString accepts valid even dimensions and rejects invalid inputs', () => {
  assert.deepEqual(parseSizeString('1920x1080'), { width: 1920, height: 1080 });
  assert.deepEqual(parseSizeString('1080x1080'), { width: 1080, height: 1080 });
  assert.throws(() => parseSizeString('1921x1080'), ContractValidationError);
  assert.throws(() => parseSizeString('100x100'), ContractValidationError);
  assert.throws(() => parseSizeString('invalid'), ContractValidationError);
});

test('validateScenario applies defaults for stage layout, theme tokens, and slots', () => {
  const normalized = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: {
      campaign: 'camp-orbit-rtdb-01',
      probe: 'probe-rtdb-cross-tenant-write-01',
    },
    app: {
      dist: './examples/teams-workspace/dist',
    },
    actors: {
      victim: { uid: 'alice', name: 'Alice' },
      attacker: { uid: 'mallory', name: 'Mallory' },
    },
    copy: {
      title: 'Cross-tenant RTDB message overwrite',
      exploit: 'Mallory overwrites Alice message in real time',
      why: 'Missing authorUid check on /channels/$channel/messages/$msgId',
    },
    stage: {
      theme: { accent: '#f97316' },
      slots: { captionStyle: 'bar' },
    },
  });

  assert.equal(normalized.template, 'tamper');
  assert.equal(normalized.stage.layout, 'split-actors');
  assert.equal(normalized.stage.aspect, '16:9');
  assert.deepEqual(normalized.stage.dimensions, { width: 1920, height: 1080 });
  assert.equal(normalized.stage.theme.accent, '#f97316');
  assert.equal(normalized.stage.theme.surface, DEFAULT_STAGE_THEME.surface);
  assert.equal(normalized.stage.slots.captionStyle, 'bar');
  assert.equal(normalized.stage.slots.highlights, DEFAULT_STAGE_SLOTS.highlights);
});

test('validateScenario defaults layout to data-plane when no app is provided and rejects malformed specs', () => {
  const dataPlane = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-1', probe: 'probe-1' },
    actors: { victim: { uid: 'alice', name: 'Alice' } },
    copy: {
      title: 'Unauthenticated read',
      exploit: 'Reads /secrets without token',
      why: '.read is true',
    },
  });
  assert.equal(dataPlane.stage.layout, 'data-plane');

  assert.throws(
    () =>
      validateScenario({
        schema: 'wrong.schema',
        finding: {},
      }),
    ContractValidationError,
  );
});

test('validateRawCapture validates both continuous video and CDP frame captures', () => {
  const videoCapture = validateRawCapture({
    schema: RAW_CAPTURE_SCHEMA,
    backend: 'x11-xvfb',
    platform: 'linux',
    actorRoles: ['victim', 'attacker'],
    durationMs: 4200,
    mode: 'video',
    videoPath: '/tmp/exploit.mp4',
    fps: 30,
    cropRects: {
      victim: { x: 20, y: 20, width: 1800, height: 1350 },
      attacker: { x: 1860, y: 20, width: 1800, height: 1350 },
    },
    packetTimestampsMs: [0, 33.3, 66.7],
  });
  assert.equal(videoCapture.mode, 'video');

  const frameCapture = validateRawCapture({
    schema: RAW_CAPTURE_SCHEMA,
    backend: 'cdp-surface',
    platform: 'darwin',
    actorRoles: ['victim', 'attacker'],
    durationMs: 3000,
    mode: 'frames',
    frames: [
      { tMs: 0, files: { victim: '/tmp/v0.png', attacker: '/tmp/a0.png' } },
      { tMs: 60, files: { victim: '/tmp/v1.png', attacker: '/tmp/a1.png' } },
    ],
  });
  assert.equal(frameCapture.mode, 'frames');

  assert.throws(
    () =>
      validateRawCapture({
        schema: RAW_CAPTURE_SCHEMA,
        backend: 'cdp-surface',
        platform: 'darwin',
        actorRoles: ['victim'],
        durationMs: 1000,
        mode: 'frames',
        frames: [
          { tMs: 100, files: { victim: '/tmp/v1.png' } },
          { tMs: 50, files: { victim: '/tmp/v0.png' } },
        ],
      }),
    ContractValidationError,
  );
});

test('buildLockedProvenanceText, buildStagePayload, and validateBundleManifest enforce contract', () => {
  const provenanceText = buildLockedProvenanceText({
    decision: 'ALLOW',
    fixedDecision: 'DENY',
    service: 'database',
    method: 'set',
    path: '/channels/general/messages/msg_alice_1',
    actorLabel: 'mallory',
  });
  assert.equal(
    provenanceText,
    'ALLOW → DENY / database.set /channels/general/messages/msg_alice_1 / as mallory / Local Pyric sandbox',
  );

  const scenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-1', probe: 'probe-1' },
    actors: { victim: { uid: 'alice', name: 'Alice' } },
    copy: { title: 'T', exploit: 'E', why: 'W' },
  });
  const payload = buildStagePayload({
    scenario,
    fps: 30,
    beats: [{ id: 'hook', startSec: 0, endSec: 2, caption: 'Hook' }],
    passes: { exploit: { victim: ['/tmp/f0.png'] } },
    evidence: { before: {}, after: {} },
    provenanceText,
  });
  assert.equal(payload.schema, STAGE_PAYLOAD_SCHEMA);

  const manifest = validateBundleManifest({
    schema: BUNDLE_SCHEMA,
    status: 'reproduced',
    finding: { campaign: 'camp-1', probe: 'probe-1' },
    gates: { g1: true, g2: true, g3: true, g4: true, g5: true, g6: true },
    provenanceText,
    artifacts: {
      poster: 'poster.png',
      exploitMp4: 'video.mp4',
    },
  });
  assert.equal(manifest.status, 'reproduced');
});

test('runtime helpers locate monorepo Playwright, Chromium binary, and system tools', () => {
  const overrideDir = getVideoRuntimeDir({ PYRIC_VIDEO_RUNTIME_DIR: '/tmp/custom-pyric-rt' });
  assert.equal(overrideDir, '/tmp/custom-pyric-rt');

  const located = findProjectPlaywright(REPO_ROOT);
  assert.ok(located, 'expected findProjectPlaywright to locate @playwright/test in monorepo');

  const chrome = resolveChromiumExecutable(null);
  assert.ok(chrome && fs.existsSync(chrome), `expected Chromium executable, got ${chrome}`);

  const tools = probeSystemTools();
  assert.ok(tools.ffmpegPath, 'expected ffmpeg on PATH');
  assert.ok(tools.ffprobePath, 'expected ffprobe on PATH');
  if (process.platform === 'linux') {
    assert.ok(tools.xvfbPath, 'expected Xvfb on PATH on Linux');
  }
});
