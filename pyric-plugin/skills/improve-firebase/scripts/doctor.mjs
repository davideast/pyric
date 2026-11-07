#!/usr/bin/env node
/**
 * Environment diagnostic and runtime bootstrap CLI for Pyric security-audit video capture.
 * Checks Node >=22.15, Playwright, Chromium, ffmpeg/ffprobe/Xvfb/AVFoundation, and CaptureBackend selection.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  findCachedPlaywright,
  findProjectPlaywright,
  getVideoRuntimeDir,
  installVideoRuntime,
  loadPlaywright,
  probeSystemTools,
  resolveChromiumExecutable,
} from './lib/runtime.mjs';
import { selectCaptureBackend } from './lib/capture/backend.mjs';

function isNodeVersionSupported(versionStr) {
  const parts = String(versionStr ?? '').split('.');
  const major = Number(parts[0] ?? 0);
  const minor = Number(parts[1] ?? 0);
  if (major > 22) return true;
  if (major === 22 && minor >= 15) return true;
  return false;
}

function formatHelp() {
  return [
    'Usage: doctor.mjs [options]',
    '',
    'Options:',
    '  --install            Install isolated playwright-core + Chromium into ~/.pyric/video-runtime if missing',
    '  --backend <name>     Target capture backend: auto | x11 | avfoundation | cdp (default: auto)',
    '  --project <dir>      Project directory to search for existing playwright-core (default: cwd)',
    '  --json               Emit structured JSON report',
    '  -h, --help           Show this help text',
  ].join('\n');
}

/**
 * Run environment checks and optional runtime bootstrap, returning a structured diagnostic report.
 */
