import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  SCENARIO_SCHEMA,
  RAW_CAPTURE_SCHEMA,
  BUNDLE_SCHEMA,
  validateScenario,
  buildLockedProvenanceText,
  buildStagePayload,
  validateBundleManifest,
} from '../../skills/improve-firebase/scripts/lib/contracts.mjs';
import { loadPlaywright, probeSystemTools, resolveChromiumExecutable } from '../../skills/improve-firebase/scripts/lib/runtime.mjs';
import {
  sampleFrameAtTime,
  computeStageTimeline,
  buildResampledPassFrames,
  mapPresentationTimeToSourceMs,
} from '../../skills/improve-firebase/scripts/lib/render-timeline.mjs';
import {
  extractActorFramesFromVideo,
  createH264PipeEncoder,
  transcodePreviewGif,
  probeMedia,
} from '../../skills/improve-firebase/scripts/lib/ffmpeg.mjs';
import {
  renderEvidenceBundle,
  EvidenceRenderError,
} from '../../skills/improve-firebase/scripts/render.mjs';
import { executeStep } from '../../skills/improve-firebase/scripts/lib/steps.mjs';
import {
  parseJsonWithComments,
  formatRuleExpressionSummary,
  extractFocusedRuleSnippet,
} from '../../skills/improve-firebase/scripts/lib/op-snippet.mjs';
import {
  ensureActorPageHydrated,
  withOffOriginNavigationGuard,
} from '../../skills/improve-firebase/scripts/lib/identity.mjs';

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = path.resolve(TEST_DIR, '../../skills/improve-firebase/scripts/render.mjs');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Pure-Node synthetic 24-bit RGB PNG generator with distinct per-frame stripes and colors.
 */
function generateSyntheticPng(width, height, frameSeed = 0) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = 1 + width * 3;
  const raw = Buffer.alloc(rowStride * height);

  const bgR = (24 + frameSeed * 37) % 180;
  const bgG = (42 + frameSeed * 61) % 180;
  const bgB = (68 + frameSeed * 89) % 180;

  const stripe1R = (220 - frameSeed * 29 + 256) % 256;
  const stripe1G = (180 + frameSeed * 43) % 256;
  const stripe1B = (90 + frameSeed * 53) % 256;

  const stripe2R = (80 + frameSeed * 47) % 256;
  const stripe2G = (210 - frameSeed * 31 + 256) % 256;
  const stripe2B = (230 - frameSeed * 19 + 256) % 256;

  const band1Top = Math.floor(height * 0.15);
  const band1Bottom = Math.floor(height * 0.42);
  const band2Top = Math.floor(height * 0.58);
  const band2Bottom = Math.floor(height * 0.85);
  const progressWidth = Math.max(40, Math.min(width - 40, Math.floor(((frameSeed + 1) / 8) * width)));

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowStride;
    raw[rowStart] = 0; // filter type 0
    const inBand1 = y >= band1Top && y < band1Bottom;
    const inBand2 = y >= band2Top && y < band2Bottom;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      if (inBand1 && x < progressWidth) {
        raw[px] = stripe1R;
        raw[px + 1] = stripe1G;
        raw[px + 2] = stripe1B;
      } else if (inBand2 && x < progressWidth) {
        raw[px] = stripe2R;
        raw[px + 1] = stripe2G;
        raw[px + 2] = stripe2B;
      } else {
        raw[px] = bgR;
        raw[px + 1] = bgG;
        raw[px + 2] = bgB;
      }
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function getPngChannels(colorType) {
  if (colorType === 6) return 4; // RGBA
  if (colorType === 2) return 3; // RGB
  if (colorType === 4) return 2; // Grayscale + Alpha
  return 1;
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

function decodePngPixels(inflated, width, height, channels) {
  const bpp = channels;
  const rowBytes = width * channels;
  const srcStride = 1 + rowBytes;
  const pixels = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y++) {
    const srcRow = y * srcStride;
    const dstRow = y * rowBytes;
    const filterType = inflated[srcRow];

    for (let i = 0; i < rowBytes; i++) {
      const x = inflated[srcRow + 1 + i];
      const a = i >= bpp ? pixels[dstRow + i - bpp] : 0;
      const b = y > 0 ? pixels[dstRow - rowBytes + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[dstRow - rowBytes + i - bpp] : 0;

      if (filterType === 0) {
        pixels[dstRow + i] = x;
      } else if (filterType === 1) {
        pixels[dstRow + i] = (x + a) & 0xff;
      } else if (filterType === 2) {
        pixels[dstRow + i] = (x + b) & 0xff;
      } else if (filterType === 3) {
        pixels[dstRow + i] = (x + ((a + b) >>> 1)) & 0xff;
      } else if (filterType === 4) {
        pixels[dstRow + i] = (x + paethPredictor(a, b, c)) & 0xff;
      } else {
        pixels[dstRow + i] = x;
      }
    }
  }
  return pixels;
}

function assertNonBlankPng(pngPath, expectedWidth, expectedHeight) {
  assert.ok(fs.existsSync(pngPath), `Expected PNG to exist: ${pngPath}`);
  const buf = fs.readFileSync(pngPath);
  assert.ok(buf.length > 1024, `Expected non-trivial PNG size, got ${buf.length} bytes`);
  assert.deepEqual(
    buf.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    'Expected valid PNG signature',
  );

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf[25];
  assert.equal(width, expectedWidth, `Expected PNG width ${expectedWidth}, got ${width}`);
  assert.equal(height, expectedHeight, `Expected PNG height ${expectedHeight}, got ${height}`);

  const idatChunks = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') {
      idatChunks.push(buf.subarray(offset + 8, offset + 8 + len));
    }
    offset += 12 + len;
  }
  assert.ok(idatChunks.length > 0, 'Expected at least one IDAT chunk');
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));

  const channels = getPngChannels(colorType);
  const pixels = decodePngPixels(inflated, width, height, channels);
  const rowBytes = width * channels;
  const distinctSamples = new Set();

  for (let gy = 0; gy < 32; gy++) {
    const y = Math.floor(((gy + 0.5) * height) / 32);
    const rowStart = y * rowBytes;
    for (let gx = 0; gx < 32; gx++) {
      const x = Math.floor(((gx + 0.5) * width) / 32);
      const px = rowStart + x * channels;
      if (px + 2 < pixels.length) {
        distinctSamples.add(`${pixels[px]},${pixels[px + 1]},${pixels[px + 2]}`);
      }
    }
  }

  assert.ok(
    distinctSamples.size >= 3,
    `Expected non-blank rendered PNG with >= 3 distinct colors, got ${distinctSamples.size}`,
  );
}

function createTempRenderDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-render-test-'));
}

