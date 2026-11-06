import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  BUNDLE_SCHEMA,
  buildLockedProvenanceText,
  validateBundleManifest,
} from '../../skills/improve-firebase/scripts/lib/contracts.mjs';
import {
  inspectPngFile,
  comparePngFrames,
  scanTextForSecretsAndPii,
  checkCopyAgainstEvents,
  evaluateGateG1,
  evaluateGateG2,
  evaluateGateG3,
  evaluateGateG4,
  evaluateGateG5,
  evaluateGateG6,
  evaluateAllGates,
  writeFailureBundle,
} from '../../skills/improve-firebase/scripts/lib/gates.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(TEST_DIR, '../fixtures', 'orbit-rtdb-hijack.export.json');

// CRC-32 lookup table for valid PNG chunk encoding
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
 * Encode an 8-bit RGB (colorType=2) or RGBA (colorType=6) pixel buffer into a valid PNG file
 * using the specified PNG scanline filter type (0..4).
 */
function writeSyntheticPng(filePath, { width, height, colorType = 2, filterType = 0, pixelAt }) {
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const rawPixels = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixelAt(x, y);
      const idx = (y * width + x) * bpp;
      rawPixels[idx] = r & 0xff;
      rawPixels[idx + 1] = g & 0xff;
      rawPixels[idx + 2] = b & 0xff;
      if (bpp === 4) {
        rawPixels[idx + 3] = a & 0xff;
      }
    }
  }

  const scanlines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const inRow = y * stride;
    const prevRow = (y - 1) * stride;
    const outRow = y * (stride + 1);
    scanlines[outRow] = filterType;

    for (let i = 0; i < stride; i++) {
      const x = rawPixels[inRow + i];
      const a = i >= bpp ? rawPixels[inRow + i - bpp] : 0;
      const b = y > 0 ? rawPixels[prevRow + i] : 0;
      const c = y > 0 && i >= bpp ? rawPixels[prevRow + i - bpp] : 0;

      let filtered;
      switch (filterType) {
        case 0:
          filtered = x;
          break;
        case 1:
          filtered = (x - a) & 0xff;
          break;
        case 2:
          filtered = (x - b) & 0xff;
          break;
        case 3:
          filtered = (x - ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          filtered = (x - paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported filterType ${filterType}`);
      }
      scanlines[outRow + 1 + i] = filtered;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bitDepth
  ihdr.writeUInt8(colorType, 9);
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const compressed = zlib.deflateSync(scanlines);
  const png = Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, png);
  return filePath;
}

test('inspectPngFile and comparePngFrames decode RGB/RGBA PNGs, detect blank vs textured frames, and measure motion deltas', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-gates-png-'));
  try {
    const blankPng = path.join(tmpDir, 'blank.png');
    writeSyntheticPng(blankPng, {
      width: 64,
      height: 48,
      colorType: 2,
      filterType: 0,
      pixelAt: () => [18, 22, 31],
    });

    const blankStats = inspectPngFile(blankPng);
    assert.equal(blankStats.width, 64);
    assert.equal(blankStats.height, 48);
    assert.equal(blankStats.pixelCount, 64 * 48);
    assert.equal(blankStats.isBlank, true);
    assert.equal(blankStats.lumaStdDev, 0);
    assert.ok(typeof blankStats.sampleHash === 'string' && blankStats.sampleHash.length > 0);

    // Nearly-solid low-contrast frame (range < 8) is also flagged as blank
    const lowContrastPng = path.join(tmpDir, 'low-contrast.png');
    writeSyntheticPng(lowContrastPng, {
      width: 64,
      height: 48,
      colorType: 6,
      filterType: 1,
      pixelAt: (x) => [100 + (x % 4), 100 + (x % 4), 100 + (x % 4), 255],
    });
    assert.equal(inspectPngFile(lowContrastPng).isBlank, true);

    // Textured gradient PNG encoded across all 5 PNG filter types must yield identical pixels & hash
    const gradientPixel = (x, y) => [
      (x * 4) & 0xff,
      (y * 5) & 0xff,
      ((x + y) * 3) & 0xff,
      255,
    ];
    const filterHashes = [];
    for (let filterType = 0; filterType <= 4; filterType++) {
      const p = path.join(tmpDir, `gradient-f${filterType}.png`);
      writeSyntheticPng(p, {
        width: 64,
        height: 48,
        colorType: 6,
        filterType,
        pixelAt: gradientPixel,
      });
      const stats = inspectPngFile(p);
      assert.equal(stats.isBlank, false);
      assert.ok(stats.lumaStdDev > 10);
      assert.ok(stats.maxLuma - stats.minLuma > 50);
      filterHashes.push(stats.sampleHash);
    }
    assert.equal(new Set(filterHashes).size, 1, 'all 5 PNG unfilters must reconstruct identical pixels');

    const cmpSame = comparePngFrames(
      path.join(tmpDir, 'gradient-f0.png'),
      path.join(tmpDir, 'gradient-f4.png'),
    );
    assert.equal(cmpSame.identical, true);
    assert.equal(cmpSame.meanAbsDiff, 0);

    // Shifted motion PNG
    const shiftedPng = path.join(tmpDir, 'shifted.png');
    writeSyntheticPng(shiftedPng, {
      width: 64,
      height: 48,
      colorType: 6,
      filterType: 4,
      pixelAt: (x, y) => gradientPixel(x + 12, y + 6),
    });
    const cmpMoved = comparePngFrames(path.join(tmpDir, 'gradient-f0.png'), shiftedPng);
    assert.equal(cmpMoved.identical, false);
    assert.ok(cmpMoved.meanAbsDiff > 1);

    // Invalid PNG file throws
    const bogusPng = path.join(tmpDir, 'not-a-png.png');
    fs.writeFileSync(bogusPng, 'not a png');
    assert.throws(() => inspectPngFile(bogusPng), /Invalid PNG header/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scanTextForSecretsAndPii catches secrets and real emails while allowing synthetic domains', () => {
  const cleanRes = scanTextForSecretsAndPii(
    JSON.stringify({
      title: 'Cross-tenant RTDB overwrite',
      actor: 'mallory@pyric.local',
      owner: 'alice@example.com',
      reviewer: 'sec@example.org',
      local: 'admin@test.local',
      emulatorApiKey: 'AIzaSyEmulatorSynthetic0000000000000000',
      path: '/tasks-1234567890123456789012345',
    }),
  );
  assert.equal(cleanRes.clean, true);
  assert.deepEqual(cleanRes.findings, []);

  // AWS key
  const awsRes = scanTextForSecretsAndPii('aws_access_key_id=AKIAIOSFODNN7EXAMPLE');
  assert.equal(awsRes.clean, false);
  assert.equal(awsRes.findings[0].type, 'aws_access_key');

  // JWT token
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFsaWNlIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const jwtRes = scanTextForSecretsAndPii(`Authorization: Bearer ${jwt}`);
  assert.equal(jwtRes.clean, false);
  assert.equal(jwtRes.findings[0].type, 'jwt_token');

  // RSA Private Key
  const keyRes = scanTextForSecretsAndPii('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...');
  assert.equal(keyRes.clean, false);
  assert.equal(keyRes.findings[0].type, 'private_key');

  // Live GCP/Firebase API key (without emulator/synthetic marker)
  const gcpRes = scanTextForSecretsAndPii('apiKey: "AIzaSyD123456789012345678901234567890123"');
  assert.equal(gcpRes.clean, false);
  assert.equal(gcpRes.findings[0].type, 'gcp_api_key');

  // GitHub, Slack, and generic sk- tokens
  assert.equal(
    scanTextForSecretsAndPii('token=ghp_1234567890abcdefghijklmnopqrstuvwxyz').clean,
    false,
  );
  assert.equal(
    scanTextForSecretsAndPii('slack=xoxb-1234567890-123456789012-abcdefghij').clean,
    false,
  );
  assert.equal(
    scanTextForSecretsAndPii('key=sk-1234567890abcdefghijklmnop').clean,
    false,
  );

  // Real non-synthetic email vs allowedEmails
  const emailRes = scanTextForSecretsAndPii('Leaked user record: owner@company.com');
  assert.equal(emailRes.clean, false);
  assert.equal(emailRes.findings[0].type, 'email_pii');
  assert.equal(emailRes.findings[0].sample, 'owner@company.com');

  const allowedEmailRes = scanTextForSecretsAndPii('Actor: owner@company.com', {
    allowedEmails: ['owner@company.com'],
  });
  assert.equal(allowedEmailRes.clean, true);
});

test('checkCopyAgainstEvents verifies locked provenance text and catches contradictory claims', () => {
  const reproEvent = {
    decision: 'ALLOW',
    service: 'database',
    method: 'set',
    path: '/channels/general/messages/msg_alice_1',
    actorLabel: 'mallory',
  };
  const fixEvent = {
    decision: 'DENY',
  };

  const validProvenance = buildLockedProvenanceText({
    decision: 'ALLOW',
    fixedDecision: 'DENY',
    service: 'database',
    method: 'set',
    path: '/channels/general/messages/msg_alice_1',
    actorLabel: 'mallory',
  });

  const ok = checkCopyAgainstEvents({
    copy: {
      title: 'Cross-tenant RTDB message overwrite',
      summary: 'Mallory overwrote Alice message because write was not blocked by rules',
      why: 'Missing authorUid check',
      fixed: 'Write is now BLOCKED and FIXED after adding authorUid validation',
    },
    provenanceText: validProvenance,
    reproEvent,
    fixEvent,
  });
  assert.equal(ok.pass, true, `Expected pass, got reasons: ${ok.reasons.join('; ')}`);

  // Contradiction: ALLOW repro described as BLOCKED
  const badReproduceCopy = checkCopyAgainstEvents({
    copy: {
      title: 'Cross-tenant write',
      summary: 'Mallory write request was BLOCKED by Firebase rules',
      why: 'Missing rule',
    },
    provenanceText: validProvenance,
    reproEvent,
    fixEvent,
  });
  assert.equal(badReproduceCopy.pass, false);
  assert.ok(badReproduceCopy.reasons.some((r) => /ALLOW/i.test(r) && /BLOCKED/i.test(r)));

  // Contradiction: failed fix (ALLOW) described as FIXED
  const badFixCopy = checkCopyAgainstEvents({
    copy: {
      title: 'Cross-tenant write',
      summary: 'Mallory overwrote Alice message',
      why: 'Missing rule',
      fixed: 'Vulnerability FIXED in rules',
    },
    provenanceText: buildLockedProvenanceText({
      decision: 'ALLOW',
      fixedDecision: 'ALLOW',
      service: 'database',
      method: 'set',
      path: '/channels/general/messages/msg_alice_1',
      actorLabel: 'mallory',
    }),
    reproEvent,
    fixEvent: { decision: 'ALLOW' },
  });
  assert.equal(badFixCopy.pass, false);
  assert.ok(badFixCopy.reasons.some((r) => /FIXED/i.test(r)));

  // Tampered provenance text
  const tamperedProv = checkCopyAgainstEvents({
    copy: {
      title: 'Cross-tenant write',
      summary: 'Mallory overwrote Alice message',
      why: 'Missing rule',
    },
    provenanceText: 'DENY / database.set /channels/general/messages/msg_alice_1 / as mallory',
    reproEvent,
  });
  assert.equal(tamperedProv.pass, false);
  assert.ok(tamperedProv.reasons.some((r) => /Provenance text mismatch/i.test(r)));
});

test('evaluateGateG1..G5 validate preconditions, baseline, repro, visible effect, and fix gates', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const probe = fixture.probes[0];

  // G1 happy & failure cases
  const g1Pass = evaluateGateG1(probe, { expectedTargetHash: fixture.target.databaseRulesHash });
  assert.equal(g1Pass.pass, true);
  assert.equal(g1Pass.gate, 'G1');
  assert.equal(g1Pass.name, 'Preconditions');

  const g1LocalCounter = evaluateGateG1({
    ...probe,
    classification: 'local-counterexample',
  });
  assert.equal(g1LocalCounter.pass, true);

  const g1NotReproduced = evaluateGateG1({
    ...probe,
    classification: 'not-reproduced',
  });
  assert.equal(g1NotReproduced.pass, false);

  const g1HashMismatch = evaluateGateG1(probe, { expectedTargetHash: 'sha256:different' });
  assert.equal(g1HashMismatch.pass, false);

  const g1MissingSpec = evaluateGateG1({
    classification: 'confirmed',
    mutationSpec: {},
  });
  assert.equal(g1MissingSpec.pass, false);

  // G2 happy & failure cases
  assert.equal(evaluateGateG2(probe.control).pass, true);
  assert.equal(evaluateGateG2({ decision: 'DENY' }).pass, false);

  // G3 happy & failure cases (prefix/child path matching)
  const g3Pass = evaluateGateG3(
    { decision: 'ALLOW', changedPaths: probe.stateDiff.changedPaths },
    [probe.mutationSpec.operation.path],
  );
  assert.equal(g3Pass.pass, true);

  const g3WrongPath = evaluateGateG3(
    { decision: 'ALLOW', changedPaths: ['/channels/general/messages/msg_alice_10/text'] },
    ['/channels/general/messages/msg_alice_1'],
  );
  assert.equal(g3WrongPath.pass, false);

  const g3Denied = evaluateGateG3({ decision: 'DENY', changedPaths: [] }, ['/a']);
  assert.equal(g3Denied.pass, false);

  // G4 happy & failure cases (data-plane & app-view)
  assert.equal(evaluateGateG4({ mode: 'data-plane', stateDiff: probe.stateDiff }).pass, true);
  assert.equal(evaluateGateG4({ mode: 'data-plane', stateDiff: { changedPaths: [] } }).pass, false);
  assert.equal(evaluateGateG4({ mode: 'app-view', expectResult: { pass: true } }).pass, true);
  assert.equal(
    evaluateGateG4({ mode: 'app-view', expectResult: { pass: false, reason: 'DOM unchanged' } }).pass,
    false,
  );

  // G5 skipped vs enabled happy & failure cases
  const g5Skipped = evaluateGateG5({ enabled: false });
  assert.equal(g5Skipped.pass, true);
  assert.equal(g5Skipped.skipped, true);

  const g5Pass = evaluateGateG5({
    enabled: true,
    fixControlResult: { decision: 'ALLOW' },
    fixReproduceResult: { decision: 'DENY' },
    fixStateDiff: { changedPaths: [] },
  });
  assert.equal(g5Pass.pass, true);
  assert.equal(g5Pass.skipped, false);

  const g5StillVulnerable = evaluateGateG5({
    enabled: true,
    fixControlResult: { decision: 'ALLOW' },
    fixReproduceResult: { decision: 'ALLOW' },
    fixStateDiff: { changedPaths: ['/channels/general/messages/msg_alice_1/text'] },
  });
  assert.equal(g5StillVulnerable.pass, false);
  assert.equal(g5StillVulnerable.skipped, false);
});

test('evaluateGateG6 and evaluateAllGates enforce render integrity, provenance, motion, and frame pacing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-gates-g6-'));
  try {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    const probe = fixture.probes[0];

    const videoPath = path.join(tmpDir, 'video.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(4096, 0x2a));

    const posterPath = path.join(tmpDir, 'poster.png');
    const frame0 = path.join(tmpDir, 'frame-0.png');
    const frame1 = path.join(tmpDir, 'frame-1.png');
    const blankPoster = path.join(tmpDir, 'blank-poster.png');

    writeSyntheticPng(posterPath, {
      width: 64,
      height: 36,
      colorType: 2,
      filterType: 1,
      pixelAt: (x, y) => [(x * 4) & 0xff, (y * 6) & 0xff, 180],
    });
    writeSyntheticPng(frame0, {
      width: 64,
      height: 36,
      colorType: 2,
      filterType: 1,
      pixelAt: (x, y) => [(x * 4) & 0xff, (y * 6) & 0xff, 100],
    });
    writeSyntheticPng(frame1, {
      width: 64,
      height: 36,
      colorType: 2,
      filterType: 1,
      pixelAt: (x, y) => [((x + 15) * 4) & 0xff, ((y + 8) * 6) & 0xff, 220],
    });
    writeSyntheticPng(blankPoster, {
      width: 64,
      height: 36,
      colorType: 2,
      filterType: 0,
      pixelAt: () => [11, 13, 16],
    });

    const reproEvent = {
      decision: 'ALLOW',
      service: 'database',
      method: 'set',
      path: probe.mutationSpec.operation.path,
      actorLabel: 'mallory',
    };
    const fixEvent = { decision: 'DENY' };
    const provenanceText = buildLockedProvenanceText({
      decision: 'ALLOW',
      fixedDecision: 'DENY',
      service: 'database',
      method: 'set',
      path: probe.mutationSpec.operation.path,
      actorLabel: 'mallory',
    });
    const copy = {
      title: 'Cross-tenant RTDB message overwrite',
      summary: 'Mallory overwrites Alice message in /channels/general/messages',
      why: 'Missing authorUid check',
      fixed: 'Write is now BLOCKED by authorUid rule',
    };

    const baseG6Input = {
      videoPath,
      ffprobeResult: { width: 1920, height: 1080, durationSec: 8.5 },
      expectedWidth: 1920,
      expectedHeight: 1080,
      captureArtifact: {
        mode: 'video',
        fps: 30,
        packetTimestampsMs: [0, 33.3, 66.7, 100.0, 133.3],
      },
      posterPath,
      storyboardPaths: [frame0, frame1],
      domProvenanceText: provenanceText,
      expectedProvenanceText: provenanceText,
      copy,
      events: [{ type: 'repro', ...reproEvent }, { type: 'fix', ...fixEvent }],
      requireMotion: true,
    };

    // Full G1..G6 pass via evaluateAllGates
    const allPass = evaluateAllGates({
      probe,
      expectedTargetHash: fixture.target.databaseRulesHash,
      fixEnabled: true,
      fixControlResult: { decision: 'ALLOW' },
      fixReproduceResult: { decision: 'DENY' },
      fixStateDiff: { changedPaths: [] },
      ...baseG6Input,
    });
    assert.equal(allPass.pass, true, `Expected all gates pass, got: ${allPass.reasons.join('; ')}`);
    assert.equal(allPass.status, 'reproduced');
    assert.equal(allPass.failedGate, null);
    assert.equal(allPass.gates.G6.details.motionCheck.identical, false);

    // G6 failure: missing / tampered domProvenanceText
    const missingProv = evaluateGateG6({ ...baseG6Input, domProvenanceText: '' });
    assert.equal(missingProv.pass, false);

    const tamperedProv = evaluateGateG6({
      ...baseG6Input,
      domProvenanceText: 'DENY / database.set /channels/general/messages/msg_alice_1 / as mallory',
    });
    assert.equal(tamperedProv.pass, false);

    // G6 failure: dropped CFR frame gap (> 2.5 * 33.33ms = 83.33ms at 30fps)
    const droppedFrames = evaluateGateG6({
      ...baseG6Input,
      captureArtifact: {
        mode: 'video',
        fps: 30,
        packetTimestampsMs: [0, 33.3, 210.0, 243.3],
      },
    });
    assert.equal(droppedFrames.pass, false);
    assert.ok(droppedFrames.reasons.some((r) => /Dropped CFR frames/i.test(r)));

    // G6 failure: blank poster
    const blankPosterRes = evaluateGateG6({
      ...baseG6Input,
      posterPath: blankPoster,
    });
    assert.equal(blankPosterRes.pass, false);
    assert.ok(blankPosterRes.reasons.some((r) => /Poster PNG is blank/i.test(r)));

    // G6 failure: frozen render (identical storyboard frames with requireMotion=true)
    const frozenRender = evaluateGateG6({
      ...baseG6Input,
      storyboardPaths: [frame0, frame0],
      requireMotion: true,
    });
    assert.equal(frozenRender.pass, false);
    assert.ok(frozenRender.reasons.some((r) => /frozen render/i.test(r)));

    // G6 failure: secret leaked in events
    const leakedSecret = evaluateGateG6({
      ...baseG6Input,
      events: [{ type: 'debug', awsKey: 'AKIAIOSFODNN7EXAMPLE' }],
    });
    assert.equal(leakedSecret.pass, false);
    assert.ok(leakedSecret.reasons.some((r) => /Secret\/PII detected/i.test(r)));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeFailureBundle removes stray video/gif and writes validated not-reproduced manifest.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-gates-failbundle-'));
  try {
    const strayVideo = path.join(tmpDir, 'video.mp4');
    const strayGif = path.join(tmpDir, 'preview.gif');
    const traceFile = path.join(tmpDir, 'trace.json');
    fs.writeFileSync(strayVideo, 'unverified-video-bytes');
    fs.writeFileSync(strayGif, 'unverified-gif-bytes');
    fs.writeFileSync(traceFile, '{"events":[]}');

    const manifest = writeFailureBundle({
      outDir: tmpDir,
      finding: {
        campaign: 'camp-orbit-rtdb-01',
        probe: 'probe-rtdb-cross-tenant-write-01',
      },
      failedGate: 'G6',
      reasons: ['Poster PNG is blank', 'Missing or empty domProvenanceText'],
      provenanceText: '',
      tracePath: 'trace.json',
    });

    assert.equal(fs.existsSync(strayVideo), false, 'stale video.mp4 must be deleted');
    assert.equal(fs.existsSync(strayGif), false, 'stale preview.gif must be deleted');
    assert.equal(fs.existsSync(traceFile), true, 'trace.json should be preserved');

    const manifestPath = path.join(tmpDir, 'manifest.json');
    assert.equal(fs.existsSync(manifestPath), true);

    const diskManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(diskManifest.schema, BUNDLE_SCHEMA);
    assert.equal(diskManifest.status, 'not-reproduced');
    assert.equal(diskManifest.failedGate, 'G6');
    assert.deepEqual(diskManifest.reasons, [
      'Poster PNG is blank',
      'Missing or empty domProvenanceText',
    ]);
    assert.equal(diskManifest.artifacts.trace, 'trace.json');
    assert.doesNotThrow(() => validateBundleManifest(diskManifest));
    assert.equal(manifest.status, 'not-reproduced');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
