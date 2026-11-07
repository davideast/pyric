/**
 * macOS AVFoundation screen-recording CaptureBackend.
 * Probes AVFoundation screen devices, launches separate headed Chromium windows side-by-side,
 * records video via ffmpeg -f avfoundation, and extracts packet timestamps via ffprobe.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  DEFAULT_DPR,
  DEFAULT_VIEWPORT_DIP,
  RAW_CAPTURE_SCHEMA,
  validateRawCapture,
} from '../contracts.mjs';
import {
  RuntimeMissingError,
  loadPlaywright,
  probeSystemTools,
  resolveChromiumExecutable,
} from '../runtime.mjs';
import {
  computeActorWindowLayout,
  normalizeActorEntries,
  probeVideoPacketTimestamps,
  stopFfmpegProcess,
  waitForFfmpegCaptureReady,
  withTimeout,
} from './backend.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse `ffmpeg -f avfoundation -list_devices true -i ""` output for a Capture screen device.
 */
export function parseAvfoundationScreenDevice(deviceListOutput) {
  if (typeof deviceListOutput !== 'string' || deviceListOutput.length === 0) {
    return null;
  }
  const match = /\[(\d+)\]\s+(Capture screen(?:\s+\d+)?)/i.exec(deviceListOutput);
  if (!match) {
    return null;
  }
  return {
    index: match[1],
    name: match[2],
  };
}

/**
 * Build pure ffmpeg CLI arguments for macOS AVFoundation screen capture.
 */
export function buildAvfoundationCaptureArgs({
  screenDeviceIndex = 'Capture screen 0',
  fps = 30,
  outputPath,
}) {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`buildAvfoundationCaptureArgs requires a positive finite fps (got ${fps})`);
  }
  if (typeof outputPath !== 'string' || outputPath.trim().length === 0) {
    throw new Error('buildAvfoundationCaptureArgs requires a non-empty outputPath');
  }
  const deviceStr = String(screenDeviceIndex ?? '').trim();
  if (deviceStr.length === 0) {
    throw new Error('buildAvfoundationCaptureArgs requires a non-empty screenDeviceIndex');
  }

  return [
    '-y',
    '-f',
    'avfoundation',
    '-framerate',
    String(fps),
    '-i',
    deviceStr,
    '-c:v',
    'libx264rgb',
    '-crf',
    '0',
    '-preset',
    'ultrafast',
    outputPath,
  ];
}

export class MacOSAvfoundationBackend {
  constructor({ platform = process.platform } = {}) {
    this.name = 'macos-avfoundation';
    this.platform = platform;
    this._started = false;
    this._stopped = false;
    this._stoppedArtifact = null;
    this._disposePromise = null;
    this._ffmpegProc = null;
    this._contexts = [];
    this._tickTimer = null;
    this._sampledTimestampsMs = [];
    this._marks = [];
    this._t0 = 0;
    this._signalCleanup = null;
  }

