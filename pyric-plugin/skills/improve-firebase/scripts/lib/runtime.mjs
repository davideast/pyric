/**
 * Isolated Playwright, Chromium, ffmpeg, and Xvfb runtime resolution for Pyric video scripts.
 * Never modifies @pyric/cli or the target application's package.json/lockfile.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export class RuntimeMissingError extends Error {
  constructor(code, message, remediation) {
    super(message);
    this.name = 'RuntimeMissingError';
    this.code = code;
    this.remediation = remediation;
  }
}

export function getVideoRuntimeDir(env = process.env) {
  if (env.PYRIC_VIDEO_RUNTIME_DIR && env.PYRIC_VIDEO_RUNTIME_DIR.trim().length > 0) {
    return path.resolve(env.PYRIC_VIDEO_RUNTIME_DIR.trim());
  }
  return path.join(os.homedir(), '.pyric', 'video-runtime');
}

function tryLoadFromPackageJson(pkgJsonPath) {
  if (!fs.existsSync(pkgJsonPath)) return null;
  const req = createRequire(pkgJsonPath);
  for (const candidate of ['playwright-core', 'playwright']) {
    try {
      const resolved = req.resolve(candidate);
      return {
        entryPath: resolved,
        source: `project (${path.dirname(pkgJsonPath)})`,
      };
    } catch {
      // keep trying
    }
  }
  try {
    const pwTestPkg = req.resolve('@playwright/test/package.json');
    const innerReq = createRequire(pwTestPkg);
    const resolved = innerReq.resolve('playwright-core');
    return {
      entryPath: resolved,
      source: `project @playwright/test (${path.dirname(pkgJsonPath)})`,
    };
  } catch {
    return null;
  }
}

/**
 * Search upward from `projectDir` (and immediate workspace packages if present)
 * for an existing `playwright-core` installation before touching `~/.pyric/video-runtime`.
 */