function makeBaseScenario(overrides = {}) {
  return validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: {
      campaign: 'camp-orbit-rtdb-01',
      probe: 'probe-rtdb-cross-tenant-write-01',
    },
    app: {
      dist: './dist',
    },
    actors: {
      owner: { uid: 'alice', name: 'Alice', view: '/channels/general' },
      peer: { uid: 'mallory', name: 'Mallory', view: '/channels/general' },
    },
    copy: {
      title: 'Cross-tenant RTDB message overwrite',
      baseline: 'Alice posts an approved vendor invoice message',
      summary: 'Mallory overwrites Alice message via direct RTDB .set()',
      fixed: 'Patched rule blocks writes unless auth.uid matches authorUid',
      why: 'Missing authorUid ownership check on /channels/$channel/messages/$msgId',
      severity: 'HIGH',
    },
    fixRules: {
      before: '".write": "auth != null"',
      after: '".write": "auth != null && auth.uid == data.child(\'authorUid\').val()"',
    },
    ...overrides,
  });
}

test('sampleFrameAtTime binary-searches sorted frames and clamps out-of-range timestamps', () => {
  const frames = [
    { tMs: 100, files: { owner: 'f0.png' } },
    { tMs: 250, files: { owner: 'f1.png' } },
    { tMs: 600, files: { owner: 'f2.png' } },
    { tMs: 600, files: { owner: 'f2-dup.png' } },
    { tMs: 1100, files: { owner: 'f3.png' } },
  ];

  assert.equal(sampleFrameAtTime(frames, 0).files.owner, 'f0.png');
  assert.equal(sampleFrameAtTime(frames, 100).files.owner, 'f0.png');
  assert.equal(sampleFrameAtTime(frames, 249).files.owner, 'f0.png');
  assert.equal(sampleFrameAtTime(frames, 250).files.owner, 'f1.png');
  assert.equal(sampleFrameAtTime(frames, 599).files.owner, 'f1.png');
  assert.equal(sampleFrameAtTime(frames, 600).files.owner, 'f2-dup.png');
  assert.equal(sampleFrameAtTime(frames, 900).files.owner, 'f2-dup.png');
  assert.equal(sampleFrameAtTime(frames, 1100).files.owner, 'f3.png');
  assert.equal(sampleFrameAtTime(frames, 5000).files.owner, 'f3.png');
});

test('computeStageTimeline builds deterministic beats, respects showTitleCard=false, and enforces >= 2.5s duration', () => {
  const scenarioWithHook = makeBaseScenario();
  const events = [
    {
      tMs: 900,
      phase: 'repro',
      service: 'database',
      method: 'set',
      path: '/channels/general/messages/msg_alice_1',
      data: { authorUid: 'alice', text: 'Wire $25,000 today' },
      decision: 'ALLOW',
      matchedRule: '".write": "auth != null"',
    },
    {
      tMs: 2100,
      phase: 'fix',
      service: 'database',
      method: 'set',
      path: '/channels/general/messages/msg_alice_1',
      decision: 'DENY',
      matchedRule: '".write": "auth != null && auth.uid == data.child(\'authorUid\').val()"',
    },
  ];

  const tl1 = computeStageTimeline({ scenario: scenarioWithHook, events, durationMs: 2600 });
  const tl2 = computeStageTimeline({ scenario: scenarioWithHook, events, durationMs: 2600 });
  assert.deepEqual(tl1, tl2, 'Timeline computation must be deterministic');
  assert.ok(tl1.totalSec >= 2.5, `Expected totalSec >= 2.5, got ${tl1.totalSec}`);
  assert.equal(tl1.beats[0].id, 'hook');
  assert.equal(tl1.beats[0].phase, 'hook');
  assert.equal(tl1.beats[0].badgeText, 'BASELINE ALLOW');
  assert.equal(tl1.beats[0].badgeTone, 'neutral');
  assert.equal(tl1.beats[0].startSec, 0);

  const reproBeat = tl1.beats.find((b) => b.id === 'repro');
  assert.ok(reproBeat);
  assert.equal(reproBeat.phase, 'repro');
  assert.equal(reproBeat.badgeText, 'REPRO ALLOWED');
  assert.equal(reproBeat.badgeTone, 'danger');
  assert.ok(reproBeat.sdkCall.includes('database.set'));

  const fixBeat = tl1.beats.find((b) => b.id === 'fix');
  assert.ok(fixBeat);
  assert.equal(fixBeat.phase, 'fix');
  assert.equal(fixBeat.badgeText, 'FIX DENIED');
  assert.equal(fixBeat.badgeTone, 'success');

  for (let i = 0; i < tl1.beats.length - 1; i++) {
    assert.equal(tl1.beats[i].endMs, tl1.beats[i + 1].startMs);
    assert.equal(tl1.beats[i].endSec, tl1.beats[i + 1].startSec);
  }
  assert.equal(tl1.beats[tl1.beats.length - 1].endSec, tl1.totalSec);

  const scenarioNoHook = makeBaseScenario({
    stage: {
      slots: { showTitleCard: false, showOutroCard: false },
    },
  });
  const tlNoHook = computeStageTimeline({ scenario: scenarioNoHook, events: [], durationMs: 1000 });
  assert.ok(tlNoHook.totalSec >= 2.5, 'Short capture still enforces >= 2.5s totalSec');
  assert.equal(tlNoHook.beats[0].id, 'repro');
  assert.equal(tlNoHook.beats[0].phase, 'repro');
  assert.equal(tlNoHook.beats[0].startSec, 0);
  assert.equal(tlNoHook.beats[0].startMs, 0);
});

test('buildResampledPassFrames resamples variable-rate CDP frames onto exact CFR grid', () => {
  const captureArtifact = {
    schema: RAW_CAPTURE_SCHEMA,
    backend: 'cdp-surface',
    platform: 'linux',
    actorRoles: ['owner', 'peer'],
    durationMs: 1000,
    mode: 'frames',
    frames: [
      { tMs: 0, files: { owner: '/tmp/work/raw/v0.png', peer: '/tmp/work/raw/a0.png' } },
      { tMs: 500, files: { owner: '/tmp/work/raw/v1.png', peer: '/tmp/work/raw/a1.png' } },
    ],
  };

  const resampled = buildResampledPassFrames({
    captureArtifact,
    durationMs: 1000,
    fps: 30,
    baseDir: '/tmp/work',
  });

  assert.equal(resampled.totalFrames, 30);
  assert.equal(resampled.frames.length, 30);
  assert.equal(resampled.owner.length, 30);
  assert.equal(resampled.peer.length, 30);
  assert.equal(resampled.frames[0].files.owner, '/raw/v0.png');
  assert.equal(resampled.frames[14].files.owner, '/raw/v0.png');
  assert.equal(resampled.frames[15].files.owner, '/raw/v1.png');
  assert.equal(resampled.frames[29].files.peer, '/raw/a1.png');
});

