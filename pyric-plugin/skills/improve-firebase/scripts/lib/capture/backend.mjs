/**
 * CaptureBackend base class, platform backend selection, and shared capture utilities.
 * Zero external runtime dependencies; Playwright is loaded dynamically only when capturing.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  CAPTURE_BACKENDS,
  DEFAULT_DPR,
  DEFAULT_VIEWPORT_DIP,
} from '../contracts.mjs';
import { probeSystemTools } from '../runtime.mjs';
import { X11XvfbBackend } from './x11-xvfb.mjs';
import { MacOSAvfoundationBackend } from './macos-avfoundation.mjs';
import { CdpSurfaceBackend } from './cdp-surface.mjs';

export class CaptureBackend {
  constructor({ name, platform = process.platform } = {}) {
    if (name !== undefined && !CAPTURE_BACKENDS.includes(name)) {
      throw new Error(`Invalid CaptureBackend name "${name}". Expected one of: ${CAPTURE_BACKENDS.join(', ')}`);
    }
    this.name = name;
    this.platform = platform;
  }

  async start(_options) {
    throw new Error(`${this.constructor.name}.start() is not implemented`);
  }

  async mark(_label) {
    throw new Error(`${this.constructor.name}.mark() is not implemented`);
  }

  async stop() {
    throw new Error(`${this.constructor.name}.stop() is not implemented`);
  }

  async dispose() {
    // Subclasses override to guarantee idempotent resource cleanup.
  }
}

for (const BackendClass of [X11XvfbBackend, MacOSAvfoundationBackend, CdpSurfaceBackend]) {
  if (!(BackendClass.prototype instanceof CaptureBackend)) {
    Object.setPrototypeOf(BackendClass.prototype, CaptureBackend.prototype);
    Object.setPrototypeOf(BackendClass, CaptureBackend);
  }
}

/**
 * Select the appropriate CaptureBackend for the current or target platform.
 */
export function selectCaptureBackend({
  backend = 'auto',
  platform = process.platform,
  env = process.env,
  tools,
} = {}) {
  if (typeof backend !== 'string' || backend.trim().length === 0) {
    throw new Error(
      `Unknown capture backend ${JSON.stringify(backend)}. Expected "auto", "x11-xvfb" ("x11"), "macos-avfoundation" ("avfoundation"), or "cdp-surface" ("cdp").`,
    );
  }

  const normalized = backend.trim().toLowerCase();

  if (normalized === 'x11' || normalized === 'x11-xvfb') {
    return new X11XvfbBackend({ platform });
  }
  if (normalized === 'avfoundation' || normalized === 'macos-avfoundation') {
    return new MacOSAvfoundationBackend({ platform });
  }
  if (normalized === 'cdp' || normalized === 'cdp-surface') {
    return new CdpSurfaceBackend({ platform });
  }
  if (normalized !== 'auto') {
    throw new Error(
      `Unknown capture backend "${backend}". Expected "auto", "x11-xvfb" ("x11"), "macos-avfoundation" ("avfoundation"), or "cdp-surface" ("cdp").`,
    );
  }

  const resolvedTools = tools ?? probeSystemTools({ platform, env });

  if (platform === 'linux') {
    if (resolvedTools.xvfbPath && resolvedTools.ffmpegPath) {
      return new X11XvfbBackend({ platform });
    }
    return new CdpSurfaceBackend({ platform });
  }

  if (platform === 'darwin') {
    if (resolvedTools.avfoundationAvailable && resolvedTools.ffmpegPath) {
      return new MacOSAvfoundationBackend({ platform });
    }
    return new CdpSurfaceBackend({ platform });
  }

  return new CdpSurfaceBackend({ platform });
}

/**
 * Normalize an actor map (`{ victim: {...}, attacker: {...} }`) or array into ordered entries.
 */
