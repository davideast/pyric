import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_BACKENDS,
  DEFAULT_DPR,
  DEFAULT_PHYSICAL_SIZE,
  DEFAULT_VIEWPORT_DIP,
  RAW_CAPTURE_SCHEMA,
} from '../../skills/improve-firebase/scripts/lib/contracts.mjs';
import {
  RuntimeMissingError,
  loadPlaywright,
  probeSystemTools,
  resolveChromiumExecutable,
} from '../../skills/improve-firebase/scripts/lib/runtime.mjs';
import {
  CaptureBackend,
  CdpSurfaceBackend,
  MacOSAvfoundationBackend,
  X11XvfbBackend,
  selectCaptureBackend,
} from '../../skills/improve-firebase/scripts/lib/capture/backend.mjs';
import {
  buildAvfoundationCaptureArgs,
  parseAvfoundationScreenDevice,
} from '../../skills/improve-firebase/scripts/lib/capture/macos-avfoundation.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');
const DOCTOR_SCRIPT = path.join(REPO_ROOT, 'pyric-plugin/skills/improve-firebase/scripts/doctor.mjs');

const SYSTEM_WHICH = execFileSync('sh', ['-c', 'command -v which'], { encoding: 'utf8' }).trim();

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMockBinDir(parentDir, subName) {
  const dir = path.join(parentDir, subName);
  fs.mkdirSync(dir, { recursive: true });
  if (SYSTEM_WHICH && fs.existsSync(SYSTEM_WHICH)) {
    fs.symlinkSync(SYSTEM_WHICH, path.join(dir, 'which'));
  }
  return dir;
}

function writeExecutableScript(dir, name, content) {
  const fullPath = path.join(dir, name);
  fs.writeFileSync(fullPath, content, { mode: 0o755 });
  return fullPath;
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
 * Pure-Node zlib PNG IHDR/IDAT parser and scanline reconstructor.
 */
function parsePng(buffer) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i += 1) {
    assert.equal(buffer[i], signature[i], `Invalid PNG signature byte at index ${i}`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  assert.ok(width > 0 && height > 0, 'PNG missing valid IHDR dimensions');
  assert.ok(idatChunks.length > 0, 'PNG missing IDAT image data');
  assert.equal(bitDepth, 8, `Expected 8-bit PNG, got ${bitDepth}`);
  assert.equal(interlace, 0, 'Expected non-interlaced PNG');

  const channelsByColorType = { 6: 4, 2: 3, 4: 2, 0: 1 };
  const channels = channelsByColorType[colorType] ?? 1;
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  assert.equal(
    inflated.length,
    height * (stride + 1),
    `Unexpected inflated PNG byte length: got ${inflated.length}, expected ${height * (stride + 1)}`,
  );

  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filterType = inflated[rowStart];
    const outStart = y * stride;
    const prevStart = (y - 1) * stride;

    for (let i = 0; i < stride; i += 1) {
      const rawByte = inflated[rowStart + 1 + i];
      const a = i >= channels ? pixels[outStart + i - channels] : 0;
      const b = y > 0 ? pixels[prevStart + i] : 0;
      const c = y > 0 && i >= channels ? pixels[prevStart + i - channels] : 0;

      let recon = rawByte;
      if (filterType === 1) {
        recon = (rawByte + a) & 0xff;
      } else if (filterType === 2) {
        recon = (rawByte + b) & 0xff;
      } else if (filterType === 3) {
        recon = (rawByte + ((a + b) >> 1)) & 0xff;
      } else if (filterType === 4) {
        recon = (rawByte + paethPredictor(a, b, c)) & 0xff;
      }
      pixels[outStart + i] = recon;
    }
  }

  return { width, height, bitDepth, colorType, channels, pixels };
}

function countSampledColors(parsedPng) {
  const { width, height, channels, pixels } = parsedPng;
  const distinct = new Set();
  const stepX = Math.max(1, Math.floor(width / 40));
  const stepY = Math.max(1, Math.floor(height / 30));

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const idx = (y * width + x) * channels;
      const r = pixels[idx];
      const g = channels >= 3 ? pixels[idx + 1] : r;
      const b = channels >= 3 ? pixels[idx + 2] : r;
      distinct.add((r << 16) | (g << 8) | b);
    }
  }
  return distinct.size;
}