test('ffmpeg helpers encode pipe frames, transcode preview GIF, extract 2x crops, and probe media', async (t) => {
  const tmpDir = createTempRenderDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const tools = probeSystemTools();
  assert.ok(tools.ffmpegPath, 'ffmpeg must be available');
  assert.ok(tools.ffprobePath, 'ffprobe must be available');

  const outMp4 = path.join(tmpDir, 'pipe-test.mp4');
  const encoder = createH264PipeEncoder({
    ffmpegPath: tools.ffmpegPath,
    width: 640,
    height: 480,
    fps: 10,
    outMp4Path: outMp4,
  });

  for (let i = 0; i < 6; i++) {
    await encoder.writeFrame(generateSyntheticPng(640, 480, i));
  }
  await encoder.finish();

  const mp4Probe = await probeMedia({ ffprobePath: tools.ffprobePath, mediaPath: outMp4 });
  assert.equal(mp4Probe.width, 640);
  assert.equal(mp4Probe.height, 480);
  assert.equal(mp4Probe.nbFrames, 6);
  assert.equal(mp4Probe.codecName, 'h264');

  const outGif = path.join(tmpDir, 'preview.gif');
  await transcodePreviewGif({
    ffmpegPath: tools.ffmpegPath,
    inputMp4Path: outMp4,
    outGifPath: outGif,
    fps: 6,
    width: 320,
    maxSeconds: 2,
  });
  assert.ok(fs.existsSync(outGif) && fs.statSync(outGif).size > 500);

  const extractedDir = path.join(tmpDir, 'extracted');
  const extracted = await extractActorFramesFromVideo({
    ffmpegPath: tools.ffmpegPath,
    videoPath: outMp4,
    cropRects: {
      owner: { x: 0, y: 0, width: 320, height: 240 },
      peer: { x: 320, y: 240, width: 320, height: 240 },
    },
    outputDir: extractedDir,
    fps: 10,
    packetTimestampsMs: [0, 100, 200, 300, 400, 500],
  });

  assert.equal(extracted.frames.length, 6);
  assertNonBlankPng(extracted.frames[0].files.owner, 1800, 1350);
  assertNonBlankPng(extracted.frames[5].files.peer, 1800, 1350);
});