export function normalizeActorEntries(actors) {
  if (!actors) {
    throw new Error('CaptureBackend.start() requires an actors object or array');
  }

  const entries = [];
  const seenRoles = new Set();

  if (Array.isArray(actors)) {
    for (const item of actors) {
      if (typeof item === 'string') {
        const role = item.trim();
        if (!role) {
          throw new Error('Actor role string must not be empty');
        }
        if (seenRoles.has(role)) {
          throw new Error(`Duplicate actor role "${role}"`);
        }
        seenRoles.add(role);
        entries.push({ role });
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        const role = typeof item.role === 'string' ? item.role.trim() : '';
        if (!role) {
          throw new Error('Each actor object in array must include a non-empty role');
        }
        if (seenRoles.has(role)) {
          throw new Error(`Duplicate actor role "${role}"`);
        }
        seenRoles.add(role);
        entries.push({ ...item, role });
      } else {
        throw new Error('Each actor entry must be a role string or object');
      }
    }
  } else if (typeof actors === 'object') {
    for (const [rawRole, config] of Object.entries(actors)) {
      if (config == null) continue;
      if (typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`Actor "${rawRole}" must be an object`);
      }
      const role = rawRole.trim();
      if (!role) {
        throw new Error('Actor role key must not be empty');
      }
      if (seenRoles.has(role)) {
        throw new Error(`Duplicate actor role "${role}"`);
      }
      seenRoles.add(role);
      entries.push({ ...config, role });
    }
  } else {
    throw new Error('actors must be an object mapping roles or an array of actor entries');
  }

  if (entries.length === 0) {
    throw new Error('CaptureBackend.start() requires at least one actor');
  }

  return entries;
}

