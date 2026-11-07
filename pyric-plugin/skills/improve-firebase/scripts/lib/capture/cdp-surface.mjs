/**
 * Cross-platform CDP Surface CaptureBackend.
 * Launches one dedicated headless Chromium process per actor, attaches a CDP session,
 * and captures DPR-scaled PNG frames via Page.captureScreenshot.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DPR,
  DEFAULT_VIEWPORT_DIP,
  RAW_CAPTURE_SCHEMA,
  validateRawCapture,
} from '../contracts.mjs';
import {
  RuntimeMissingError,
  loadPlaywright,
  resolveChromiumExecutable,
} from '../runtime.mjs';
import { normalizeActorEntries, withTimeout } from './backend.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CdpSurfaceBackend {
  constructor({ platform = process.platform } = {}) {
    this.name = 'cdp-surface';
    this.platform = platform;
    this._started = false;
    this._stopped = false;
    this._stoppedArtifact = null;
    this._disposePromise = null;
    this._loopActive = false;
    this._acceptingCaptures = false;
    this._loopTimer = null;
    this._captureQueue = Promise.resolve();
    this._actorSessions = [];
    this._frames = [];
    this._marks = [];
    this._nextIndex = 0;
    this._t0 = 0;
    this._signalCleanup = null;
  }

  async start({
    actors,
    outputDir,
    viewport = DEFAULT_VIEWPORT_DIP,
    dpr = DEFAULT_DPR,
    targetHz = 20,
    chromium,
    executablePath,
    env = process.env,
  }) {
    if (this._started) {
      throw new Error('CdpSurfaceBackend.start() cannot be called more than once on the same instance');
    }
    if (!outputDir || typeof outputDir !== 'string') {
      throw new Error('CdpSurfaceBackend.start() requires a non-empty outputDir');
    }
    if (typeof targetHz !== 'number' || !Number.isFinite(targetHz) || targetHz <= 0) {
      throw new Error(`CdpSurfaceBackend.start() requires a positive finite targetHz (got ${targetHz})`);
    }

    const actorEntries = normalizeActorEntries(actors);

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
        'No Chromium executable found for CDP surface capture.',
        'Run `doctor.mjs --install` to install Chromium into ~/.pyric/video-runtime.',
      );
    }

    const resolvedOutputDir = path.resolve(outputDir);
    const framesDir = path.join(resolvedOutputDir, 'frames');
    const rawDir = path.join(resolvedOutputDir, 'raw');
    fs.mkdirSync(framesDir, { recursive: true });
    fs.mkdirSync(rawDir, { recursive: true });

    this._started = true;
    this._outputDir = resolvedOutputDir;
    this._framesDir = framesDir;
    this._rawDir = rawDir;
    this._viewport = { width: viewport.width, height: viewport.height };
    this._dpr = dpr;
    this._targetHz = targetHz;
    this._actorRoles = actorEntries.map((item) => item.role);
    this._frames = [];
    this._marks = [];
    this._nextIndex = 0;

    this._registerProcessCleanup();

    try {
      const launchArgs = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
      ];

      const pages = {};
      const contexts = {};
      const actorHandles = {};

      for (const entry of actorEntries) {
        const browser = await resolvedChromium.launch({
          headless: true,
          executablePath: resolvedExecutable,
          args: launchArgs,
        });

        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: dpr,
        });

        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);

        this._actorSessions.push({
          role: entry.role,
          browser,
          context,
          page,
          cdp,
        });

        pages[entry.role] = page;
        contexts[entry.role] = context;
        actorHandles[entry.role] = {
          role: entry.role,
          browser,
          context,
          page,
          cdp,
        };
      }

      this._acceptingCaptures = true;
      this._loopActive = true;
      this._paused = false;

      // Capture immediate baseline frame at tMs = 0.
      await this._enqueueCapture();

      this._scheduleNextLoopTick();

      return {
        backend: this.name,
        platform: this.platform,
        outputDir: resolvedOutputDir,
        framesDir,
        rawDir,
        viewport: this._viewport,
        dpr,
        targetHz,
        pages,
        contexts,
        actors: actorHandles,
        captureNow: () => this.captureNow(),
      };
    } catch (err) {
      await this.dispose();
      throw err;
    }
  }

  _computeNextTimestampMs(idx) {
    if (idx === 0) {
      this._t0 = performance.now();
      return 0;
    }
    const rawT = Math.max(0, Math.round((performance.now() - this._t0) * 1000) / 1000);
    const prevT = this._frames.length > 0 ? this._frames[this._frames.length - 1].tMs : 0;
    if (rawT > prevT) {
      return rawT;
    }
    return Math.round((prevT + 0.001) * 1000) / 1000;
  }

  async pause() {
    this._paused = true;
    await withTimeout(Promise.resolve(this._captureQueue), 2500, 'CdpSurfaceBackend.pause').catch(
      () => {},
    );
  }

  async resume() {
    this._paused = false;
    if (this._started && !this._stopped && this._acceptingCaptures) {
      await this._enqueueCapture().catch(() => {});
    }
  }

  _enqueueCapture({ label } = {}) {
    const runCapture = async () => {
      if (!this._acceptingCaptures) {
        return null;
      }
      if (this._paused && label === undefined) {
        return null;
      }

      const screenshots = await Promise.all(
        this._actorSessions.map(async (session) => {
          try {
            const result = await withTimeout(
              session.cdp.send('Page.captureScreenshot', {
                format: 'png',
                optimizeForSpeed: true,
                clip: {
                  x: 0,
                  y: 0,
                  width: this._viewport.width,
                  height: this._viewport.height,
                  scale: this._dpr,
                },
              }),
              2000,
              'Page.captureScreenshot',
            );
            const buf = Buffer.from(result.data, 'base64');
            session.lastPngBuffer = buf;
            return { role: session.role, buf };
          } catch (err) {
            if (session.lastPngBuffer) {
              return { role: session.role, buf: session.lastPngBuffer };
            }
            throw err;
          }
        }),
      );

      if (!this._acceptingCaptures) {
        return null;
      }

      const idx = this._nextIndex;
      this._nextIndex += 1;
      const tMs = this._computeNextTimestampMs(idx);

      const files = {};
      const prefix = String(idx).padStart(4, '0');
      for (const shot of screenshots) {
        const filePath = path.join(this._framesDir, `${prefix}-${shot.role}.png`);
        fs.writeFileSync(filePath, shot.buf);
        files[shot.role] = filePath;
      }

      const frameRecord = { tMs, files };
      if (label !== undefined) {
        frameRecord.mark = String(label);
        this._marks.push({ label: String(label), tMs, frameIndex: idx });
      }
      this._frames.push(frameRecord);
      return frameRecord;
    };

    const nextPromise = this._captureQueue.then(runCapture, runCapture);
    this._captureQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  _scheduleNextLoopTick(delayMs) {
    if (!this._loopActive) return;

    const intervalMs = Math.max(10, Math.round(1000 / this._targetHz));
    const waitMs = delayMs ?? intervalMs;

    this._loopTimer = setTimeout(async () => {
      if (!this._loopActive) return;
      const tickStart = performance.now();
      try {
        await this._enqueueCapture();
      } catch {
        // Ignore transient frame errors if teardown has started
      }
      if (!this._loopActive) return;
      const elapsed = performance.now() - tickStart;
      const nextDelayMs = Math.max(0, Math.round(intervalMs - elapsed));
      this._scheduleNextLoopTick(nextDelayMs);
    }, waitMs);

    if (typeof this._loopTimer.unref === 'function') {
      this._loopTimer.unref();
    }
  }

  async captureNow() {
    if (!this._started || this._stopped || !this._acceptingCaptures) {
      throw new Error('CdpSurfaceBackend.captureNow() requires an active capture session');
    }
    return this._enqueueCapture();
  }

  async mark(label) {
    if (!this._started || this._stopped || !this._acceptingCaptures) {
      throw new Error('CdpSurfaceBackend.mark() requires an active capture session');
    }
    return this._enqueueCapture({ label });
  }

  async stop() {
    if (!this._started) {
      throw new Error('Cannot stop CdpSurfaceBackend before start()');
    }
    if (this._stopped && this._stoppedArtifact) {
      return this._stoppedArtifact;
    }
    this._stopped = true;
    this._loopActive = false;
    this._paused = false;

    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = null;
    }

    try {
      await withTimeout(Promise.resolve(this._captureQueue), 5000, 'CdpSurfaceBackend.stop').catch(
        () => {},
      );

      // Capture final frame so the latest page state at stop() is always included.
      if (this._acceptingCaptures) {
        await this._enqueueCapture().catch(() => {});
      }
      this._acceptingCaptures = false;

      const lastFrame = this._frames[this._frames.length - 1];
      const elapsedMs = Math.round((performance.now() - this._t0) * 1000) / 1000;
      const durationMs = Math.max(elapsedMs, lastFrame ? lastFrame.tMs + 1 : 1, 1);

      const artifact = validateRawCapture({
        schema: RAW_CAPTURE_SCHEMA,
        backend: this.name,
        platform: this.platform,
        actorRoles: this._actorRoles,
        durationMs,
        mode: 'frames',
        frames: this._frames,
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

    const onSignal = (signal) => {
      this._loopActive = false;
      this._acceptingCaptures = false;
      void this.dispose();
      if (process.listenerCount(signal) === 1) {
        process.off(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    this._signalCleanup = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
  }

  async dispose() {
    if (this._disposePromise) {
      return this._disposePromise;
    }

    this._disposePromise = (async () => {
      this._loopActive = false;
      this._acceptingCaptures = false;

      if (this._loopTimer) {
        clearTimeout(this._loopTimer);
        this._loopTimer = null;
      }

      if (this._signalCleanup) {
        this._signalCleanup();
        this._signalCleanup = null;
      }

      await withTimeout(this._captureQueue, 1500);

      const sessions = this._actorSessions.splice(0);
      await Promise.allSettled(
        sessions.map(async (session) => {
          try {
            await withTimeout(session.cdp.detach(), 500);
          } catch {
            // ignore
          }
          try {
            await withTimeout(session.context.close(), 1500);
          } catch {
            // ignore
          }
          try {
            await withTimeout(session.browser.close(), 2000);
          } catch {
            // ignore
          }
        }),
      );
    })();

    return this._disposePromise;
  }
}