test('renderEvidenceBundle renders split-actors at 1920x1080 with 2x synthetic PNGs, mp4, gif, storyboard, poster, share.md, and manifest.json', async (t) => {
  const tmpDir = createTempRenderDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const rawDir = path.join(tmpDir, 'raw', 'frames');
  fs.mkdirSync(path.join(rawDir, 'owner'), { recursive: true });
  fs.mkdirSync(path.join(rawDir, 'peer'), { recursive: true });

  const captureFrames = [];
  for (let i = 0; i < 6; i++) {
    const vFile = path.join(rawDir, 'owner', `frame-${String(i).padStart(4, '0')}.png`);
    const aFile = path.join(rawDir, 'peer', `frame-${String(i).padStart(4, '0')}.png`);
    fs.writeFileSync(vFile, generateSyntheticPng(1800, 1350, i));
    fs.writeFileSync(aFile, generateSyntheticPng(1800, 1350, i + 10));
    captureFrames.push({
      tMs: i * 420,
      files: {
        owner: `raw/frames/owner/frame-${String(i).padStart(4, '0')}.png`,
        peer: `raw/frames/peer/frame-${String(i).padStart(4, '0')}.png`,
      },
    });
  }

  const scenario = makeBaseScenario({
    stage: {
      layout: 'split-actors',
      aspect: '16:9',
      theme: { accent: '#f97316' },
      slots: { captionStyle: 'pill', highlights: true },
    },
  });
  fs.writeFileSync(path.join(tmpDir, 'scenario.json'), JSON.stringify(scenario, null, 2));

  const capture = {
    schema: RAW_CAPTURE_SCHEMA,
    backend: 'cdp-surface',
    platform: process.platform,
    actorRoles: ['owner', 'peer'],
    durationMs: 2200,
    mode: 'frames',
    frames: captureFrames,
  };
  fs.writeFileSync(path.join(tmpDir, 'raw', 'capture.json'), JSON.stringify(capture, null, 2));

  const events = [
    {
      tMs: 850,
      phase: 'repro',
      actorLabel: 'mallory',
      service: 'database',
      method: 'set',
      path: '/channels/general/messages/msg_alice_1',
      data: { authorUid: 'alice', text: 'Wire $25,000 today' },
      decision: 'ALLOW',
      matchedRule: '".write": "auth != null"',
    },
    {
      tMs: 1850,
      phase: 'fix',
      service: 'database',
      method: 'set',
      path: '/channels/general/messages/msg_alice_1',
      decision: 'DENY',
      matchedRule: '".write": "auth != null && auth.uid == data.child(\'authorUid\').val()"',
    },
  ];
  fs.writeFileSync(path.join(tmpDir, 'events.json'), JSON.stringify(events, null, 2));

  const result = await renderEvidenceBundle({
    evidenceDir: tmpDir,
    formats: ['mp4', 'gif'],
    fps: 30,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dimensions.width, 1920);
  assert.equal(result.dimensions.height, 1080);

  const tools = probeSystemTools();
  const videoPath = path.join(tmpDir, 'video.mp4');
  const gifPath = path.join(tmpDir, 'preview.gif');
  const posterPath = path.join(tmpDir, 'poster.png');
  const sharePath = path.join(tmpDir, 'share.md');
  const manifestPath = path.join(tmpDir, 'manifest.json');

  assert.ok(fs.existsSync(videoPath), 'video.mp4 should be generated');
  assert.ok(fs.existsSync(gifPath), 'preview.gif should be generated');
  assert.ok(fs.existsSync(posterPath), 'poster.png should be generated');
  assert.ok(fs.existsSync(sharePath), 'share.md should be generated');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json should be generated');

  const probed = await probeMedia({ ffprobePath: tools.ffprobePath, mediaPath: videoPath });
  assert.equal(probed.width, 1920);
  assert.equal(probed.height, 1080);
  assert.equal(probed.nbFrames, result.totalFrames);
  assert.equal(probed.codecName, 'h264');

  assertNonBlankPng(posterPath, 1920, 1080);
  assert.ok(result.artifacts.storyboard.length >= 3, 'Expected storyboard keyframes for all beats');
  for (const relKeyframe of result.artifacts.storyboard) {
    assertNonBlankPng(path.join(tmpDir, relKeyframe), 1920, 1080);
  }

  // Verify storyboard frames visually change between hook and repro beats
  const beat1Bytes = fs.readFileSync(path.join(tmpDir, result.artifacts.storyboard[0]));
  const beat2Bytes = fs.readFileSync(path.join(tmpDir, result.artifacts.storyboard[1]));
  assert.notEqual(Buffer.compare(beat1Bytes, beat2Bytes), 0, 'Storyboard beats must render distinct frames');

  const expectedProvenance = buildLockedProvenanceText({
    decision: 'ALLOW',
    fixedDecision: 'DENY',
    service: 'database',
    method: 'set',
    path: '/channels/general/messages/msg_alice_1',
    actorLabel: 'mallory',
  });
  const manifest = validateBundleManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  assert.equal(manifest.schema, BUNDLE_SCHEMA);
  assert.equal(manifest.status, 'reproduced');
  assert.equal(manifest.gates.g6, true);
  assert.equal(manifest.provenanceText, expectedProvenance);
  assert.equal(manifest.artifacts.reproMp4, 'video.mp4');
  assert.equal(manifest.artifacts.previewGif, 'preview.gif');
  assert.equal(manifest.artifacts.poster, 'poster.png');

  const shareText = fs.readFileSync(sharePath, 'utf8');
  assert.ok(shareText.includes(expectedProvenance), 'share.md must include locked provenance text');
  assert.ok(shareText.includes('Cross-tenant RTDB message overwrite'));
});

test('renderEvidenceBundle renders data-plane at 1920x1080 without capture frames and single-hero at 1080x1920', async (t) => {
  const tmpDir = createTempRenderDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const scenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: {
      campaign: 'camp-dataplane-01',
      probe: 'probe-rtdb-unauth-read-01',
    },
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'anon', name: 'Unauthenticated Client' },
    },
    copy: {
      title: 'Public RTDB secret exposure',
      summary: 'Anonymous client reads /secrets/apiKeys directly',
      fixed: 'Rule updated to require auth != null',
      why: '.read was set to true on /secrets',
      severity: 'CRITICAL',
    },
    stage: {
      layout: 'data-plane',
    },
    fixRules: {
      before: '".read": true',
      after: '".read": "auth != null"',
    },
  });
  fs.writeFileSync(path.join(tmpDir, 'scenario.json'), JSON.stringify(scenario, null, 2));

  const result = await renderEvidenceBundle({
    evidenceDir: tmpDir,
    formats: ['mp4'],
    fps: 15,
  });

  assert.equal(result.ok, true);
  const tools = probeSystemTools();
  const probed = await probeMedia({
    ffprobePath: tools.ffprobePath,
    mediaPath: path.join(tmpDir, 'video.mp4'),
  });
  assert.equal(probed.width, 1920);
  assert.equal(probed.height, 1080);
  assert.equal(probed.nbFrames, result.totalFrames);
  assertNonBlankPng(path.join(tmpDir, 'poster.png'), 1920, 1080);
  assert.equal(fs.existsSync(path.join(tmpDir, 'preview.gif')), false);

  // Also verify single-hero portrait (1080x1920)
  const heroDir = createTempRenderDir();
  t.after(() => fs.rmSync(heroDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(heroDir, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(heroDir, 'raw', 'v0.png'), generateSyntheticPng(1800, 1350, 1));
  fs.writeFileSync(path.join(heroDir, 'raw', 'v1.png'), generateSyntheticPng(1800, 1350, 5));
  fs.writeFileSync(
    path.join(heroDir, 'scenario.json'),
    JSON.stringify(
      makeBaseScenario({
        stage: { layout: 'single-hero', aspect: '9:16' },
      }),
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(heroDir, 'raw', 'capture.json'),
    JSON.stringify(
      {
        schema: RAW_CAPTURE_SCHEMA,
        backend: 'cdp-surface',
        platform: process.platform,
        actorRoles: ['owner'],
        durationMs: 2000,
        mode: 'frames',
        frames: [
          { tMs: 0, files: { owner: 'raw/v0.png' } },
          { tMs: 1000, files: { owner: 'raw/v1.png' } },
        ],
      },
      null,
      2,
    ),
  );

  const heroResult = await renderEvidenceBundle({
    evidenceDir: heroDir,
    formats: ['mp4'],
    fps: 15,
  });
  assert.equal(heroResult.dimensions.width, 1080);
  assert.equal(heroResult.dimensions.height, 1920);
  assertNonBlankPng(path.join(heroDir, 'poster.png'), 1080, 1920);
});

test('render.mjs CLI supports custom --stage at 1080x1080 square format, enforces provenance, and rejects unverified findings', async (t) => {
  const tmpDir = createTempRenderDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const scenario = makeBaseScenario({
    stage: {
      layout: 'data-plane',
      slots: { showTitleCard: false },
    },
  });
  fs.writeFileSync(path.join(tmpDir, 'scenario.json'), JSON.stringify(scenario, null, 2));

  const customStagePath = path.join(tmpDir, 'custom.html');
  fs.writeFileSync(
    customStagePath,
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0;
      width: 100vw;
      height: 100vh;
      background: linear-gradient(135deg, #0b0d10 0%, #172554 50%, #0f172a 100%);
      color: #f8fafc;
      font-family: sans-serif;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 24px;
      padding: 32px;
      box-sizing: border-box;
    }
    #stage-box {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(56, 189, 248, 0.14);
      border: 6px solid #38bdf8;
      border-radius: 16px;
      font-size: 36px;
      font-weight: 700;
    }
    footer {
      padding: 14px 18px;
      background: #1e293b;
      border: 2px solid #475569;
      border-radius: 8px;
      font-family: monospace;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div id="stage-box">Custom Stage</div>
  <footer data-pyric-provenance></footer>
  <script>
    window.__initPyricStage = function (p) {
      document.querySelector('[data-pyric-provenance]').textContent = p.provenanceText;
    };
    window.setFrame = async function (tSec, idx) {
      if (window.__PYRIC_EVIDENCE__ && !document.querySelector('[data-pyric-provenance]').textContent) {
        window.__initPyricStage(window.__PYRIC_EVIDENCE__);
      }
      const box = document.getElementById('stage-box');
      box.textContent = 'Frame ' + idx + ' @ ' + tSec.toFixed(2) + 's';
      box.style.borderColor = idx % 2 === 0 ? '#d92d20' : '#079455';
    };
    if (window.__PYRIC_EVIDENCE__) window.__initPyricStage(window.__PYRIC_EVIDENCE__);
  </script>
</body>
</html>`,
    'utf8',
  );

  const customOutMp4 = path.join(tmpDir, 'square-pr.mp4');
  const { stdout } = await execFileAsync(process.execPath, [
    RENDER_SCRIPT,
    tmpDir,
    '--stage',
    customStagePath,
    '--size',
    '1080x1080',
    '--formats',
    'mp4',
    '--fps',
    '30',
    '--out',
    customOutMp4,
    '--json',
  ]);

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dimensions.width, 1080);
  assert.equal(parsed.dimensions.height, 1080);

  const tools = probeSystemTools();
  const probed = await probeMedia({ ffprobePath: tools.ffprobePath, mediaPath: customOutMp4 });
  assert.equal(probed.width, 1080);
  assert.equal(probed.height, 1080);
  assert.equal(probed.nbFrames, parsed.totalFrames);
  assertNonBlankPng(path.join(tmpDir, 'poster.png'), 1080, 1080);

  // Verify custom stage without [data-pyric-provenance] is rejected
  const badStagePath = path.join(tmpDir, 'no-provenance.html');
  fs.writeFileSync(
    badStagePath,
    `<!DOCTYPE html><html><body><div>No provenance</div><script>window.setFrame = async () => {};</script></body></html>`,
    'utf8',
  );
  await assert.rejects(
    () => renderEvidenceBundle({ evidenceDir: tmpDir, stagePath: badStagePath, formats: ['mp4'], fps: 10 }),
    (err) => err instanceof EvidenceRenderError && err.code === 'PROVENANCE_MISSING_OR_HIDDEN',
  );

  // Verify manifest.json with status === 'not-reproduced' refuses to render with UNVERIFIED_FINDING
  const unverifiedDir = createTempRenderDir();
  t.after(() => fs.rmSync(unverifiedDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(unverifiedDir, 'scenario.json'), JSON.stringify(scenario, null, 2));
  fs.writeFileSync(
    path.join(unverifiedDir, 'manifest.json'),
    JSON.stringify({
      schema: BUNDLE_SCHEMA,
      status: 'not-reproduced',
      finding: scenario.finding,
      gates: { g1: false },
    }),
  );

  await assert.rejects(
    () => renderEvidenceBundle({ evidenceDir: unverifiedDir }),
    (err) => err instanceof EvidenceRenderError && err.code === 'UNVERIFIED_FINDING',
  );
});

test('executeStep and computeStageTimeline keep monotonic t0Ms offsets relative and ignore stray epoch timestamps', async () => {
  const monoZero = performance.now();
  const sleepOut = await executeStep({
    step: { kind: 'sleep', ms: 15 },
    t0Ms: monoZero,
  });
  assert.equal(typeof sleepOut.event.tMs, 'number');
  assert.ok(sleepOut.event.tMs >= 0 && sleepOut.event.tMs < 5000, `Expected relative tMs, got ${sleepOut.event.tMs}`);

  const timeline = computeStageTimeline({
    scenario: makeBaseScenario(),
    durationMs: 4200,
    events: [
      { phase: 'control', tMs: 800, decision: 'ALLOW' },
      { phase: 'repro', tMs: 2100, decision: 'ALLOW' },
      { kind: 'sleep', tMs: 1793975245802.952 },
      { phase: 'fix', tMs: 3400, decision: 'DENY' },
    ],
  });
  assert.ok(
    timeline.totalMs >= 4200 && timeline.totalMs < 20_000,
    `Expected bounded totalMs, got ${timeline.totalMs}`,
  );
});

test('parseJsonWithComments strips JSONC comments and trailing commas while preserving string literals', () => {
  const jsonc = `{
    // line comment before rules
    "rules": {
      /* block comment with https://example.com//path */
      "messages": {
        "$tabid": {
          ".write": "auth != null && newData.child('url').val() != 'https://evil.example//a/*b*/'", // trailing comment
        },
      },
    },
  }`;
  const parsed = parseJsonWithComments(jsonc);
  assert.equal(
    parsed.rules.messages.$tabid['.write'],
    "auth != null && newData.child('url').val() != 'https://evil.example//a/*b*/'",
  );
});

test('formatRuleExpressionSummary and extractFocusedRuleSnippet preserve head and tail predicates on long RTDB rules', () => {
  const longRule =
    "auth != null && auth.token.hasAccess != null && auth.token.accessRestriction == null && (data.parent().parent().child('members').child(auth.uid).val() == true || root.child('rooms').child($roomId).child('tabs').child($tabid).child('members').child(auth.uid).val() == true) && data.parent().child('speaker/uid').val() == auth.uid";
  const summary = formatRuleExpressionSummary(longRule, 128);
  assert.ok(summary.startsWith('auth != null'), `Expected head preserved: ${summary}`);
  assert.ok(summary.includes(' ... '), `Expected head+tail ellipsis: ${summary}`);
  assert.ok(
    summary.endsWith("data.parent().child('speaker/uid').val() == auth.uid"),
    `Expected tail speaker/uid check preserved: ${summary}`,
  );

  const rulesDoc = {
    rules: {
      app: {
        rooms: {
          $roomId: {
            messages: {
              $tabid: {
                '.write':
                  "auth != null && auth.token.hasAccess != null && root.child('app/rooms').child($roomId).child('tabs').child($tabid).child('members').child(auth.uid).val() == true",
                $messageid: {
                  content: {
                    '.write': longRule,
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const focused = extractFocusedRuleSnippet(rulesDoc, {
    service: 'database',
    method: 'set',
    path: '/app/rooms/s1/messages/pub/mAlice/content',
  });
  assert.ok(focused.includes('$messageid/content'), `Expected deepest rule key: ${focused}`);
  assert.ok(focused.includes("speaker/uid')"), `Expected speaker/uid tail in snippet: ${focused}`);
});

test('withOffOriginNavigationGuard and ensureActorPageHydrated block off-origin redirects and recover page hydration', async () => {
  const abortedUrls = [];
  const continuedUrls = [];
  const routedHandlers = [];

  let currentUrl = 'https://www.google.com/';
  let gotoCount = 0;

  const mainFrame = { id: 'main' };
  const fakePage = {
    mainFrame: () => mainFrame,
    route: async (_pattern, handler) => {
      routedHandlers.push(handler);
    },
    unroute: async (_pattern, handler) => {
      const idx = routedHandlers.indexOf(handler);
      if (idx >= 0) routedHandlers.splice(idx, 1);
    },
    url: () => currentUrl,
    goto: async (url) => {
      gotoCount += 1;
      currentUrl = url;
    },
    evaluate: async (fn, arg) => {
      if (arg && typeof arg === 'object' && 'sessionKey' in arg) {
        return {
          hasSession: true,
          hasBodyText: gotoCount >= 1 && currentUrl.startsWith('http://127.0.0.1:4123/'),
          hasExpectedText: gotoCount >= 1 && currentUrl.startsWith('http://127.0.0.1:4123/'),
        };
      }
      return undefined;
    },
  };

  await withOffOriginNavigationGuard(fakePage, 'http://127.0.0.1:4123/s1/chat/pub', async () => {
    assert.equal(routedHandlers.length, 1);
    const handler = routedHandlers[0];

    await handler({
      request: () => ({
        url: () => 'https://www.google.com/?auth=bounce',
        isNavigationRequest: () => true,
        frame: () => mainFrame,
      }),
      abort: async () => {
        abortedUrls.push('https://www.google.com/?auth=bounce');
      },
      continue: async () => {
        continuedUrls.push('https://www.google.com/?auth=bounce');
      },
    });

    await handler({
      request: () => ({
        url: () => 'http://127.0.0.1:4123/s1/chat/pub',
        isNavigationRequest: () => true,
        frame: () => mainFrame,
      }),
      abort: async () => {},
      continue: async () => {
        continuedUrls.push('http://127.0.0.1:4123/s1/chat/pub');
      },
    });
  });

  assert.equal(routedHandlers.length, 0);
  assert.deepEqual(abortedUrls, ['https://www.google.com/?auth=bounce']);
  assert.deepEqual(continuedUrls, ['http://127.0.0.1:4123/s1/chat/pub']);

  await ensureActorPageHydrated({
    page: fakePage,
    uid: 'bob',
    appUrl: 'http://127.0.0.1:4123',
    actor: {
      uid: 'bob',
      view: '/s1/chat/pub',
      expect: { before: { text: 'Quarterly incident postmortem' } },
    },
    minStabilityMs: 10,
  });

  assert.equal(gotoCount, 1);
  assert.equal(currentUrl, 'http://127.0.0.1:4123/s1/chat/pub');
  assert.equal(routedHandlers.length, 0);
});

test('extractActorFramesFromVideo removes stale tail frames from prior captures', async () => {
  const tools = probeSystemTools();
  const tmpDir = createTempRenderDir();
  let encoder = null;
  try {
    const mp4Path = path.join(tmpDir, 'short.mp4');
    encoder = createH264PipeEncoder({
      ffmpegPath: tools.ffmpegPath,
      width: 64,
      height: 64,
      fps: 10,
      outMp4Path: mp4Path,
    });
    const png1 = generateSyntheticPng(64, 64, 0);
    const png2 = generateSyntheticPng(64, 64, 1);
    await encoder.writeFrame(png1);
    await encoder.writeFrame(png2);
    await encoder.finish();
    encoder = null;

    const extractDir = path.join(tmpDir, 'extracted');
    const staleRoleDir = path.join(extractDir, 'owner');
    fs.mkdirSync(staleRoleDir, { recursive: true });
    fs.writeFileSync(path.join(staleRoleDir, 'frame-00099.png'), png1);

    const extracted = await extractActorFramesFromVideo({
      ffmpegPath: tools.ffmpegPath,
      videoPath: mp4Path,
      cropRects: { owner: { x: 0, y: 0, width: 64, height: 64 } },
      outputDir: extractDir,
      fps: 10,
      packetTimestampsMs: [0, 100],
    });

    assert.equal(fs.existsSync(path.join(staleRoleDir, 'frame-00099.png')), false);
    assert.ok(extracted.frames.length >= 1 && extracted.frames.length <= 2);
  } finally {
    encoder?.abort();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('presentation deck timeline follows 8-slide reviewer flow on monochrome surface with zero middots, Scene labels, or border-left stripes', () => {
  const fullBeforeRule =
    'messages/$tabid: ".write": "auth != null && auth.token.hasAccess != null && root.child(\'app\').child(\'rooms\').child($roomId).child(\'metadata\').child(\'members\').child(auth.uid).exists()"';
  const fullAfterRule =
    'messages/$tabid/$messageid: ".write": "auth != null && root.child(\'app\').child(\'rooms\').child($roomId).child(\'metadata\').child(\'members\').child(auth.uid).exists() && (!data.exists() || data.child(\'speaker\').child(\'uid\').val() == auth.uid)"';

  const scenario = validateScenario({
    ...makeBaseScenario(),
    copy: {
      title: 'Cross-tenant RTDB message overwrite',
      baseline: 'Alice and Bob share access to the workspace chat.',
      attackContext: 'Bypassing the UI, Bob calls the SDK directly to overwrite Alice’s message node.',
      summary: 'Bob overwrites Alice’s message',
      why: 'Write rule sits on $tabid and checks space membership without checking message authorship.',
      fixed: 'Verified with updated rules',
      fixContext: 'Move .write down to $messageid and require speaker.uid == auth.uid.',
      severity: 'HIGH',
    },
    fixRules: {
      before: '".write": "auth != null"',
      after: '".write": "data.child(\'speaker/uid\').val() == auth.uid"',
    },
  });

  const timeline = computeStageTimeline({
    scenario,
    durationMs: 7500,
    events: [
      {
        phase: 'control',
        service: 'database',
        method: 'set',
        path: '/app/rooms/s1/messages/pub/mAlice/content',
        decision: 'ALLOW',
        tMs: 600,
        dispatchedAtMs: 650,
        executedAtMs: 850,
        settledAtMs: 950,
      },
      {
        phase: 'repro',
        service: 'database',
        method: 'set',
        path: '/app/rooms/s1/messages/pub/mAlice/content',
        decision: 'ALLOW',
        tMs: 2200,
        dispatchedAtMs: 2800,
        executedAtMs: 3150,
        settledAtMs: 3350,
      },
      {
        phase: 'fix',
        service: 'database',
        method: 'set',
        path: '/app/rooms/s1/messages/pub/mAlice/content',
        decision: 'DENY',
        tMs: 5600,
        dispatchedAtMs: 6000,
        executedAtMs: 6200,
        settledAtMs: 6400,
      },
    ],
    evidence: {
      uiFocus: {
        control: {
          owner: { vw: 900, vh: 675, x: 0.08, y: 0.42, w: 0.62, h: 0.14 },
          peer: { vw: 900, vh: 675, x: 0.08, y: 0.42, w: 0.62, h: 0.14 },
        },
        reproPre: {
          owner: { vw: 900, vh: 675, x: 0.08, y: 0.42, w: 0.62, h: 0.14 },
          peer: { vw: 900, vh: 675, x: 0.08, y: 0.42, w: 0.62, h: 0.14 },
        },
        reproPost: {
          owner: { vw: 900, vh: 675, x: 0.08, y: 0.42, w: 0.68, h: 0.14 },
          peer: { vw: 900, vh: 675, x: 0.08, y: 0.42, w: 0.68, h: 0.14 },
        },
        fixPost: {
          owner: { vw: 900, vh: 675, x: 0.08, y: 0.42, w: 0.62, h: 0.14 },
          peer: { vw: 900, vh: 675, x: 0.08, y: 0.42, w: 0.62, h: 0.14 },
        },
      },
      fixRules: {
        before: scenario.fixRules.before,
        after: scenario.fixRules.after,
        beforeFull: fullBeforeRule,
        afterFull: fullAfterRule,
      },
    },
  });

  assert.ok(timeline.presentation, 'Expected presentation deck on timeline');
  const slides = timeline.presentation.slides;
  assert.deepEqual(
    slides.map((s) => s.id),
    ['title', 'attach-demo', 'path-slide', 'problem-slide', 'problem-video', 'why-slide', 'fix-slide', 'fix-video'],
  );

  for (let i = 0; i < slides.length - 1; i += 1) {
    assert.equal(slides[i].endMs, slides[i + 1].startMs);
  }
  assert.equal(slides[slides.length - 1].endMs, timeline.presentation.totalMs);

  const attachDemo = slides.find((s) => s.id === 'attach-demo');
  assert.ok(attachDemo && attachDemo.variant === 'video' && attachDemo.playDurationMs >= 2000);
  assert.equal(scenario.stage.slots.collapseSidebar, true);
  assert.ok(attachDemo.uiOverlays && attachDemo.uiOverlays.focus?.owner?.w > 0);
  assert.equal(attachDemo.uiOverlays.after.wire.caller, 'alice');
  assert.equal(attachDemo.uiOverlays.after.wire.decision, 'ALLOW');

  const pathSlide = slides.find((s) => s.id === 'path-slide');
  assert.ok(Array.isArray(pathSlide.pathTokens) && pathSlide.pathTokens.length >= 6);
  const annotatedParams = pathSlide.pathTokens.filter((t) => t.callout && t.callout.label);
  assert.deepEqual(
    annotatedParams.map((t) => t.text),
    ['$roomId', '$tabid', '$messageid'],
  );

  const attackSlide = slides.find((s) => s.id === 'problem-slide');
  assert.equal(attackSlide.targetPath, '/app/rooms/s1/messages/pub/mAlice/content');
  assert.ok(attackSlide.code && attackSlide.callerSummary);
  assert.ok(Array.isArray(attackSlide.pathTokens) && attackSlide.pathTokens.length >= 6);
  assert.deepEqual(
    attackSlide.pathTokens.filter((t) => t.isParam).map((t) => ({ text: t.text, value: t.concreteValue })),
    [
      { text: '$roomId', value: 's1' },
      { text: '$tabid', value: 'pub' },
      { text: '$messageid', value: 'mAlice' },
    ],
  );

  const reproVideo = slides.find((s) => s.id === 'problem-video');
  assert.ok(reproVideo.playDurationMs >= 3000);
  assert.ok(
    typeof reproVideo.impactOffsetSec === 'number' &&
      reproVideo.impactOffsetSec >= 0.45 &&
      reproVideo.impactOffsetSec <= 3.1,
  );
  const reproSrcStart = mapPresentationTimeToSourceMs(timeline.presentation, reproVideo.startMs);
  const reproSrcEnd = mapPresentationTimeToSourceMs(timeline.presentation, reproVideo.endMs - 100);
  assert.ok(
    reproSrcEnd - reproSrcStart >= 1500,
    `Expected continuous pre-to-post repro video span, got ${reproSrcStart} -> ${reproSrcEnd}`,
  );
  assert.ok(reproVideo.uiOverlays && reproVideo.uiOverlays.focusAfter?.peer?.w > 0);
  assert.equal(reproVideo.uiOverlays.before.wire.decision, 'ARMED');
  assert.equal(reproVideo.uiOverlays.after.wire.decision, 'ALLOW');
  assert.ok(
    reproVideo.uiOverlays.after.wire.pathTokens.some((t) => t.isParam && t.concreteValue === 'mAlice'),
    'Expected variable path tokens on problem-video UI wire overlay',
  );

  const fixVideo = slides.find((s) => s.id === 'fix-video');
  assert.ok(fixVideo && fixVideo.uiOverlays);
  assert.equal(fixVideo.uiOverlays.after.wire.decision, 'DENIED');

  const whySlide = slides.find((s) => s.id === 'why-slide');
  assert.ok(Array.isArray(whySlide.ruleTree) && whySlide.ruleTree.length >= 2);
  const ruleEntry = whySlide.ruleTree.find((n) => Array.isArray(n.ruleLines) && n.ruleLines.length > 0);
  assert.ok(ruleEntry, 'Expected distilled rule lines on why-slide');
  assert.ok(!ruleEntry.ruleLines.some((l) => l.includes('.child(\'app\')')), 'Expected compacted path chains');
  assert.ok(
    whySlide.ruleTree.some((n) => n.isFlawHighlight === true && n.node === '$messageid'),
    'Expected highlighted inherited flaw row at $messageid on why-slide',
  );
  assert.ok(whySlide.missingCheck && whySlide.missingCheck.code.includes('speaker/uid'));

  const fixSlide = slides.find((s) => s.id === 'fix-slide');
  assert.ok(Array.isArray(fixSlide.beforeDiffTree) && fixSlide.beforeDiffTree.length >= 1);
  assert.ok(Array.isArray(fixSlide.afterDiffTree) && fixSlide.afterDiffTree.length >= 1);
  assert.ok(
    fixSlide.beforeDiffTree.some((n) => n.isFlawHighlight === true),
    'Expected highlighted flaw node in fix-slide Before tree',
  );
  const afterRuleNode = fixSlide.afterDiffTree.find((n) => Array.isArray(n.ruleLines) && n.ruleLines.length > 0);
  assert.ok(
    afterRuleNode && afterRuleNode.isFixNodeHighlight === true && afterRuleNode.ruleLines.some((l) => l.highlight === true),
    'Expected highlighted attachment node and ownership line in fix-slide After tree',
  );

  const serializedDeck = JSON.stringify(slides);
  assert.equal(/[·•]/.test(serializedDeck), false, 'Slides must not contain middot/bullet separators');
  assert.equal(/\bScene\s*\d+/i.test(serializedDeck), false, 'Slides must not contain "Scene <number>" labels');

  const stageHtmlPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../skills/improve-firebase/assets/stages/split-actors.html',
  );
  const stageHtml = fs.readFileSync(stageHtmlPath, 'utf8');
  assert.equal(/[·•]/.test(stageHtml), false, 'split-actors.html must not contain middot/bullet separators');
  assert.equal(/\bScene\b/i.test(stageHtml), false, 'split-actors.html must not contain "Scene" labels');
  assert.equal(/border-left\s*:/i.test(stageHtml), false, 'split-actors.html must never use border-left stripes');
  assert.ok(stageHtml.includes('PyricSans') && stageHtml.includes('PyricMono'), 'split-actors.html must load bundled fonts');
});

test('attach-demo starts only after actor views are ready (control.uiReadyAtMs)', () => {
  const attachStart = (scenario, events) =>
    computeStageTimeline({ scenario, events, durationMs: 9000 }).presentation.slides.find((s) => s.id === 'attach-demo');

  // Rules variant
  const rulesScenario = makeBaseScenario();
  const rulesEvents = (control = {}) => [
    { phase: 'control', service: 'database', method: 'set', path: '/channels/general/messages/m1', decision: 'ALLOW', tMs: 1800, dispatchedAtMs: 1850, executedAtMs: 1950, settledAtMs: 2000, ...control },
    { phase: 'repro', service: 'database', method: 'set', path: '/channels/general/messages/m1', decision: 'ALLOW', tMs: 3600, dispatchedAtMs: 4200, executedAtMs: 4400, settledAtMs: 4600 },
    { phase: 'fix', service: 'database', method: 'set', path: '/channels/general/messages/m1', decision: 'DENY', tMs: 6400, dispatchedAtMs: 6800, executedAtMs: 7000, settledAtMs: 7200 },
  ];
  const rulesLegacy = attachStart(rulesScenario, rulesEvents());
  assert.equal(rulesLegacy.sourceStartMs, 0, 'bundles without uiReadyAtMs keep the old start');
  const rulesReady = attachStart(rulesScenario, rulesEvents({ uiReadyAtMs: 1200 }));
  assert.ok(rulesReady.sourceStartMs >= 1200 + 150, `rules attach-demo starts at ${rulesReady.sourceStartMs}`);
  assert.ok(rulesReady.sourceEndMs > rulesReady.sourceStartMs);

  // Build variant
  const behaviorScenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'rooms-audit', probe: 'signout-ghost-presence' },
    app: { dist: './before-dist' },
    actors: {
      owner: { uid: 'alice', name: 'Alice', view: '/s1' },
      peer: { uid: 'bob', name: 'Bob', view: '/s1' },
    },
    behavior: {
      fixApp: { dist: './after-dist' },
      action: { kind: 'sign-out', actor: 'owner' },
      check: { kind: 'presence-entry', path: '/app/rooms/s1/presence', uid: 'alice' },
    },
    copy: { title: 'Signing out leaves you visible', summary: 'Alice signs out; her entry stays.', why: 'Cleanup runs signed out.' },
  });
  const behaviorEvents = (control = {}) => [
    { phase: 'control', service: 'database', method: 'onValue', path: '/app/rooms/s1/presence', decision: 'PRESENT', tMs: 4000, dispatchedAtMs: 4000, executedAtMs: 4000, settledAtMs: 4000, ...control },
    { phase: 'repro', service: 'auth', method: 'signOut', path: '/app/rooms/s1/presence/c1', decision: 'LEFT BEHIND', tMs: 4100, dispatchedAtMs: 4100, executedAtMs: 4500, settledAtMs: 7600 },
    { phase: 'fix', service: 'auth', method: 'signOut', path: '/app/rooms/s1/presence/c1', decision: 'REMOVED', tMs: 11000, dispatchedAtMs: 11000, executedAtMs: 11350, settledAtMs: 12800 },
  ];
  const behaviorLegacy = attachStart(behaviorScenario, behaviorEvents());
  assert.equal(behaviorLegacy.sourceStartMs, 4000 - 2200, 'bundles without uiReadyAtMs keep the old start');
  const behaviorReady = attachStart(behaviorScenario, behaviorEvents({ uiReadyAtMs: 2600 }));
  assert.equal(behaviorReady.sourceStartMs, 2600 + 150);
  assert.ok(behaviorReady.sourceEndMs > behaviorReady.sourceStartMs);
});

const ENGINE_GAP_NOTE =
  'Assurance could not confirm this fix (engine gap). The sandbox recording shows the write denied.';

function fixAssuranceTimeline(fixAssurance) {
  const scenario = makeBaseScenario({ stage: { layout: 'split-actors', aspect: '16:9' } });
  const target = '/channels/general/messages/msg_alice_1';
  const events = [
    { phase: 'control', service: 'database', method: 'set', path: target, decision: 'ALLOW', tMs: 600, dispatchedAtMs: 650, executedAtMs: 850, settledAtMs: 950 },
    { phase: 'repro', service: 'database', method: 'set', path: target, decision: 'ALLOW', tMs: 2200, dispatchedAtMs: 2800, executedAtMs: 3150, settledAtMs: 3350 },
    { phase: 'fix', service: 'database', method: 'set', path: target, decision: 'DENY', tMs: 5600, dispatchedAtMs: 6000, executedAtMs: 6200, settledAtMs: 6400 },
  ];
  const evidence = fixAssurance ? { fixAssurance } : null;
  return { scenario, events, evidence, timeline: computeStageTimeline({ scenario, events, durationMs: 7500, evidence }) };
}

test('fix slides carry the assurance note only when assurance did not verify the fix', () => {
  const unverified = fixAssuranceTimeline({ verified: false, reason: 'engine-gap', note: ENGINE_GAP_NOTE });
  const slides = unverified.timeline.presentation.slides;
  const withNote = slides.filter((s) => s.assuranceNote).map((s) => s.id);
  assert.deepEqual(withNote, ['fix-slide', 'fix-video'], 'only the fix slide and fix video carry the note');
  for (const id of withNote) {
    assert.equal(slides.find((s) => s.id === id).assuranceNote, ENGINE_GAP_NOTE);
  }
  assert.equal(/[·•]/.test(JSON.stringify(slides)), false);

  for (const fa of [null, { verified: true, reason: 'verified' }]) {
    const quiet = fixAssuranceTimeline(fa).timeline.presentation.slides;
    assert.equal(quiet.some((s) => 'assuranceNote' in s), false, 'verified or hand-written: nothing extra');
  }
});

test('split-actors stage shows the assurance note as plain monochrome text and keeps provenance locked', async (t) => {
  const stageHtmlPath = path.resolve(TEST_DIR, '../../skills/improve-firebase/assets/stages/split-actors.html');
  const stageHtml = fs.readFileSync(stageHtmlPath, 'utf8');
  // The locked strip markup is untouched and the note lives in its own element.
  assert.equal((stageHtml.match(/<span data-pyric-provenance><\/span>/g) || []).length, 1);
  assert.equal((stageHtml.match(/data-pyric-assurance-note/g) || []).length, 2);
  const noteCss = stageHtml.slice(stageHtml.indexOf('.assurance-note {'), stageHtml.indexOf('.video-status.is-settled'));
  assert.equal(/border|background|box-shadow/i.test(noteCss), false, 'the note is not boxed');

  const { chromium } = await loadPlaywright({ projectDir: TEST_DIR });
  const executablePath = resolveChromiumExecutable(chromium);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());

  const provenanceText = buildLockedProvenanceText({
    decision: 'ALLOW',
    fixedDecision: 'DENY',
    service: 'database',
    method: 'set',
    path: '/channels/general/messages/msg_alice_1',
    actorLabel: 'mallory',
  });
  const inspect = async (fixAssurance) => {
    const { scenario, timeline, evidence } = fixAssuranceTimeline(fixAssurance);
    const slides = timeline.presentation.slides;
    const payload = buildStagePayload({
      scenario,
      fps: 30,
      beats: timeline.beats,
      slides,
      passes: { repro: { fps: 30, totalFrames: 1, frames: [] } },
      evidence: evidence || {},
      provenanceText,
    });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.addInitScript((p) => {
      window.__PYRIC_EVIDENCE__ = p;
    }, payload);
    await page.goto(`file://${stageHtmlPath}`);
    await page.waitForFunction(() => typeof window.setFrame === 'function');
    const read = async (slideId, noteId) => {
      const slide = slides.find((s) => s.id === slideId);
      await page.evaluate((tSec) => window.setFrame(tSec), (slide.startMs + slide.endMs) / 2000);
      return page.evaluate((id) => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        const prov = document.querySelector('[data-pyric-provenance]');
        return {
          visible: !el.hidden && el.getBoundingClientRect().height > 0,
          text: el.textContent,
          color: cs.color,
          borderLeft: cs.borderLeftWidth,
          background: cs.backgroundColor,
          provenance: prov.textContent,
        };
      }, noteId);
    };
    const result = {
      fixSlide: await read('fix-slide', 'slideAssuranceNote'),
      fixVideo: await read('fix-video', 'videoAssuranceNote'),
      whySlide: await read('why-slide', 'slideAssuranceNote'),
    };
    await page.close();
    return result;
  };

  const gap = await inspect({ verified: false, reason: 'engine-gap', note: ENGINE_GAP_NOTE });
  for (const view of [gap.fixSlide, gap.fixVideo]) {
    assert.equal(view.visible, true);
    assert.equal(view.text, ENGINE_GAP_NOTE);
    const [r, g, b] = view.color.match(/\d+/g).map(Number);
    assert.ok(r === g && g === b, `note color must be gray, got ${view.color}`);
    assert.equal(view.borderLeft, '0px');
    assert.equal(view.background, 'rgba(0, 0, 0, 0)');
    assert.equal(view.provenance, provenanceText, 'provenance strip text is unchanged');
  }
  assert.equal(gap.whySlide.visible, false, 'the note does not leak onto other slides');

  const verified = await inspect({ verified: true, reason: 'verified' });
  assert.equal(verified.fixSlide.visible, false);
  assert.equal(verified.fixVideo.visible, false);
});
