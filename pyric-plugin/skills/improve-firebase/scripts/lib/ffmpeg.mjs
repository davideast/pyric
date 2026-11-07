/**
 * FFmpeg & FFprobe wrappers for extracting actor crops, piping lossless PNG frames
 * into H.264 MP4, generating palette-optimized preview GIFs, and probing media streams.
 * Zero external dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function runProcessCapture(binPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        const suffix = signal ? ` (signal ${signal})` : '';
        const err = new Error(`${path.basename(binPath)} exited with code ${code}${suffix}: ${stderr.trim()}`);
        err.code = code;
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function buildRoleCropFilter(rect) {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w === 1800 && h === 1350) {
    return `crop=1800:1350:${x}:${y}`;
  }
  return `crop=${w}:${h}:${x}:${y},scale=1800:1350:flags=lanczos`;
}

/**
 * Extract 2x (1800x1350) lossless PNGs for each actor role from a captured video
 * into `outputDir/<role>/frame-%05d.png` and return `{ frames: [{ tMs, files }] }`.
 */
export async function extractActorFramesFromVideo({
  ffmpegPath = 'ffmpeg',
  videoPath,
  cropRects,
  outputDir,
  fps = 30,
  packetTimestampsMs,
}) {
  const entries = Object.entries(cropRects || {});
  if (entries.length === 0) {
    throw new Error('extractActorFramesFromVideo requires at least one entry in cropRects');
  }

  for (const [role] of entries) {
    const roleDir = path.join(outputDir, role);
    fs.rmSync(roleDir, { recursive: true, force: true });
    fs.mkdirSync(roleDir, { recursive: true });
  }

  const hasPacketTimestamps = Array.isArray(packetTimestampsMs) && packetTimestampsMs.length > 0;
  const args = ['-y', '-i', videoPath];

  if (entries.length === 1) {
    const [role, rect] = entries[0];
    const cropChain = buildRoleCropFilter(rect);
    const vf = hasPacketTimestamps ? cropChain : `fps=${fps},${cropChain}`;
    args.push('-vf', vf);
    if (hasPacketTimestamps) {
      args.push('-fps_mode', 'passthrough');
    }
    args.push('-compression_level', '0', '-pix_fmt', 'rgb24', path.join(outputDir, role, 'frame-%05d.png'));
  } else {
    const splitOutputs = entries.map(([role]) => `[src_${role}]`).join('');
    const preamble = hasPacketTimestamps
      ? `[0:v]split=${entries.length}${splitOutputs}`
      : `[0:v]fps=${fps},split=${entries.length}${splitOutputs}`;
    const chains = entries.map(([role, rect]) => `[src_${role}]${buildRoleCropFilter(rect)}[out_${role}]`);
    const filterComplex = [preamble, ...chains].join(';');

    args.push('-filter_complex', filterComplex);
    for (const [role] of entries) {
      args.push('-map', `[out_${role}]`);
      if (hasPacketTimestamps) {
        args.push('-fps_mode', 'passthrough');
      }
      args.push('-compression_level', '0', '-pix_fmt', 'rgb24', path.join(outputDir, role, 'frame-%05d.png'));
    }
  }

  await runProcessCapture(ffmpegPath, args);

  const roleFiles = {};
  let maxCount = 0;

  for (const [role] of entries) {
    const roleDir = path.join(outputDir, role);
    const pngNames = fs
      .readdirSync(roleDir)
      .filter((name) => /^frame-\d+\.png$/i.test(name))
      .sort();
    roleFiles[role] = pngNames.map((name) => path.join(roleDir, name));
    if (roleFiles[role].length > maxCount) {
      maxCount = roleFiles[role].length;
    }
  }

  if (maxCount === 0) {
    throw new Error(`ffmpeg extracted 0 frames from ${videoPath}`);
  }

  const frames = [];
  for (let i = 0; i < maxCount; i++) {
    let tMs;
    if (hasPacketTimestamps) {
      if (i < packetTimestampsMs.length) {
        tMs = packetTimestampsMs[i];
      } else {
        const lastTs = packetTimestampsMs[packetTimestampsMs.length - 1];
        tMs = lastTs + ((i - packetTimestampsMs.length + 1) * 1000) / fps;
      }
    } else {
      tMs = (i * 1000) / fps;
    }

    const files = {};
    for (const [role] of entries) {
      const list = roleFiles[role];
      const clampedIdx = Math.min(i, list.length - 1);
      files[role] = list[clampedIdx];
    }

    frames.push({ tMs, files });
  }

  return { frames };
}

/**
 * Spawn an ffmpeg image2pipe PNG -> libx264 MP4 encoder with backpressure handling
 * and full stderr capture on non-zero exit.
 */