function evenCeil(value) {
  const rounded = Math.ceil(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/**
 * Compute DIP window positions and physical pixel cropRects for side-by-side actor capture.
 * Places `victim` at (10, 10) DIP and `attacker` at (930, 10) DIP for default 900x675 viewports.
 */
export function computeActorWindowLayout(
  actorEntries,
  viewport = DEFAULT_VIEWPORT_DIP,
  dpr = DEFAULT_DPR,
) {
  const marginDip = 10;
  const gapDip = 20;

  const hasVictim = actorEntries.some((entry) => entry.role === 'victim');
  const hasAttacker = actorEntries.some((entry) => entry.role === 'attacker');

  const usedSlots = new Set();
  if (hasVictim) usedSlots.add(0);
  if (hasAttacker) usedSlots.add(1);

  let nextDynamicSlot = 0;
  function allocateSlot(role) {
    if (role === 'victim') return 0;
    if (role === 'attacker') return 1;
    while (usedSlots.has(nextDynamicSlot)) {
      nextDynamicSlot += 1;
    }
    const slot = nextDynamicSlot;
    usedSlots.add(slot);
    return slot;
  }

  const physicalWidth = Math.round(viewport.width * dpr);
  const physicalHeight = Math.round(viewport.height * dpr);

  const layouts = actorEntries.map((entry) => {
    const slot = allocateSlot(entry.role);
    const posX = marginDip + slot * (viewport.width + gapDip);
    const posY = marginDip;
    const cropRect = {
      x: Math.round(posX * dpr),
      y: Math.round(posY * dpr),
      width: physicalWidth,
      height: physicalHeight,
    };
    return {
      ...entry,
      slot,
      posX,
      posY,
      cropRect,
    };
  });

  const maxRightPx = Math.max(...layouts.map((item) => item.cropRect.x + item.cropRect.width));
  const maxBottomPx = Math.max(...layouts.map((item) => item.cropRect.y + item.cropRect.height));

  const grabWidth = Math.max(3700, evenCeil(maxRightPx + 20));
  const grabHeight = Math.max(1400, evenCeil(maxBottomPx + 20));
  const screenWidth = Math.max(3720, grabWidth + 20);
  const screenHeight = Math.max(1440, grabHeight + 40);

  return {
    layouts,
    grabWidth,
    grabHeight,
    screenWidth,
    screenHeight,
  };
}

/**
 * Race a promise against a timeout and always clear the timer when settled.
 */
export function withTimeout(promise, ms) {
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

/**
 * Wait until ffmpeg has initialized capture (output bytes written or ready banner on stderr),
 * failing fast if ffmpeg exits prematurely.
 */
export async function waitForFfmpegCaptureReady(ffmpegProc, videoPath, getStderr) {
  let exited = false;
  let exitCode = null;
  let exitSignal = null;

  const onExit = (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  };
  ffmpegProc.once('exit', onExit);

  try {
    const deadline = Date.now() + 4000;
    while (!exited && Date.now() < deadline) {
      const stderrText = getStderr();
      const hasFileBytes = fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0;
      if (hasFileBytes || /Press \[q\] to stop/i.test(stderrText)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (exited) {
      throw new Error(
        `ffmpeg exited prematurely (code=${exitCode}, signal=${exitSignal}): ${getStderr().trim()}`,
      );
    }
  } finally {
    ffmpegProc.off('exit', onExit);
  }
}

/**
 * Gracefully stop a running ffmpeg child process via 'q' on stdin, escalating to SIGINT/SIGKILL.
 */
export function stopFfmpegProcess(ffmpegProc) {
  if (!ffmpegProc || ffmpegProc.exitCode !== null || ffmpegProc.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(sigintTimer);
      clearTimeout(sigkillTimer);
      resolve();
    };

    ffmpegProc.once('close', finish);

    const sigintTimer = setTimeout(() => {
      try {
        if (ffmpegProc.exitCode === null && ffmpegProc.signalCode === null) {
          ffmpegProc.kill('SIGINT');
        }
      } catch {
        // ignore if already exited
      }
    }, 3000);
    if (typeof sigintTimer.unref === 'function') {
      sigintTimer.unref();
    }

    const sigkillTimer = setTimeout(() => {
      try {
        if (ffmpegProc.exitCode === null && ffmpegProc.signalCode === null) {
          ffmpegProc.kill('SIGKILL');
        }
      } catch {
        // ignore if already exited
      }
      finish();
    }, 5500);
    if (typeof sigkillTimer.unref === 'function') {
      sigkillTimer.unref();
    }

    try {
      if (ffmpegProc.stdin && !ffmpegProc.stdin.destroyed) {
        ffmpegProc.stdin.write('q\n');
        ffmpegProc.stdin.end();
      } else {
        ffmpegProc.kill('SIGINT');
      }
    } catch {
      try {
        ffmpegProc.kill('SIGINT');
      } catch {
        finish();
      }
    }
  });
}

/**
 * Probe recorded video packet timestamps in milliseconds via ffprobe.
 */
export function probeVideoPacketTimestamps({ ffprobePath, videoPath, fallbackTimestampsMs = [] }) {
  if (ffprobePath) {
    try {
      const stdout = execFileSync(
        ffprobePath,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'packet=pts_time,dts_time',
          '-of',
          'json',
          videoPath,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parsed = JSON.parse(stdout);
      const packets = Array.isArray(parsed?.packets) ? parsed.packets : [];
      const timestamps = [];
      let prevMs = -1;
      for (const pkt of packets) {
        const rawSec = pkt.pts_time ?? pkt.dts_time;
        const sec = Number(rawSec);
        if (!Number.isFinite(sec)) continue;
        const ms = Math.max(0, Math.round(sec * 1000000) / 1000);
        const monotonicMs = ms >= prevMs ? ms : prevMs;
        timestamps.push(monotonicMs);
        prevMs = monotonicMs;
      }
      if (timestamps.length > 0) {
        return timestamps;
      }
    } catch {
      // Fall through to fallback timestamps if ffprobe fails on partial stream
    }
  }

  if (fallbackTimestampsMs.length > 0) {
    return fallbackTimestampsMs;
  }

  return [0];
}

export { X11XvfbBackend, MacOSAvfoundationBackend, CdpSurfaceBackend };