export function findProjectPlaywright(projectDir = process.cwd()) {
  let current = path.resolve(projectDir);
  const visited = new Set();

  while (!visited.has(current)) {
    visited.add(current);
    const direct = tryLoadFromPackageJson(path.join(current, 'package.json'));
    if (direct) return direct;

    // Monorepo convenience (e.g. packages/*/package.json)
    const packagesDir = path.join(current, 'packages');
    if (fs.existsSync(packagesDir) && fs.statSync(packagesDir).isDirectory()) {
      for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = tryLoadFromPackageJson(path.join(packagesDir, entry.name, 'package.json'));
        if (sub) return sub;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Find `playwright-core` inside `~/.pyric/video-runtime` (or `PYRIC_VIDEO_RUNTIME_DIR`).
 */
export function findCachedPlaywright(env = process.env) {
  const runtimeDir = getVideoRuntimeDir(env);
  const pkgPath = path.join(runtimeDir, 'package.json');
  const direct = tryLoadFromPackageJson(pkgPath);
  if (direct) {
    return {
      ...direct,
      source: `cache (${runtimeDir})`,
      runtimeDir,
    };
  }
  const indexMjs = path.join(runtimeDir, 'node_modules', 'playwright-core', 'index.mjs');
  if (fs.existsSync(indexMjs)) {
    return {
      entryPath: indexMjs,
      source: `cache (${runtimeDir})`,
      runtimeDir,
    };
  }
  return null;
}

/**
 * Install `playwright-core` and Chromium into `~/.pyric/video-runtime` on demand.
 */
export function installVideoRuntime({ env = process.env, skipBrowser = false, log = () => {} } = {}) {
  const runtimeDir = getVideoRuntimeDir(env);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const pkgPath = path.join(runtimeDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(
      pkgPath,
      JSON.stringify(
        {
          name: 'pyric-video-runtime',
          private: true,
          description: 'Isolated Playwright + Chromium runtime for Pyric security video skills',
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }

  log(`Installing playwright-core into ${runtimeDir}...`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', 'playwright-core@^1.61.0'], {
    cwd: runtimeDir,
    env,
    stdio: 'inherit',
  });

  if (!skipBrowser) {
    const cliJs = path.join(runtimeDir, 'node_modules', 'playwright-core', 'cli.js');
    if (!fs.existsSync(cliJs)) {
      throw new RuntimeMissingError(
        'VIDEO_RUNTIME_CORRUPT',
        `playwright-core CLI missing at ${cliJs} after npm install`,
        `Remove ${runtimeDir} and re-run doctor.mjs --install`,
      );
    }
    log('Installing Chromium browser into isolated Playwright cache...');
    execFileSync(process.execPath, [cliJs, 'install', 'chromium'], {
      cwd: runtimeDir,
      env,
      stdio: 'inherit',
    });
  }

  const found = findCachedPlaywright(env);
  if (!found) {
    throw new RuntimeMissingError(
      'VIDEO_RUNTIME_MISSING',
      `Failed to resolve playwright-core in ${runtimeDir} after installation.`,
      `Inspect ${runtimeDir} and retry.`,
    );
  }
  return found;
}

/**
 * Resolve and import `playwright-core`, optionally installing it into `~/.pyric/video-runtime`.
 */
export async function loadPlaywright({
  projectDir = process.cwd(),
  install = false,
  env = process.env,
  log = () => {},
} = {}) {
  let located = findProjectPlaywright(projectDir) ?? findCachedPlaywright(env);

  if (!located && install) {
    located = installVideoRuntime({ env, log });
  }

  if (!located) {
    const runtimeDir = getVideoRuntimeDir(env);
    throw new RuntimeMissingError(
      'VIDEO_PLAYWRIGHT_MISSING',
      `playwright-core is not installed in "${projectDir}" or "${runtimeDir}".`,
      `Run \`doctor.mjs --install\` (installs isolated runtime in ${runtimeDir}) or \`npm i -D playwright-core && npx playwright install chromium\`.`,
    );
  }

  const mod = await import(pathToFileURL(located.entryPath).href);
  const pw = mod.default?.chromium ? mod.default : mod;
  if (!pw?.chromium) {
    throw new RuntimeMissingError(
      'VIDEO_PLAYWRIGHT_INVALID',
      `Loaded module from ${located.entryPath} does not export chromium.`,
      `Re-run \`doctor.mjs --install\`.`,
    );
  }

  return {
    chromium: pw.chromium,
    source: located.source,
    entryPath: located.entryPath,
  };
}

/**
 * Resolve a working Chromium/Chrome binary path from Playwright's cache or system installs.
 */
export function resolveChromiumExecutable(chromium, { platform = process.platform, env = process.env } = {}) {
  if (env.PYRIC_CHROMIUM_PATH && fs.existsSync(env.PYRIC_CHROMIUM_PATH)) {
    return env.PYRIC_CHROMIUM_PATH;
  }

  if (chromium && typeof chromium.executablePath === 'function') {
    try {
      const pwPath = chromium.executablePath();
      if (pwPath && fs.existsSync(pwPath)) {
        return pwPath;
      }
    } catch {
      // fall back to system candidates
    }
  }

  const systemCandidates =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ];

  for (const candidate of systemCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function commandExists(cmd, env = process.env) {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(whichCmd, [cmd], { env, stdio: 'pipe', encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim().split('\n')[0] : null;
}

/**
 * Probe OS media tools (`ffmpeg`, `ffprobe`, `Xvfb`, macOS `avfoundation`).
 */
export function probeSystemTools({ platform = process.platform, env = process.env } = {}) {
  const ffmpegPath = commandExists('ffmpeg', env);
  const ffprobePath = commandExists('ffprobe', env);
  const xvfbPath = platform === 'linux' ? commandExists('Xvfb', env) : null;

  let avfoundationAvailable = false;
  if (platform === 'darwin' && ffmpegPath) {
    const probe = spawnSync(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { env, stdio: 'pipe', encoding: 'utf8', timeout: 5000 },
    );
    const combined = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
    avfoundationAvailable = /Capture screen/i.test(combined);
  }

  return {
    platform,
    ffmpegPath,
    ffprobePath,
    xvfbPath,
    avfoundationAvailable,
  };
}