export function createH264PipeEncoder({
  ffmpegPath = 'ffmpeg',
  width,
  height,
  fps = 30,
  outMp4Path,
}) {
  if (typeof width === 'number' && (width % 2 !== 0 || width <= 0)) {
    throw new Error(`H.264 yuv420p requires a positive even width (got ${width})`);
  }
  if (typeof height === 'number' && (height % 2 !== 0 || height <= 0)) {
    throw new Error(`H.264 yuv420p requires a positive even height (got ${height})`);
  }

  fs.mkdirSync(path.dirname(outMp4Path), { recursive: true });

  const args = [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-r', String(fps),
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-tune', 'stillimage',
    '-threads', '0',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outMp4Path,
  ];

  const child = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  const stderrChunks = [];
  let spawnError = null;
  let exitResult = null;
  let finished = false;

  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk);
  });

  // Prevent unhandled 'error' events (e.g., EPIPE) when ffmpeg aborts early.
  child.stdin.on('error', () => {});

  const exitPromise = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      spawnError = err;
      reject(err);
    });
    child.on('close', (code, signal) => {
      exitResult = { code, signal };
      resolve(exitResult);
    });
  });

  function buildExitError(code, signal) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    const suffix = signal ? ` (signal ${signal})` : '';
    const err = new Error(`ffmpeg exited with code ${code}${suffix}: ${stderr.trim()}`);
    err.code = code;
    err.stderr = stderr;
    return err;
  }

  async function writeFrame(buffer) {
    if (finished) {
      throw new Error('Cannot call writeFrame() after finish()');
    }
    if (spawnError) {
      throw spawnError;
    }
    if (exitResult && exitResult.code !== 0) {
      throw buildExitError(exitResult.code, exitResult.signal);
    }

    const frameBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const canContinue = child.stdin.write(frameBuf);
    if (canContinue) {
      return;
    }

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        child.stdin.off('drain', onDrain);
        child.stdin.off('error', onStdinError);
        child.off('close', onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onStdinError = (err) => {
        cleanup();
        if (exitResult && exitResult.code !== 0) {
          reject(buildExitError(exitResult.code, exitResult.signal));
          return;
        }
        reject(err);
      };
      const onClose = (code, signal) => {
        cleanup();
        if (code !== 0) {
          reject(buildExitError(code, signal));
          return;
        }
        resolve();
      };

      child.stdin.on('drain', onDrain);
      child.stdin.on('error', onStdinError);
      child.on('close', onClose);
    });
  }

  async function finish() {
    if (!finished) {
      finished = true;
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
    }

    const { code, signal } = await exitPromise;
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    if (code !== 0) {
      throw buildExitError(code, signal);
    }
    return { outMp4Path, stderr };
  }

  function abort() {
    if (!finished) {
      finished = true;
      if (!child.stdin.destroyed) {
        child.stdin.destroy();
      }
      if (exitResult === null) {
        child.kill('SIGTERM');
      }
    }
  }

  return { writeFrame, finish, abort };
}

/**
 * Transcode an MP4 video into a palette-optimized preview GIF capped at `maxSeconds`.
 */
export async function transcodePreviewGif({
  ffmpegPath = 'ffmpeg',
  inputMp4Path,
  outGifPath,
  fps = 12,
  width = 960,
  maxSeconds = 8,
}) {
  fs.mkdirSync(path.dirname(outGifPath), { recursive: true });
  const vf = `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
  const args = [
    '-y',
    '-t', String(maxSeconds),
    '-i', inputMp4Path,
    '-vf', vf,
    '-loop', '0',
    outGifPath,
  ];
  await runProcessCapture(ffmpegPath, args);
  return { outGifPath };
}

function parseFrameRate(rateStr) {
  if (typeof rateStr !== 'string' || !rateStr.includes('/')) {
    return 0;
  }
  const [numStr, denStr] = rateStr.split('/');
  const num = Number(numStr);
  const den = Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return 0;
  }
  return num / den;
}

/**
 * Inspect a media file via `ffprobe` and return `{ width, height, durationSec, nbFrames, codecName }`.
 */
export async function probeMedia({ ffprobePath = 'ffprobe', mediaPath }) {
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    mediaPath,
  ];
  const { stdout } = await runProcessCapture(ffprobePath, args);
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video') || streams[0] || {};

  const width = Number(videoStream.width) || 0;
  const height = Number(videoStream.height) || 0;
  const codecName = typeof videoStream.codec_name === 'string' ? videoStream.codec_name : null;

  const rawDuration = videoStream.duration ?? parsed.format?.duration;
  const durationSec = rawDuration !== undefined ? Number(rawDuration) : 0;

  let nbFrames = 0;
  if (videoStream.nb_frames !== undefined) {
    nbFrames = Number(videoStream.nb_frames);
  } else if (videoStream.nb_read_frames !== undefined) {
    nbFrames = Number(videoStream.nb_read_frames);
  } else if (durationSec > 0) {
    const fps = parseFrameRate(videoStream.avg_frame_rate) || parseFrameRate(videoStream.r_frame_rate);
    if (fps > 0) {
      nbFrames = Math.round(durationSec * fps);
    }
  }

  return {
    width,
    height,
    durationSec,
    nbFrames,
    codecName,
  };
}