  async start({
    actors,
    outputDir,
    viewport = DEFAULT_VIEWPORT_DIP,
    dpr = DEFAULT_DPR,
    fps = 30,
    chromium,
    executablePath,
    env = process.env,
  }) {
    if (this._started) {
      throw new Error('MacOSAvfoundationBackend.start() cannot be called more than once on the same instance');
    }
    if (!outputDir || typeof outputDir !== 'string') {
      throw new Error('MacOSAvfoundationBackend.start() requires a non-empty outputDir');
    }

    const tools = probeSystemTools({ platform: this.platform, env });
    if (!tools.ffmpegPath) {
      throw new RuntimeMissingError(
        'VIDEO_FFMPEG_MISSING',
        'ffmpeg is required for macos-avfoundation capture backend.',
        'Install ffmpeg (e.g. `brew install ffmpeg`) or select CdpSurfaceBackend (`--backend cdp`).',
      );
    }

    const deviceProbe = spawnSync(
      tools.ffmpegPath,
      ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { env, stdio: 'pipe', encoding: 'utf8', timeout: 5000 },
    );
    const probeOutput = `${deviceProbe.stdout ?? ''}\n${deviceProbe.stderr ?? ''}`;
    const screenDevice = parseAvfoundationScreenDevice(probeOutput);
    if (!screenDevice) {
      throw new RuntimeMissingError(
        'MACOS_TCC_DENIED',
        'macOS Screen Recording permission (TCC) is absent or no "Capture screen" AVFoundation device was found.',
        'Grant Screen Recording permission in System Settings -> Privacy & Security -> Screen Recording, or use CdpSurfaceBackend (`--backend cdp`).',
      );
    }

    const actorEntries = normalizeActorEntries(actors);
    const { layouts } = computeActorWindowLayout(actorEntries, viewport, dpr);

    let resolvedChromium = chromium;
    if (!resolvedChromium) {
      const pw = await loadPlaywright({ env });
      resolvedChromium = pw.chromium;
    }

    const resolvedExecutable =
      executablePath ?? resolveChromiumExecutable(resolvedChromium, { platform: this.platform, env });
    if (!resolvedExecutable) {
      throw new RuntimeMissingError(
        'VIDEO_CHROMIUM_MISSING',
        'No Chromium executable found for macOS AVFoundation capture.',
        'Run `doctor.mjs --install` or install Google Chrome.',
      );
    }

    const resolvedOutputDir = path.resolve(outputDir);
    const rawDir = path.join(resolvedOutputDir, 'raw');
    const profilesDir = path.join(rawDir, 'profiles');
    const videoPath = path.join(rawDir, 'capture.mkv');
    fs.mkdirSync(profilesDir, { recursive: true });

    this._started = true;
    this._outputDir = resolvedOutputDir;
    this._rawDir = rawDir;
    this._videoPath = videoPath;
    this._fps = fps;
    this._ffprobePath = tools.ffprobePath;
    this._actorRoles = layouts.map((item) => item.role);
    this._cropRects = Object.fromEntries(layouts.map((item) => [item.role, item.cropRect]));
    this._marks = [];
    this._sampledTimestampsMs = [];

    this._registerProcessCleanup();

    try {
      const actorHandles = {};
      const pages = {};
      const contexts = {};

      for (const item of layouts) {
        const userDataDir = path.join(profilesDir, item.role);
        fs.mkdirSync(userDataDir, { recursive: true });

        const launchArgs = [
          `--force-device-scale-factor=${dpr}`,
          `--window-size=${viewport.width},${viewport.height}`,
          `--window-position=${item.posX},${item.posY}`,
          '--app=about:blank',
          '--no-first-run',
          '--no-default-browser-check',
        ];

        const context = await resolvedChromium.launchPersistentContext(userDataDir, {
          headless: false,
          executablePath: resolvedExecutable,
          env,
          viewport: null,
          ignoreDefaultArgs: ['--enable-automation'],
          args: launchArgs,
        });
        this._contexts.push(context);

        const page = context.pages()[0] ?? (await context.newPage());
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            }),
        );