function buildAnimatedActorDataUrl({ role, bgHex, accentHex, badgeText }) {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: ${bgHex};
      color: #f8fafc;
      font-family: sans-serif;
    }
    .wrap {
      padding: 28px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      height: 100%;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 22px;
      border: 3px solid ${accentHex};
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      font-size: 28px;
      font-weight: 700;
    }
    canvas {
      width: 844px;
      height: 520px;
      border-radius: 12px;
      border: 2px solid rgba(255, 255, 255, 0.25);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <span>${badgeText} (${role.toUpperCase()})</span>
      <span id="tick">tick=0</span>
    </div>
    <canvas id="stage" width="844" height="520"></canvas>
  </div>
  <script>
    const canvas = document.getElementById('stage');
    const ctx = canvas.getContext('2d');
    const tickEl = document.getElementById('tick');
    let frame = 0;

    function render() {
      frame += 1;
      tickEl.textContent = 'tick=' + frame;

      ctx.fillStyle = '${bgHex}';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Moving high-contrast sweep bar so consecutive frames differ across large pixel area
      const barX = (frame * 37) % (canvas.width - 180);
      ctx.fillStyle = '${accentHex}';
      ctx.fillRect(barX, 60, 180, 380);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 48px sans-serif';
      ctx.fillText('${role.toUpperCase()} #' + frame, 48, 260);
    }

    render();
    setInterval(render, 20);
    function loop() {
      render();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  </script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

test('selectCaptureBackend chooses platform-appropriate backend and validates overrides', (t) => {
  const tmpBinRoot = makeTempDir('pyric-select-backend-');
  t.after(() => fs.rmSync(tmpBinRoot, { recursive: true, force: true }));

  // 1. Linux with both Xvfb and ffmpeg -> X11XvfbBackend
  const linuxFullBin = makeMockBinDir(tmpBinRoot, 'linux-full');
  writeExecutableScript(linuxFullBin, 'Xvfb', '#!/bin/sh\nexit 0\n');
  writeExecutableScript(linuxFullBin, 'ffmpeg', '#!/bin/sh\nexit 0\n');

  const linuxX11 = selectCaptureBackend({
    platform: 'linux',
    env: { PATH: linuxFullBin },
  });
  assert.ok(linuxX11 instanceof CaptureBackend);
  assert.ok(linuxX11 instanceof X11XvfbBackend);
  assert.equal(linuxX11.name, 'x11-xvfb');
  assert.equal(linuxX11.platform, 'linux');

  // 2. Linux without Xvfb -> falls back to CdpSurfaceBackend
  const linuxNoXvfbBin = makeMockBinDir(tmpBinRoot, 'linux-no-xvfb');
  writeExecutableScript(linuxNoXvfbBin, 'ffmpeg', '#!/bin/sh\nexit 0\n');

  const linuxFallback = selectCaptureBackend({
    platform: 'linux',
    env: { PATH: linuxNoXvfbBin },
  });
  assert.ok(linuxFallback instanceof CaptureBackend);
  assert.ok(linuxFallback instanceof CdpSurfaceBackend);
  assert.equal(linuxFallback.name, 'cdp-surface');

  // 3. macOS with ffmpeg reporting "Capture screen 0" -> MacOSAvfoundationBackend
  const darwinFullBin = makeMockBinDir(tmpBinRoot, 'darwin-full');
  writeExecutableScript(
    darwinFullBin,
    'ffmpeg',
    '#!/bin/sh\necho "[AVFoundation indev @ 0x1] [1] Capture screen 0" >&2\nexit 0\n',
  );

  const darwinAvf = selectCaptureBackend({
    platform: 'darwin',
    env: { PATH: darwinFullBin },
  });
  assert.ok(darwinAvf instanceof CaptureBackend);
  assert.ok(darwinAvf instanceof MacOSAvfoundationBackend);
  assert.equal(darwinAvf.name, 'macos-avfoundation');
  assert.equal(darwinAvf.platform, 'darwin');

  // 4. macOS without Capture screen device (TCC denied) -> falls back to CdpSurfaceBackend
  const darwinNoTccBin = makeMockBinDir(tmpBinRoot, 'darwin-no-tcc');
  writeExecutableScript(
    darwinNoTccBin,
    'ffmpeg',
    '#!/bin/sh\necho "[AVFoundation indev @ 0x1] [0] FaceTime HD Camera" >&2\nexit 1\n',
  );

  const darwinFallback = selectCaptureBackend({
    platform: 'darwin',
    env: { PATH: darwinNoTccBin },
  });
  assert.ok(darwinFallback instanceof CdpSurfaceBackend);
  assert.equal(darwinFallback.name, 'cdp-surface');

  // 5. Windows -> CdpSurfaceBackend
  const emptyBin = makeMockBinDir(tmpBinRoot, 'empty');
  const winBackend = selectCaptureBackend({ platform: 'win32', env: { PATH: emptyBin } });
  assert.ok(winBackend instanceof CdpSurfaceBackend);
  assert.equal(winBackend.name, 'cdp-surface');
  assert.equal(winBackend.platform, 'win32');

  // 6. Explicit aliases & overrides
  assert.equal(selectCaptureBackend({ backend: 'x11' }).name, 'x11-xvfb');
  assert.equal(selectCaptureBackend({ backend: 'x11-xvfb' }).name, 'x11-xvfb');
  assert.equal(selectCaptureBackend({ backend: 'avfoundation' }).name, 'macos-avfoundation');
  assert.equal(selectCaptureBackend({ backend: 'macos-avfoundation' }).name, 'macos-avfoundation');
  assert.equal(selectCaptureBackend({ backend: 'cdp' }).name, 'cdp-surface');
  assert.equal(selectCaptureBackend({ backend: 'cdp-surface' }).name, 'cdp-surface');

  // 7. Unknown backend throws descriptive error
  assert.throws(() => selectCaptureBackend({ backend: 'unknown-backend' }), /Unknown capture backend/);
  assert.throws(() => selectCaptureBackend({ backend: '' }), /Unknown capture backend/);
});

test('buildAvfoundationCaptureArgs builds deterministic ffmpeg arguments and MacOSAvfoundationBackend surfaces MACOS_TCC_DENIED', async (t) => {
  const defaultArgs = buildAvfoundationCaptureArgs({
    outputPath: '/tmp/pyric-avf.mkv',
  });
  assert.deepEqual(defaultArgs, [
    '-y',
    '-f',
    'avfoundation',
    '-framerate',
    '30',
    '-i',
    'Capture screen 0',
    '-c:v',
    'libx264rgb',
    '-crf',
    '0',
    '-preset',
    'ultrafast',
    '/tmp/pyric-avf.mkv',
  ]);

  const customArgs = buildAvfoundationCaptureArgs({
    screenDeviceIndex: '1',
    fps: 60,
    outputPath: '/tmp/custom.mkv',
  });
  assert.equal(customArgs[4], '60');
  assert.equal(customArgs[6], '1');
  assert.equal(customArgs[customArgs.length - 1], '/tmp/custom.mkv');

  assert.throws(() => buildAvfoundationCaptureArgs({ outputPath: '' }), /outputPath/);
  assert.throws(() => buildAvfoundationCaptureArgs({ fps: 0, outputPath: '/tmp/a.mkv' }), /fps/);

  const parsedDevice = parseAvfoundationScreenDevice(
    '[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera\n[AVFoundation indev @ 0x7f] [2] Capture screen 0\n',
  );
  assert.deepEqual(parsedDevice, { index: '2', name: 'Capture screen 0' });
  assert.equal(parseAvfoundationScreenDevice('[0] FaceTime HD Camera'), null);

  // Verify MacOSAvfoundationBackend throws MACOS_TCC_DENIED when Capture screen is absent
  const tmpDir = makeTempDir('pyric-avf-tcc-');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const binDir = makeMockBinDir(tmpDir, 'bin');
  writeExecutableScript(
    binDir,
    'ffmpeg',
    '#!/bin/sh\necho "AVFoundation video devices: [0] FaceTime HD Camera" >&2\nexit 1\n',
  );

  const avf = new MacOSAvfoundationBackend({ platform: 'darwin' });
  await assert.rejects(
    () =>
      avf.start({
        actors: { owner: { name: 'Alice' } },
        outputDir: path.join(tmpDir, 'out'),
        env: { PATH: binDir },
      }),
    (err) => {
      assert.ok(err instanceof RuntimeMissingError);
      assert.equal(err.code, 'MACOS_TCC_DENIED');
      assert.match(err.remediation, /CdpSurfaceBackend|--backend cdp/);
      return true;
    },
  );
});

test('doctor.mjs --json reports ready environment in repo and exits 1 when dependencies are missing', (t) => {
  const tmpDir = makeTempDir('pyric-doctor-');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const stdout = execFileSync(process.execPath, [DOCTOR_SCRIPT, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const report = JSON.parse(stdout);

  assert.equal(report.ok, true);
  assert.equal(report.ready, true);
  assert.equal(report.node.ok, true);
  assert.equal(report.playwright.ok, true);
  assert.equal(report.chromium.ok, true);
  assert.ok(fs.existsSync(report.chromium.executablePath));
  assert.ok(report.tools.ffmpeg);
  assert.ok(report.tools.ffprobe);
  assert.ok(CAPTURE_BACKENDS.includes(report.backend.selected));
  assert.deepEqual(report.issues, []);

  // Verify exit code 1 with actionable instructions when ffmpeg is missing from PATH
  const emptyBin = makeMockBinDir(tmpDir, 'empty-bin');
  const missingFfmpegRun = spawnSync(process.execPath, [DOCTOR_SCRIPT, '--json'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: emptyBin },
    encoding: 'utf8',
  });
  assert.equal(missingFfmpegRun.status, 1);
  const failReport = JSON.parse(missingFfmpegRun.stdout);
  assert.equal(failReport.ok, false);
  assert.ok(failReport.issues.some((issue) => issue.code === 'VIDEO_FFMPEG_MISSING'));

  // Verify exit code 1 with actionable instructions when Playwright is missing in an isolated project/cache
  const isolatedProject = path.join(tmpDir, 'isolated-project');
  const isolatedCache = path.join(tmpDir, 'isolated-cache');
  fs.mkdirSync(isolatedProject, { recursive: true });
  const missingPwRun = spawnSync(
    process.execPath,
    [DOCTOR_SCRIPT, '--json', '--project', isolatedProject],
    {
      cwd: tmpDir,
      env: { ...process.env, PYRIC_VIDEO_RUNTIME_DIR: isolatedCache },
      encoding: 'utf8',
    },
  );
  assert.equal(missingPwRun.status, 1);
  const missingPwReport = JSON.parse(missingPwRun.stdout);
  assert.equal(missingPwReport.ok, false);
  assert.equal(missingPwReport.playwright.ok, false);
  const pwIssue = missingPwReport.issues.find((issue) => issue.code === 'VIDEO_PLAYWRIGHT_MISSING');
  assert.ok(pwIssue, 'Expected VIDEO_PLAYWRIGHT_MISSING issue');
  assert.match(pwIssue.remediation, /--install/);
});

test('CdpSurfaceBackend captures dual-actor 2x PNG frames with monotonic tMs and animated differences', async (t) => {
  const outDir = makeTempDir('pyric-cdp-capture-');
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const { chromium } = await loadPlaywright({ projectDir: REPO_ROOT });
  const executablePath = resolveChromiumExecutable(chromium);
  const backend = new CdpSurfaceBackend();

  const session = await backend.start({
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'mallory', name: 'Mallory' },
    },
    outputDir: outDir,
    viewport: DEFAULT_VIEWPORT_DIP,
    dpr: DEFAULT_DPR,
    targetHz: 25,
    chromium,
    executablePath,
  });

  let artifact;
  try {
    const ownerUrl = buildAnimatedActorDataUrl({
      role: 'owner',
      bgHex: '#0b132b',
      accentHex: '#38bdf8',
      badgeText: 'Owner Workspace',
    });
    const peerUrl = buildAnimatedActorDataUrl({
      role: 'peer',
      bgHex: '#23090f',
      accentHex: '#f97316',
      badgeText: 'Peer Console',
    });

    await Promise.all([
      session.pages.owner.goto(ownerUrl, { waitUntil: 'load' }),
      session.pages.peer.goto(peerUrl, { waitUntil: 'load' }),
    ]);

    await backend.mark('loaded');
    await new Promise((resolve) => setTimeout(resolve, 260));
    await backend.mark('repro');
    await new Promise((resolve) => setTimeout(resolve, 120));

    artifact = await backend.stop();
  } finally {
    // Calling dispose() after stop() (or on error before stop()) must be idempotent
    await backend.dispose();
  }

  assert.equal(artifact.schema, RAW_CAPTURE_SCHEMA);
  assert.equal(artifact.backend, 'cdp-surface');
  assert.equal(artifact.mode, 'frames');
  assert.deepEqual(artifact.actorRoles, ['owner', 'peer']);
  assert.ok(artifact.durationMs > 0);
  assert.ok(artifact.frames.length >= 4, `Expected >= 4 captured frames, got ${artifact.frames.length}`);
  assert.equal(artifact.frames[0].tMs, 0);

  // Verify raw/capture.json matches returned artifact
  const captureJsonPath = path.join(outDir, 'raw', 'capture.json');
  assert.ok(fs.existsSync(captureJsonPath), 'Expected raw/capture.json to be written');
  const persisted = JSON.parse(fs.readFileSync(captureJsonPath, 'utf8'));
  assert.equal(persisted.frames.length, artifact.frames.length);

  // Verify strictly monotonic tMs and <idx>-<role>.png naming
  for (let i = 0; i < artifact.frames.length; i += 1) {
    const frame = artifact.frames[i];
    if (i > 0) {
      assert.ok(
        frame.tMs > artifact.frames[i - 1].tMs,
        `Expected strictly monotonic tMs at frame ${i}: ${frame.tMs} <= ${artifact.frames[i - 1].tMs}`,
      );
    }
    for (const role of ['owner', 'peer']) {
      const filePath = frame.files[role];
      assert.ok(fs.existsSync(filePath), `Missing PNG file ${filePath}`);
      assert.equal(path.dirname(filePath), path.join(outDir, 'frames'));
      assert.match(path.basename(filePath), new RegExp(`^\\d+-${role}\\.png$`));
    }
  }

  // Parse PNGs using pure-Node zlib IHDR/IDAT parser to verify 1800x1350 (2x) dimensions and animation
  const loadedFrame = artifact.frames.find((f) => f.mark === 'loaded');
  const lastFrame = artifact.frames[artifact.frames.length - 1];
  assert.ok(loadedFrame, 'Expected frame marked "loaded"');

  const ownerLoadedPng = parsePng(fs.readFileSync(loadedFrame.files.owner));
  const ownerLastPng = parsePng(fs.readFileSync(lastFrame.files.owner));
  const peerLastPng = parsePng(fs.readFileSync(lastFrame.files.peer));

  assert.equal(ownerLoadedPng.width, DEFAULT_PHYSICAL_SIZE.width);
  assert.equal(ownerLoadedPng.height, DEFAULT_PHYSICAL_SIZE.height);
  assert.equal(ownerLastPng.width, 1800);
  assert.equal(ownerLastPng.height, 1350);
  assert.equal(peerLastPng.width, 1800);
  assert.equal(peerLastPng.height, 1350);

  assert.ok(countSampledColors(ownerLastPng) >= 3, 'Expected non-blank owner frame');
  assert.ok(countSampledColors(peerLastPng) >= 3, 'Expected non-blank peer frame');
  assert.notEqual(
    Buffer.compare(ownerLoadedPng.pixels, ownerLastPng.pixels),
    0,
    'Expected animated owner frames to differ over time',
  );
  assert.notEqual(
    Buffer.compare(ownerLastPng.pixels, peerLastPng.pixels),
    0,
    'Expected owner and peer frames to render distinct pages',
  );
});

const linuxTools = probeSystemTools();
const canRunX11Test =
  process.platform === 'linux' && Boolean(linuxTools.xvfbPath) && Boolean(linuxTools.ffmpegPath);

test(
  'X11XvfbBackend captures dual-actor 2x video, verifies via ffprobe/ffmpeg crop, and cleans up all processes',
  { skip: !canRunX11Test },
  async (t) => {
    const outDir = makeTempDir('pyric-x11-capture-');
    t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

    const { chromium } = await loadPlaywright({ projectDir: REPO_ROOT });
    const executablePath = resolveChromiumExecutable(chromium);
    const backend = new X11XvfbBackend();

    const session = await backend.start({
      actors: {
        owner: { uid: 'alice', name: 'Alice' },
        peer: { uid: 'mallory', name: 'Mallory' },
      },
      outputDir: outDir,
      viewport: DEFAULT_VIEWPORT_DIP,
      dpr: DEFAULT_DPR,
      fps: 30,
      chromium,
      executablePath,
    });

    const displayNum = Number(session.display.slice(1));
    assert.ok(Number.isInteger(displayNum) && displayNum >= 91 && displayNum <= 199);

    const ownerUrl = buildAnimatedActorDataUrl({
      role: 'owner',
      bgHex: '#0f172a',
      accentHex: '#22d3ee',
      badgeText: 'Alice Session',
    });
    const peerUrl = buildAnimatedActorDataUrl({
      role: 'peer',
      bgHex: '#2a0a18',
      accentHex: '#fb7185',
      badgeText: 'Mallory Reproduce',
    });

    await Promise.all([
      session.pages.owner.goto(ownerUrl, { waitUntil: 'load' }),
      session.pages.peer.goto(peerUrl, { waitUntil: 'load' }),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 450));
    await backend.mark('repro-write');
    await new Promise((resolve) => setTimeout(resolve, 350));

    const artifact = await backend.stop();
    // Idempotent second dispose() call
    await backend.dispose();

    assert.equal(artifact.schema, RAW_CAPTURE_SCHEMA);
    assert.equal(artifact.backend, 'x11-xvfb');
    assert.equal(artifact.mode, 'video');
    assert.deepEqual(artifact.actorRoles, ['owner', 'peer']);
    assert.equal(artifact.fps, 30);
    assert.ok(artifact.durationMs > 0);
    assert.deepEqual(artifact.cropRects.owner, { x: 20, y: 20, width: 1800, height: 1350 });
    assert.deepEqual(artifact.cropRects.peer, { x: 1860, y: 20, width: 1800, height: 1350 });
    assert.ok(
      artifact.packetTimestampsMs.length >= 2,
      `Expected >= 2 packet timestamps, got ${artifact.packetTimestampsMs.length}`,
    );

    for (let i = 1; i < artifact.packetTimestampsMs.length; i += 1) {
      assert.ok(
        artifact.packetTimestampsMs[i] >= artifact.packetTimestampsMs[i - 1],
        'Expected non-decreasing packetTimestampsMs',
      );
    }

    assert.ok(fs.existsSync(artifact.videoPath), `Expected capture video at ${artifact.videoPath}`);
    const captureJsonPath = path.join(outDir, 'raw', 'capture.json');
    assert.ok(fs.existsSync(captureJsonPath), 'Expected raw/capture.json on disk');

    // Verify video stream with ffprobe
    const probeJson = execFileSync(
      linuxTools.ffprobePath,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', artifact.videoPath],
      { encoding: 'utf8' },
    );
    const probeData = JSON.parse(probeJson);
    assert.equal(probeData.streams.length, 1);
    assert.equal(probeData.streams[0].codec_type, 'video');
    assert.equal(probeData.streams[0].width, 3700);
    assert.equal(probeData.streams[0].height, 1400);

    // Extract cropped 1800x1350 frames for owner and peer via ffmpeg and verify non-blank content
    const ownerCropPngPath = path.join(outDir, 'owner-crop.png');
    const peerCropPngPath = path.join(outDir, 'peer-crop.png');

    const extractSec = ((artifact.durationMs * 0.55) / 1000).toFixed(3);
    execFileSync(
      linuxTools.ffmpegPath,
      ['-y', '-loglevel', 'error', '-ss', extractSec, '-i', artifact.videoPath, '-vf', 'crop=1800:1350:20:20', '-frames:v', '1', ownerCropPngPath],
      { stdio: 'pipe' },
    );
    execFileSync(
      linuxTools.ffmpegPath,
      ['-y', '-loglevel', 'error', '-ss', extractSec, '-i', artifact.videoPath, '-vf', 'crop=1800:1350:1860:20', '-frames:v', '1', peerCropPngPath],
      { stdio: 'pipe' },
    );

    const ownerPng = parsePng(fs.readFileSync(ownerCropPngPath));
    const peerPng = parsePng(fs.readFileSync(peerCropPngPath));

    assert.equal(ownerPng.width, 1800);
    assert.equal(ownerPng.height, 1350);
    assert.equal(peerPng.width, 1800);
    assert.equal(peerPng.height, 1350);
    assert.ok(countSampledColors(ownerPng) >= 3, 'Expected non-blank cropped owner frame');
    assert.ok(countSampledColors(peerPng) >= 3, 'Expected non-blank cropped peer frame');
    assert.notEqual(
      Buffer.compare(ownerPng.pixels, peerPng.pixels),
      0,
      'Expected cropped owner and peer regions to differ',
    );

    // Verify zero lingering Xvfb, ffmpeg, or browser processes from this capture run
    assert.equal(fs.existsSync(`/tmp/.X${displayNum}-lock`), false, 'Expected Xvfb lock file removed');
    assert.equal(
      fs.existsSync(`/tmp/.X11-unix/X${displayNum}`),
      false,
      'Expected Xvfb socket removed',
    );

    const psOut = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    const lines = psOut.split('\n');
    const lingeringXvfb = lines.filter((line) => line.includes(`Xvfb :${displayNum} `));
    const lingeringFfmpeg = lines.filter(
      (line) => line.includes('ffmpeg') && line.includes(outDir),
    );
    const lingeringChrome = lines.filter((line) => line.includes(outDir));

    assert.equal(lingeringXvfb.length, 0, `Found lingering Xvfb: ${lingeringXvfb.join('; ')}`);
    assert.equal(lingeringFfmpeg.length, 0, `Found lingering ffmpeg: ${lingeringFfmpeg.join('; ')}`);
    assert.equal(lingeringChrome.length, 0, `Found lingering browser processes: ${lingeringChrome.join('; ')}`);
  },
);

test(
  'X11XvfbBackend.dispose() cleans up all processes idempotently when called without stop()',
  { skip: !canRunX11Test },
  async (t) => {
    const outDir = makeTempDir('pyric-x11-dispose-');
    t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

    const { chromium } = await loadPlaywright({ projectDir: REPO_ROOT });
    const executablePath = resolveChromiumExecutable(chromium);
    const backend = new X11XvfbBackend();

    const session = await backend.start({
      actors: { owner: { uid: 'alice', name: 'Alice' } },
      outputDir: outDir,
      chromium,
      executablePath,
    });
    const displayNum = Number(session.display.slice(1));

    await Promise.all([backend.dispose(), backend.dispose()]);

    assert.equal(fs.existsSync(`/tmp/.X${displayNum}-lock`), false);
    assert.equal(fs.existsSync(`/tmp/.X11-unix/X${displayNum}`), false);

    const psOut = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    const lines = psOut.split('\n');
    assert.equal(lines.filter((line) => line.includes(`Xvfb :${displayNum} `)).length, 0);
    assert.equal(lines.filter((line) => line.includes(outDir)).length, 0);
  },
);