export async function runDoctor({
  install = false,
  backend = 'auto',
  projectDir = process.cwd(),
  platform = process.platform,
  env = process.env,
  log = () => {},
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const runtimeDir = getVideoRuntimeDir(env);
  const issues = [];

  const nodeOk = isNodeVersionSupported(process.versions.node);
  if (!nodeOk) {
    issues.push({
      code: 'NODE_VERSION_TOO_OLD',
      message: `Node.js ${process.versions.node} detected; >= 22.15.0 is required.`,
      remediation: 'Upgrade Node.js to v22.15.0 or newer.',
    });
  }

  const tools = probeSystemTools({ platform, env });
  if (!tools.ffmpegPath) {
    issues.push({
      code: 'VIDEO_FFMPEG_MISSING',
      message: 'ffmpeg executable was not found on PATH.',
      remediation:
        platform === 'darwin'
          ? 'Install ffmpeg via Homebrew: `brew install ffmpeg`.'
          : 'Install ffmpeg via your package manager (e.g., `sudo apt-get install -y ffmpeg`).',
    });
  }

  let selectedBackend = null;
  try {
    selectedBackend = selectCaptureBackend({ backend, platform, env, tools });
  } catch (err) {
    issues.push({
      code: 'CAPTURE_BACKEND_INVALID',
      message: err.message,
      remediation: 'Pass `--backend auto`, `x11`, `avfoundation`, or `cdp`.',
    });
  }

  if (selectedBackend?.name === 'x11-xvfb' && !tools.xvfbPath) {
    issues.push({
      code: 'VIDEO_XVFB_MISSING',
      message: 'Explicit x11-xvfb backend requested, but Xvfb was not found on PATH.',
      remediation: 'Install Xvfb (`sudo apt-get install -y xvfb`) or use `--backend cdp` / `--backend auto`.',
    });
  }

  if (selectedBackend?.name === 'macos-avfoundation' && !tools.avfoundationAvailable) {
    issues.push({
      code: 'MACOS_TCC_DENIED',
      message: 'Explicit macos-avfoundation backend requested, but Screen Recording TCC permission or device is unavailable.',
      remediation:
        'Grant Screen Recording permission in System Settings -> Privacy & Security -> Screen Recording, or use `--backend cdp` / `--backend auto`.',
    });
  }

  let pwLocation = findProjectPlaywright(resolvedProjectDir) ?? findCachedPlaywright(env);
  if (!pwLocation && install) {
    pwLocation = installVideoRuntime({ env, log });
  }

  let chromiumPath = null;
  if (pwLocation) {
    try {
      const loaded = await loadPlaywright({ projectDir: resolvedProjectDir, env });
      chromiumPath = resolveChromiumExecutable(loaded.chromium, { platform, env });

      if (!chromiumPath && install) {
        pwLocation = installVideoRuntime({ env, log });
        const reloaded = await loadPlaywright({ projectDir: resolvedProjectDir, env });
        chromiumPath = resolveChromiumExecutable(reloaded.chromium, { platform, env });
      }

      if (!chromiumPath) {
        issues.push({
          code: 'VIDEO_CHROMIUM_MISSING',
          message: `playwright-core was found (${pwLocation.source}), but no Chromium browser binary is installed.`,
          remediation: `Run \`doctor.mjs --install\` (installs Chromium into ${runtimeDir}) or \`npx playwright install chromium\`.`,
        });
      }
    } catch (err) {
      issues.push({
        code: err.code ?? 'VIDEO_PLAYWRIGHT_INVALID',
        message: err.message,
        remediation: err.remediation ?? `Re-run \`doctor.mjs --install\`.`,
      });
    }
  } else {
    chromiumPath = resolveChromiumExecutable(null, { platform, env });
    issues.push({
      code: 'VIDEO_PLAYWRIGHT_MISSING',
      message: `playwright-core is not installed in "${resolvedProjectDir}" or "${runtimeDir}".`,
      remediation: `Run \`doctor.mjs --install\` (bootstraps ${runtimeDir}) or \`npm i -D playwright-core && npx playwright install chromium\`.`,
    });
  }

  const ok = issues.length === 0;

  return {
    ok,
    ready: ok,
    platform,
    arch: process.arch,
    projectDir: resolvedProjectDir,
    node: {
      version: process.versions.node,
      required: '>=22.15.0',
      ok: nodeOk,
    },
    backend: {
      requested: backend,
      selected: selectedBackend ? selectedBackend.name : null,
    },
    playwright: {
      ok: Boolean(pwLocation),
      source: pwLocation?.source ?? null,
      entryPath: pwLocation?.entryPath ?? null,
      runtimeDir,
    },
    chromium: {
      ok: Boolean(chromiumPath),
      executablePath: chromiumPath ?? null,
    },
    tools: {
      ffmpeg: tools.ffmpegPath,
      ffprobe: tools.ffprobePath,
      xvfb: tools.xvfbPath,
      avfoundationAvailable: tools.avfoundationAvailable,
    },
    issues,
  };
}

function printHumanReport(report) {
  const mark = (flag) => (flag ? 'OK' : 'MISSING');
  console.log(`Pyric Video Capture Doctor (${report.platform}/${report.arch})`);
  console.log(`  Node.js:          ${report.node.version} [${mark(report.node.ok)}]`);
  console.log(
    `  Playwright:       ${report.playwright.ok ? report.playwright.source : 'not found'} [${mark(report.playwright.ok)}]`,
  );
  console.log(
    `  Chromium:         ${report.chromium.executablePath ?? 'not found'} [${mark(report.chromium.ok)}]`,
  );
  console.log(`  ffmpeg:           ${report.tools.ffmpeg ?? 'not found'} [${mark(Boolean(report.tools.ffmpeg))}]`);
  console.log(`  ffprobe:          ${report.tools.ffprobe ?? 'not found'} [${mark(Boolean(report.tools.ffprobe))}]`);
  if (report.platform === 'linux') {
    console.log(`  Xvfb:             ${report.tools.xvfb ?? 'not found'} [${mark(Boolean(report.tools.xvfb))}]`);
  }
  if (report.platform === 'darwin') {
    console.log(
      `  AVFoundation TCC: ${report.tools.avfoundationAvailable ? 'granted' : 'unavailable'} [${mark(report.tools.avfoundationAvailable)}]`,
    );
  }
  console.log(`  Capture Backend:  ${report.backend.selected ?? 'none'} (requested: ${report.backend.requested})`);

  if (report.issues.length > 0) {
    console.error('\nActionable Fixes:');
    for (const issue of report.issues) {
      console.error(`  - [${issue.code}] ${issue.message}`);
      console.error(`    Fix: ${issue.remediation}`);
    }
  } else {
    console.log('\nStatus: READY');
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        install: { type: 'boolean', default: false },
        backend: { type: 'string', default: 'auto' },
        json: { type: 'boolean', default: false },
        project: { type: 'string', default: process.cwd() },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error(formatHelp());
    process.exitCode = 1;
    return;
  }

  const { values } = parsed;
  if (values.help) {
    console.log(formatHelp());
    return;
  }

  const report = await runDoctor({
    install: values.install,
    backend: values.backend,
    projectDir: values.project,
    log: values.json ? console.error : console.log,
  });

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  process.exitCode = report.ok ? 0 : 1;
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
