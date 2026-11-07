/**
 * Linux X11 + Xvfb + x11grab CaptureBackend.
 * Spawns an isolated virtual X11 display, launches headed Chromium windows side-by-side,
 * records lossless H.264 RGB video via ffmpeg, and extracts packet timestamps via ffprobe.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

function isDisplaySlotTaken(displayNum) {
  const lockPath = `/tmp/.X${displayNum}-lock`;
  const socketPath = `/tmp/.X11-unix/X${displayNum}`;
  return fs.existsSync(lockPath) || fs.existsSync(socketPath);
}

async function allocateAndStartXvfb({ xvfbPath, screenWidth, screenHeight }) {
  const screenSpec = `${screenWidth}x${screenHeight}x24`;
  let lastError = null;

  for (let displayNum = 91; displayNum <= 199; displayNum += 1) {
    if (isDisplaySlotTaken(displayNum)) {
      continue;
    }

    const socketPath = `/tmp/.X11-unix/X${displayNum}`;
    const lockPath = `/tmp/.X${displayNum}-lock`;
    let stderr = '';
    const proc = spawn(
      xvfbPath,
      [`:${displayNum}`, '-nocursor', '-screen', '0', screenSpec, '-ac', '+extension', 'RANDR'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4096);
      });
    }

    let exitedEarly = false;
    let exitCode = null;
    proc.once('exit', (code) => {
      exitedEarly = true;
      exitCode = code;
    });

    const deadline = Date.now() + 4000;
    while (!exitedEarly && Date.now() < deadline) {
      if (fs.existsSync(socketPath)) {
        return { displayNum, proc, socketPath, lockPath };
      }
      await sleep(20);
    }

    if (!exitedEarly) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      throw new Error(`Timed out waiting for Xvfb :${displayNum} socket at ${socketPath}`);
    }

    lastError = new Error(
      `Xvfb :${displayNum} exited early with code ${exitCode}: ${stderr.trim() || 'unknown error'}`,
    );
  }

  throw lastError ?? new Error('No free X11 display slot found between :91 and :199');
}

function buildCleanX11Env(baseEnv, displayNum) {
  const x11Env = { ...baseEnv };
  delete x11Env.WAYLAND_DISPLAY;
  delete x11Env.XDG_SESSION_TYPE;
  x11Env.DISPLAY = `:${displayNum}`;
  return x11Env;
}

async function terminateProcess(proc, { lockPath, socketPath } = {}) {
  if (!proc) return;

  if (proc.exitCode === null && proc.signalCode === null) {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };

      proc.once('close', done);

      const killTimer = setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL');
          }
        } catch {
          // ignore
        }
        done();
      }, 2500);

      try {
        proc.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  // Only remove lock/socket if Xvfb had to be force-killed and left stale files.
  for (const filePath of [socketPath, lockPath]) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore if already removed
      }
    }
  }
}

export class X11XvfbBackend {
  constructor({ platform = process.platform } = {}) {
    this.name = 'x11-xvfb';
    this.platform = platform;
    this._started = false;
    this._stopped = false;
    this._stoppedArtifact = null;
    this._disposePromise = null;
    this._xvfb = null;
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
      throw new Error('X11XvfbBackend.start() cannot be called more than once on the same instance');
    }
    if (!outputDir || typeof outputDir !== 'string') {
      throw new Error('X11XvfbBackend.start() requires a non-empty outputDir');
    }

    const tools = probeSystemTools({ platform: this.platform, env });
    if (!tools.xvfbPath) {
      throw new RuntimeMissingError(
        'VIDEO_XVFB_MISSING',
        'Xvfb is required for x11-xvfb capture backend.',
        'Install Xvfb (e.g. `sudo apt-get install xvfb`) or select `cdp-surface` backend.',
      );
    }
    if (!tools.ffmpegPath) {
      throw new RuntimeMissingError(
        'VIDEO_FFMPEG_MISSING',
        'ffmpeg is required for x11-xvfb capture backend.',
        'Install ffmpeg or select `cdp-surface` backend.',
      );
    }

    const actorEntries = normalizeActorEntries(actors);
    const {
      layouts,
      grabWidth,
      grabHeight,
      screenWidth,
      screenHeight,
    } = computeActorWindowLayout(actorEntries, viewport, dpr);

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
        'No Chromium executable found for X11 capture.',
        'Run `doctor.mjs --install` to install Chromium into ~/.pyric/video-runtime.',
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
      this._xvfb = await allocateAndStartXvfb({
        xvfbPath: tools.xvfbPath,
        screenWidth,
        screenHeight,
      });

      const x11Env = buildCleanX11Env(env, this._xvfb.displayNum);
      const actorHandles = {};
      const pages = {};
      const contexts = {};

      for (const item of layouts) {
        const userDataDir = path.join(profilesDir, item.role);
        fs.mkdirSync(userDataDir, { recursive: true });

        const launchArgs = [
          '--ozone-platform=x11',
          '--disable-gpu',
          `--force-device-scale-factor=${dpr}`,
          `--window-size=${viewport.width},${viewport.height}`,
          `--window-position=${item.posX},${item.posY}`,
          '--app=data:text/html,<html><body style="margin:0;background:%230a0c10"></body></html>',
          '--test-type',
          '--no-first-run',
          '--no-default-browser-check',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu-sandbox',
          '--use-gl=angle',
          '--use-angle=swiftshader-webgl',
          '--enable-webgl',
          '--ignore-gpu-blocklist',
        ];

        const context = await resolvedChromium.launchPersistentContext(userDataDir, {
          headless: false,
          executablePath: resolvedExecutable,
          env: x11Env,
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

      // Brief warmup tick so X11 window geometry settles before x11grab starts.
      await sleep(150);

      let ffmpegStderr = '';
      const ffmpegArgs = [
        '-y',
        '-draw_mouse',
        '0',
        '-f',
        'x11grab',
        '-framerate',
        String(fps),
        '-video_size',
        `${grabWidth}x${grabHeight}`,
        '-i',
        `:${this._xvfb.displayNum}.0+0,0`,
        '-c:v',
        'libx264rgb',
        '-crf',
        '0',
        '-preset',
        'ultrafast',
        videoPath,
      ];

      this._ffmpegProc = spawn(tools.ffmpegPath, ffmpegArgs, {
        env: x11Env,
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
        display: `:${this._xvfb.displayNum}`,
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
      throw new Error('X11XvfbBackend.mark() requires an active capture session');
    }
    const tMs = Math.max(0, Math.round((performance.now() - this._t0) * 1000) / 1000);
    const entry = { label: String(label), tMs };
    this._marks.push(entry);
    return entry;
  }

  async stop() {
    if (!this._started) {
      throw new Error('Cannot stop X11XvfbBackend before start()');
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
        throw new Error(`X11 capture produced no video output at ${this._videoPath}`);
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
      for (const proc of [this._ffmpegProc, this._xvfb?.proc]) {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          try {
            process.kill(proc.pid, 'SIGKILL');
          } catch {
            // ignore
          }
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

      if (this._xvfb) {
        const xvfb = this._xvfb;
        this._xvfb = null;
        await terminateProcess(xvfb.proc, {
          lockPath: xvfb.lockPath,
          socketPath: xvfb.socketPath,
        });
      }
    })();

    return this._disposePromise;
  }
}