        pages[item.role] = page;
        contexts[item.role] = context;
        actorHandles[item.role] = {
          role: item.role,
          page,
          context,
          cropRect: item.cropRect,
          userDataDir,
        };
      }

      await sleep(150);

      let ffmpegStderr = '';
      const ffmpegArgs = buildAvfoundationCaptureArgs({
        screenDeviceIndex: screenDevice.index,
        fps,
        outputPath: videoPath,
      });

      this._ffmpegProc = spawn(tools.ffmpegPath, ffmpegArgs, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (this._ffmpegProc.stderr) {
        this._ffmpegProc.stderr.on('data', (chunk) => {
          ffmpegStderr = (ffmpegStderr + chunk.toString('utf8')).slice(-8192);
        });
      }

      await waitForFfmpegCaptureReady(this._ffmpegProc, videoPath, () => ffmpegStderr);

      this._t0 = performance.now();
      this._sampledTimestampsMs = [0];
      const tickIntervalMs = Math.max(10, Math.round(1000 / fps));
      this._tickTimer = setInterval(() => {
        const elapsed = Math.max(0, Math.round((performance.now() - this._t0) * 1000) / 1000);
        const prev = this._sampledTimestampsMs[this._sampledTimestampsMs.length - 1] ?? 0;
        this._sampledTimestampsMs.push(elapsed > prev ? elapsed : prev + 0.001);
      }, tickIntervalMs);
      if (typeof this._tickTimer.unref === 'function') {
        this._tickTimer.unref();
      }

      return {
        backend: this.name,
        platform: this.platform,
        screenDevice,
        outputDir: resolvedOutputDir,
        rawDir,
        videoPath,
        viewport,
        dpr,
        fps,
        pages,
        contexts,
        actors: actorHandles,
      };
    } catch (err) {
      await this.dispose();
      throw err;
    }
  }

  async mark(label) {
    if (!this._started || this._stopped) {
      throw new Error('MacOSAvfoundationBackend.mark() requires an active capture session');
    }
    const tMs = Math.max(0, Math.round((performance.now() - this._t0) * 1000) / 1000);
    const entry = { label: String(label), tMs };
    this._marks.push(entry);
    return entry;
  }

  async stop() {
    if (!this._started) {
      throw new Error('Cannot stop MacOSAvfoundationBackend before start()');
    }
    if (this._stopped && this._stoppedArtifact) {
      return this._stoppedArtifact;
    }
    this._stopped = true;

    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }

    try {
      await stopFfmpegProcess(this._ffmpegProc);

      if (!fs.existsSync(this._videoPath) || fs.statSync(this._videoPath).size === 0) {
        throw new Error(`macOS AVFoundation capture produced no video output at ${this._videoPath}`);
      }

      const packetTimestampsMs = probeVideoPacketTimestamps({
        ffprobePath: this._ffprobePath,
        videoPath: this._videoPath,
        fallbackTimestampsMs: this._sampledTimestampsMs,
      });

      const lastPacketMs = packetTimestampsMs[packetTimestampsMs.length - 1] ?? 0;
      const elapsedMs = Math.round((performance.now() - this._t0) * 1000) / 1000;
      const frameStepMs = Math.round((1000 / this._fps) * 1000) / 1000;
      const durationMs = Math.max(elapsedMs, lastPacketMs + frameStepMs, 1);

      const artifact = validateRawCapture({
        schema: RAW_CAPTURE_SCHEMA,
        backend: this.name,
        platform: this.platform,
        actorRoles: this._actorRoles,
        durationMs,
        mode: 'video',
        videoPath: this._videoPath,
        fps: this._fps,
        cropRects: this._cropRects,
        packetTimestampsMs,
        marks: [...this._marks],
      });

      const captureJsonPath = path.join(this._rawDir, 'capture.json');
      fs.writeFileSync(captureJsonPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
      this._stoppedArtifact = artifact;
      return artifact;
    } finally {
      await this.dispose();
    }
  }

  _registerProcessCleanup() {
    if (this._signalCleanup) return;

    const onExit = () => {
      if (this._ffmpegProc && this._ffmpegProc.exitCode === null && this._ffmpegProc.signalCode === null) {
        try {
          process.kill(this._ffmpegProc.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    };

    const onSignal = (signal) => {
      onExit();
      void this.dispose();
      if (process.listenerCount(signal) === 1) {
        process.off(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };

    process.on('exit', onExit);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    this._signalCleanup = () => {
      process.off('exit', onExit);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
  }

  async dispose() {
    if (this._disposePromise) {
      return this._disposePromise;
    }

    this._disposePromise = (async () => {
      if (this._tickTimer) {
        clearInterval(this._tickTimer);
        this._tickTimer = null;
      }

      if (this._signalCleanup) {
        this._signalCleanup();
        this._signalCleanup = null;
      }

      await stopFfmpegProcess(this._ffmpegProc);
      this._ffmpegProc = null;

      const contexts = this._contexts.splice(0);
      await Promise.allSettled(contexts.map((ctx) => withTimeout(ctx.close(), 3000)));
    })();

    return this._disposePromise;
  }
}
