import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ASSURANCE_EXPORT_SCHEMA, ContractValidationError } from './contracts.mjs';
import { normalizeServiceName } from './op-snippet.mjs';

const LOG_RING_LIMIT = 200;

function appendRing(ring, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  for (const line of lines) {
    ring.push(line);
    if (ring.length > LOG_RING_LIMIT) {
      ring.shift();
    }
  }
}

function commandExistsInPath(binName) {
  const res = spawnSync('which', [binName], { encoding: 'utf8' });
  if (res.status === 0 && typeof res.stdout === 'string') {
    const first = res.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) {
      return first;
    }
  }
  return null;
}

function resolveExecutableSpec(rawPath) {
  if (!rawPath) return null;
  const resolved = path.resolve(rawPath);
  if (!fs.existsSync(resolved)) return null;
  if (resolved.endsWith('.ts') || resolved.endsWith('.mts')) {
    const bunPath = commandExistsInPath('bun');
    if (!bunPath) return null;
    return { command: bunPath, args: [resolved], path: resolved, kind: 'bun-ts' };
  }
  if (resolved.endsWith('.js') || resolved.endsWith('.mjs') || resolved.endsWith('.cjs')) {
    return { command: process.execPath, args: [resolved], path: resolved, kind: 'node-js' };
  }
  return { command: resolved, args: [], path: resolved, kind: 'binary' };
}

function findRepoRootCandidate(startDir) {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    const distCli = path.join(cursor, 'packages', 'cli', 'dist', 'cli', 'index.js');
    const srcCli = path.join(cursor, 'packages', 'cli', 'src', 'cli', 'index.ts');
    if (fs.existsSync(distCli)) {
      return resolveExecutableSpec(distCli);
    }
    if (fs.existsSync(srcCli)) {
      const spec = resolveExecutableSpec(srcCli);
      if (spec) return spec;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/**
 * Locates the Pyric CLI executable across environment overrides, monorepo workspace,
 * local node_modules, and system PATH.
 *
 * @param {string} [projectDir]
 * @returns {{ command: string, args: string[], path: string, kind: string } | null}
 */
export function findPyricExecutable(projectDir = process.cwd()) {
  if (process.env.PYRIC_BIN) {
    const envSpec = resolveExecutableSpec(process.env.PYRIC_BIN);
    if (envSpec) return envSpec;
  }

  const baseDir = path.resolve(projectDir || process.cwd());
  const fromProject = findRepoRootCandidate(baseDir);
  if (fromProject) return fromProject;

  if (import.meta.dirname) {
    const fromModule = findRepoRootCandidate(import.meta.dirname);
    if (fromModule) return fromModule;
  }

  let cursor = baseDir;
  for (let i = 0; i < 6; i += 1) {
    const localBin = path.join(cursor, 'node_modules', '.bin', 'pyric');
    if (fs.existsSync(localBin)) {
      return { command: localBin, args: [], path: localBin, kind: 'local-bin' };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const globalBin = commandExistsInPath('pyric');
  if (globalBin) {
    return { command: globalBin, args: [], path: globalBin, kind: 'path' };
  }

  return null;
}

function normalizePyricExec(pyric, projectDir) {
  if (!pyric) {
    const found = findPyricExecutable(projectDir);
    if (!found) {
      throw new ContractValidationError(
        'Could not locate Pyric CLI executable. Build packages/cli or set PYRIC_BIN.',
      );
    }
    return found;
  }
  if (typeof pyric === 'string') {
    const resolved = resolveExecutableSpec(pyric);
    if (resolved) return resolved;
    return { command: pyric, args: [], path: pyric, kind: 'custom' };
  }
  if (typeof pyric === 'object' && typeof pyric.command === 'string') {
    return {
      command: pyric.command,
      args: Array.isArray(pyric.args) ? pyric.args : [],
      path: pyric.path || pyric.command,
      kind: pyric.kind || 'custom',
    };
  }
  throw new ContractValidationError('Invalid pyric executable descriptor');
}

/**
 * Captures a Pyric state snapshot from projectDir into outDir without mutating project state.
 *
 * @param {{ pyric?: string | object, projectDir?: string, outDir: string, force?: boolean }} options
 * @returns {{ outDir: string, exists: boolean, stateFile: string | null, exitCode: number, schema: string }}
 */
export function createSnapshot({ pyric, projectDir = process.cwd(), outDir, force = true } = {}) {
  if (!outDir || typeof outDir !== 'string') {
    throw new ContractValidationError('createSnapshot requires an outDir path');
  }
  const baseDir = path.resolve(projectDir);
  const resolvedOutDir = path.resolve(outDir);
  const exec = normalizePyricExec(pyric, baseDir);

  const args = [...exec.args, 'snapshot', '--out', resolvedOutDir];
  if (force !== false) {
    args.push('--force');
  }

  const res = spawnSync(exec.command, args, {
    cwd: baseDir,
    encoding: 'utf8',
  });

  const stateFile = path.join(resolvedOutDir, 'state.json');
  const exists = fs.existsSync(stateFile);
  const exitCode = res.status ?? (res.error ? 1 : 0);

  if (exitCode !== 0 && !exists) {
    const combined = `${res.stderr || ''}\n${res.stdout || ''}`.trim();
    const isEmptyStateRefusal = exitCode === 2 && /no persisted state|no snapshot/i.test(combined);
    if (!isEmptyStateRefusal) {
      throw new Error(
        `pyric snapshot failed (exit ${exitCode}): ${combined || res.error?.message || 'unknown error'}`,
      );
    }
  }

  return {
    outDir: resolvedOutDir,
    exists,
    stateFile: exists ? stateFile : null,
    exitCode,
    schema: ASSURANCE_EXPORT_SCHEMA,
  };
}

function findAncestorNodeModules(startDir) {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(cursor, 'node_modules');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function decodeJwtPayloadUnsafe(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeRtdbPath(rawPath) {
  const cleaned = String(rawPath ?? '').replace(/^\/+|\/+$/g, '');
  return cleaned;
}

function normalizeFirestorePath(operation, isCollection = false) {
  if (operation.path) {
    return String(operation.path).replace(/^\/+|\/+$/g, '');
  }
  if (operation.collection && operation.doc && !isCollection) {
    return `${String(operation.collection).replace(/^\/+|\/+$/g, '')}/${String(operation.doc).replace(/^\/+|\/+$/g, '')}`;
  }
  if (operation.collection) {
    return String(operation.collection).replace(/^\/+|\/+$/g, '');
  }
  if (operation.doc) {
    return String(operation.doc).replace(/^\/+|\/+$/g, '');
  }
  throw new ContractValidationError('Firestore operation requires a path or collection/doc');
}

function normalizeStoragePath(rawPath) {
  return String(rawPath ?? '').replace(/^\/+/, '');
}

function encodeUploadBase64(operation) {
  if (typeof operation.contentBase64 === 'string') {
    return operation.contentBase64;
  }
  const raw =
    operation.data !== undefined
      ? operation.data
      : operation.value !== undefined
        ? operation.value
        : '';
  if (Buffer.isBuffer(raw)) {
    return raw.toString('base64');
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString('base64');
  }
  if (typeof raw === 'string') {
    return Buffer.from(raw, 'utf8').toString('base64');
  }
  return Buffer.from(JSON.stringify(raw), 'utf8').toString('base64');
}

function parseSseOrJson(rawText, contentType) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  if (contentType && contentType.includes('text/event-stream')) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]');
    for (let i = dataLines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(dataLines[i]);
      } catch {
        // continue
      }
    }
  }
  return JSON.parse(text);
}

/**
 * Manages an ephemeral, isolated Pyric hosted sandbox running against a temporary
 * workspace directory without mutating the target project's `.pyric/` directory or rules.
 */
export class IsolatedSandbox {
  /**
   * @param {object} config
   */
  constructor(config) {
    this.url = config.url;
    this.port = config.port;
    this.uiUrl = config.uiUrl ?? null;
    this.mcpUrl = config.mcpUrl ?? `${config.url}/__pyric/mcp`;
    this.rulesHash = config.rulesHash ?? null;
    this.databaseRulesHash = config.databaseRulesHash ?? null;
    this.storageRulesHash = config.storageRulesHash ?? null;
    this.instanceId = config.instanceId;
    this.tempDir = config.tempDir;
    this.projectDir = config.projectDir;
    this.child = config.child;
    this.pid = config.child?.pid ?? null;
    this.schema = ASSURANCE_EXPORT_SCHEMA;

    this._stdoutRing = config.stdoutRing || [];
    this._stderrRing = config.stderrRing || [];
    this._tokenIdentities = new Map();
    this._knownUsers = new Set();
    this._opQueue = Promise.resolve();
    this.secondaryRtdbInstances = Array.isArray(config.secondaryRtdbInstances)
      ? config.secondaryRtdbInstances
      : [];
    this._mcpSessionId = null;
    this._mcpSeq = 0;
    this._disposed = false;
  }

  /**
   * Starts an isolated Pyric hosted sandbox in `/tmp/pyric-sandbox-<uuid>`.
   *
   * @param {object} [options]
   * @returns {Promise<IsolatedSandbox>}
   */
  static async start({
    projectDir = process.cwd(),
    projectId,
    firebaseConfigPath,
    rtdbRulesPath,
    databaseRulesPath,
    firestoreRulesPath,
    storageRulesPath,
    seedDir,
    functions = false,
    timeoutMs = 30_000,
    env = process.env,
  } = {}) {
    const baseDir = path.resolve(projectDir);
    const execInfo = findPyricExecutable(baseDir);
    if (!execInfo) {
      throw new ContractValidationError(
        `Unable to locate Pyric CLI from "${baseDir}". Build packages/cli or set PYRIC_BIN.`,
      );
    }

    const rawTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-sandbox-'));
    const tempDir = fs.realpathSync(rawTempDir);
    let child = null;

    try {
      const explicitConfigPath = firebaseConfigPath
        ? path.resolve(baseDir, firebaseConfigPath)
        : path.join(baseDir, 'firebase.json');
      const hasConfigFile = fs.existsSync(explicitConfigPath);
      const configBaseDir = hasConfigFile ? path.dirname(explicitConfigPath) : baseDir;
      const rawConfig = hasConfigFile
        ? JSON.parse(fs.readFileSync(explicitConfigPath, 'utf8'))
        : {};
      const tempConfig = structuredClone(rawConfig && typeof rawConfig === 'object' ? rawConfig : {});

      // Copy RTDB rules if configured or overridden (preserving multi-target database arrays)
      const customRtdb = rtdbRulesPath ?? databaseRulesPath;
      if (customRtdb) {
        const resolvedRtdbSrc = path.resolve(baseDir, customRtdb);
        if (!fs.existsSync(resolvedRtdbSrc)) {
          throw new ContractValidationError(`RTDB rules file not found: ${resolvedRtdbSrc}`);
        }
        fs.copyFileSync(resolvedRtdbSrc, path.join(tempDir, 'database.rules.json'));
        if (Array.isArray(rawConfig?.database)) {
          tempConfig.database = rawConfig.database.map((entry) =>
            entry && typeof entry === 'object' ? { ...entry, rules: 'database.rules.json' } : entry,
          );
        } else {
          tempConfig.database = {
            ...(typeof tempConfig.database === 'object' && tempConfig.database !== null
              ? tempConfig.database
              : {}),
            rules: 'database.rules.json',
          };
        }
      } else if (Array.isArray(rawConfig?.database)) {
        const mappedEntries = [];
        for (let idx = 0; idx < rawConfig.database.length; idx += 1) {
          const entry = rawConfig.database[idx];
          if (!entry || typeof entry !== 'object') {
            mappedEntries.push(entry);
            continue;
          }
          if (typeof entry.rules === 'string') {
            const absEntryRules = path.resolve(configBaseDir, entry.rules);
            if (fs.existsSync(absEntryRules)) {
              const targetFile = `database-${idx}.rules.json`;
              fs.copyFileSync(absEntryRules, path.join(tempDir, targetFile));
              mappedEntries.push({ ...entry, rules: targetFile });
              continue;
            }
          }
          mappedEntries.push({ ...entry });
        }
        tempConfig.database = mappedEntries;
      } else {
        const configuredRtdb =
          typeof rawConfig?.database === 'object' && rawConfig.database !== null
            ? rawConfig.database?.rules
            : undefined;
        const resolvedRtdbSrc = configuredRtdb ? path.resolve(configBaseDir, configuredRtdb) : null;
        if (resolvedRtdbSrc) {
          if (!fs.existsSync(resolvedRtdbSrc)) {
            delete tempConfig.database;
          } else {
            fs.copyFileSync(resolvedRtdbSrc, path.join(tempDir, 'database.rules.json'));
            tempConfig.database = {
              ...(typeof tempConfig.database === 'object' && tempConfig.database !== null
                ? tempConfig.database
                : {}),
              rules: 'database.rules.json',
            };
          }
        }
      }

      // Copy Firestore rules & indexes if configured or overridden
      const configuredFs =
        typeof rawConfig?.firestore === 'object' ? rawConfig.firestore?.rules : undefined;
      const resolvedFsSrc = firestoreRulesPath
        ? path.resolve(baseDir, firestoreRulesPath)
        : configuredFs
          ? path.resolve(configBaseDir, configuredFs)
          : null;
      if (resolvedFsSrc) {
        if (!fs.existsSync(resolvedFsSrc)) {
          if (firestoreRulesPath) {
            throw new ContractValidationError(`Firestore rules file not found: ${resolvedFsSrc}`);
          }
          delete tempConfig.firestore;
        } else {
          fs.copyFileSync(resolvedFsSrc, path.join(tempDir, 'firestore.rules'));
          tempConfig.firestore = {
            ...(typeof tempConfig.firestore === 'object' ? tempConfig.firestore : {}),
            rules: 'firestore.rules',
          };
          const configuredIndexes = rawConfig?.firestore?.indexes;
          if (configuredIndexes) {
            const absIndexes = path.resolve(configBaseDir, configuredIndexes);
            if (fs.existsSync(absIndexes)) {
              fs.copyFileSync(absIndexes, path.join(tempDir, 'firestore.indexes.json'));
              tempConfig.firestore.indexes = 'firestore.indexes.json';
            } else {
              delete tempConfig.firestore.indexes;
            }
          }
        }
      }

      // Copy Storage rules if configured or overridden
      const configuredStorage =
        typeof rawConfig?.storage === 'object' ? rawConfig.storage?.rules : undefined;
      const resolvedStorageSrc = storageRulesPath
        ? path.resolve(baseDir, storageRulesPath)
        : configuredStorage
          ? path.resolve(configBaseDir, configuredStorage)
          : null;
      if (resolvedStorageSrc) {
        if (!fs.existsSync(resolvedStorageSrc)) {
          if (storageRulesPath) {
            throw new ContractValidationError(`Storage rules file not found: ${resolvedStorageSrc}`);
          }
          delete tempConfig.storage;
        } else {
          fs.copyFileSync(resolvedStorageSrc, path.join(tempDir, 'storage.rules'));
          tempConfig.storage = {
            ...(typeof tempConfig.storage === 'object' ? tempConfig.storage : {}),
            rules: 'storage.rules',
          };
        }
      }

      // Dynamic emulator ports and disabled unused services
      if (tempConfig.emulators && typeof tempConfig.emulators === 'object') {
        for (const emuKey of [
          'auth',
          'database',
          'firestore',
          'storage',
          'hosting',
          'eventarc',
          'pubsub',
          'tasks',
          'dataconnect',
          'apphosting',
        ]) {
          if (tempConfig.emulators[emuKey] && typeof tempConfig.emulators[emuKey] === 'object') {
            tempConfig.emulators[emuKey].port = 0;
          }
        }
        tempConfig.emulators.ui = { enabled: false };
        if (!functions) {
          delete tempConfig.emulators.functions;
        } else if (
          tempConfig.emulators.functions &&
          typeof tempConfig.emulators.functions === 'object'
        ) {
          tempConfig.emulators.functions.port = 0;
        }
      }

      if (!functions) {
        delete tempConfig.functions;
      }

      // Handle hosting public directory safely so missing unbuilt dist/ does not abort startup
      if (tempConfig.hosting) {
        if (Array.isArray(tempConfig.hosting)) {
          const kept = [];
          for (let i = 0; i < tempConfig.hosting.length; i += 1) {
            const entry = tempConfig.hosting[i];
            if (entry && typeof entry.public === 'string') {
              const absPub = path.resolve(configBaseDir, entry.public);
              if (fs.existsSync(absPub) && fs.statSync(absPub).isDirectory()) {
                const linkName = `public-${i}`;
                fs.symlinkSync(absPub, path.join(tempDir, linkName), 'dir');
                kept.push({ ...entry, public: linkName });
              }
            }
          }
          if (kept.length > 0) {
            tempConfig.hosting = kept;
          } else {
            delete tempConfig.hosting;
          }
        } else if (typeof tempConfig.hosting === 'object' && typeof tempConfig.hosting.public === 'string') {
          const absPub = path.resolve(configBaseDir, tempConfig.hosting.public);
          if (fs.existsSync(absPub) && fs.statSync(absPub).isDirectory()) {
            fs.symlinkSync(absPub, path.join(tempDir, 'public'), 'dir');
            tempConfig.hosting = { ...tempConfig.hosting, public: 'public' };
          } else {
            delete tempConfig.hosting;
          }
        } else {
          delete tempConfig.hosting;
        }
      }

      fs.writeFileSync(
        path.join(tempDir, 'firebase.json'),
        `${JSON.stringify(tempConfig, null, 2)}\n`,
        'utf8',
      );

      // Copy .firebaserc (resolving default project alias & filtering multi-target database entries only when single-DB)
      const srcRc = fs.existsSync(path.join(baseDir, '.firebaserc'))
        ? path.join(baseDir, '.firebaserc')
        : fs.existsSync(path.join(configBaseDir, '.firebaserc'))
          ? path.join(configBaseDir, '.firebaserc')
          : null;
      let resolvedProjectAlias = null;
      if (srcRc) {
        let wroteProcessed = false;
        try {
          const parsedRc = JSON.parse(fs.readFileSync(srcRc, 'utf8'));
          if (parsedRc && typeof parsedRc === 'object') {
            if (!Array.isArray(tempConfig.database) && parsedRc.targets && typeof parsedRc.targets === 'object') {
              for (const projTargets of Object.values(parsedRc.targets)) {
                if (projTargets && typeof projTargets === 'object') {
                  delete projTargets.database;
                }
              }
            }
            const targetProjects =
              parsedRc.targets && typeof parsedRc.targets === 'object'
                ? Object.keys(parsedRc.targets)
                : [];
            const firstExplicitProject =
              parsedRc.projects && typeof parsedRc.projects === 'object'
                ? parsedRc.projects.default ||
                  parsedRc.projects.prod ||
                  parsedRc.projects.production ||
                  Object.values(parsedRc.projects).find((v) => typeof v === 'string' && v.trim())
                : null;
            const explicitEnvProj =
              projectId || env?.FIREBASE_PROJECT || env?.VITE_FIREBASE_PROJECT || null;
            resolvedProjectAlias =
              (explicitEnvProj && parsedRc.targets?.[explicitEnvProj] ? explicitEnvProj : null) ||
              firstExplicitProject ||
              targetProjects[0] ||
              'pyric-sandbox';
            if (
              !parsedRc.projects ||
              typeof parsedRc.projects !== 'object' ||
              Object.keys(parsedRc.projects).length === 0 ||
              (explicitEnvProj && parsedRc.targets?.[explicitEnvProj])
            ) {
              parsedRc.projects = {
                ...(parsedRc.projects && typeof parsedRc.projects === 'object' ? parsedRc.projects : {}),
                default: resolvedProjectAlias,
              };
            }
            fs.writeFileSync(
              path.join(tempDir, '.firebaserc'),
              `${JSON.stringify(parsedRc, null, 2)}\n`,
              'utf8',
            );
            wroteProcessed = true;
          }
        } catch {
          // Fall through to raw copy
        }
        if (!wroteProcessed) {
          fs.copyFileSync(srcRc, path.join(tempDir, '.firebaserc'));
        }
      } else {
        fs.writeFileSync(
          path.join(tempDir, '.firebaserc'),
          `${JSON.stringify({ projects: { default: 'pyric-sandbox' } }, null, 2)}\n`,
          'utf8',
        );
      }

      // Symlink node_modules from projectDir or monorepo root if available
      const nodeModulesTarget =
        (fs.existsSync(path.join(baseDir, 'node_modules'))
          ? path.join(baseDir, 'node_modules')
          : null) || findAncestorNodeModules(baseDir);
      if (nodeModulesTarget && !fs.existsSync(path.join(tempDir, 'node_modules'))) {
        fs.symlinkSync(nodeModulesTarget, path.join(tempDir, 'node_modules'), 'dir');
      }

      // Handle seed file or snapshot directory
      let cliSeedPath = null;
      let postStartSnapshot = null;
      const isMultiServiceEnvelope = (obj) =>
        Boolean(
          obj &&
            typeof obj === 'object' &&
            ('version' in obj ||
              'firestore' in obj ||
              'database' in obj ||
              'databases' in obj ||
              'rtdb' in obj ||
              'auth' in obj ||
              'users' in obj ||
              'storage' in obj),
        );
      if (seedDir) {
        const resolvedSeed = path.resolve(baseDir, seedDir);
        if (!fs.existsSync(resolvedSeed)) {
          throw new ContractValidationError(`Seed path does not exist: ${resolvedSeed}`);
        }
        const stat = fs.statSync(resolvedSeed);
        if (stat.isFile()) {
          let parsedSeed = null;
          try {
            parsedSeed = JSON.parse(fs.readFileSync(resolvedSeed, 'utf8'));
          } catch {
            parsedSeed = null;
          }
          if (isMultiServiceEnvelope(parsedSeed)) {
            postStartSnapshot = parsedSeed;
          } else {
            cliSeedPath = path.join(tempDir, 'seed.json');
            fs.copyFileSync(resolvedSeed, cliSeedPath);
          }
        } else if (stat.isDirectory()) {
          const dirSeedJson = path.join(resolvedSeed, 'seed.json');
          const dirStateJson = path.join(resolvedSeed, 'state.json');
          if (fs.existsSync(dirSeedJson)) {
            let parsedSeed = null;
            try {
              parsedSeed = JSON.parse(fs.readFileSync(dirSeedJson, 'utf8'));
            } catch {
              parsedSeed = null;
            }
            if (isMultiServiceEnvelope(parsedSeed)) {
              postStartSnapshot = parsedSeed;
            } else {
              cliSeedPath = path.join(tempDir, 'seed.json');
              fs.copyFileSync(dirSeedJson, cliSeedPath);
            }
          } else if (fs.existsSync(dirStateJson)) {
            const parsedState = JSON.parse(fs.readFileSync(dirStateJson, 'utf8'));
            if (!isMultiServiceEnvelope(parsedState)) {
              cliSeedPath = path.join(tempDir, 'seed.json');
              fs.copyFileSync(dirStateJson, cliSeedPath);
            } else {
              postStartSnapshot = parsedState;
            }
          }
        }
      }

      const spawnArgs = [
        ...execInfo.args,
        'sandbox',
        '--hosted',
        '--bridge',
        '--fresh',
        '--port',
        '0',
        '--json',
        '--no-open',
      ];
      if (cliSeedPath) {
        spawnArgs.push('--seed', cliSeedPath);
      }

      const stdoutRing = [];
      const stderrRing = [];
      const spawnEnv = {
        ...env,
        CI: '1',
      };
      delete spawnEnv.PYRIC_PERSIST;

      child = spawn(execInfo.command, spawnArgs, {
        cwd: tempDir,
        env: spawnEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const startupInfo = await new Promise((resolve, reject) => {
        let settled = false;
        let stdoutBuffer = '';

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for Pyric sandbox startup JSON.\n` +
                `Command: ${execInfo.command} ${spawnArgs.join(' ')}\n` +
                `Stdout:\n${stdoutRing.join('\n')}\nStderr:\n${stderrRing.join('\n')}`,
            ),
          );
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          stdoutBuffer += text;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? '';
          for (const rawLine of lines) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('{')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed.url === 'string') {
                  if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(parsed);
                  }
                  return;
                }
              } catch {
                // Not valid JSON yet
              }
            }
            appendRing(stdoutRing, trimmed);
          }
        });

        child.stderr.on('data', (chunk) => {
          appendRing(stderrRing, chunk);
        });

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(
              `Failed to spawn Pyric CLI (${execInfo.command}): ${err.message}\nStderr:\n${stderrRing.join('\n')}`,
            ),
          );
        });

        child.on('exit', (code, signal) => {
          if (stdoutBuffer.trim()) {
            appendRing(stdoutRing, stdoutBuffer.trim());
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(
              `Pyric sandbox exited prematurely (code=${code}, signal=${signal}).\n` +
                `Command: ${execInfo.command} ${spawnArgs.join(' ')}\n` +
                `Stdout:\n${stdoutRing.join('\n')}\nStderr:\n${stderrRing.join('\n')}`,
            ),
          );
        });
      });

      const baseUrl = String(startupInfo.url).replace(/\/+$/, '');
      const healthRes = await fetch(`${baseUrl}/__pyric/health`);
      if (!healthRes.ok) {
        throw new Error(`Pyric health check failed with status ${healthRes.status}`);
      }
      const health = await healthRes.json();

      let initMeta = {};
      try {
        const initRes = await fetch(`${baseUrl}/__pyric/init.json`);
        if (initRes.ok) {
          initMeta = await initRes.json();
        }
      } catch {
        // Optional metadata
      }

      const defaultDbInstance = initMeta.databaseInstances?.defaultInstance;
      const secondaryRtdbInstances = Object.keys(initMeta.databaseInstances?.rules || {}).filter(
        (name) => name && name !== defaultDbInstance,
      );

      const sandbox = new IsolatedSandbox({
        url: baseUrl,
        port: Number(startupInfo.port ?? new URL(baseUrl).port),
        uiUrl: startupInfo.uiUrl ?? null,
        mcpUrl: startupInfo.mcpUrl ?? `${baseUrl}/__pyric/mcp`,
        rulesHash: startupInfo.rulesHash ?? initMeta.rulesHash ?? null,
        databaseRulesHash: startupInfo.databaseRulesHash ?? initMeta.databaseRulesHash ?? null,
        storageRulesHash: initMeta.storageRulesHash ?? null,
        secondaryRtdbInstances,
        instanceId: String(health.instanceId),
        tempDir,
        projectDir: baseDir,
        child,
        stdoutRing,
        stderrRing,
      });

      if (postStartSnapshot) {
        await sandbox._applySnapshotState(postStartSnapshot);
      }

      return sandbox;
    } catch (error) {
      if (child) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async _refreshInstanceId() {
    const res = await fetch(`${this.url}/__pyric/health`);
    if (res.ok) {
      const health = await res.json();
      if (health?.instanceId) {
        this.instanceId = String(health.instanceId);
      }
    }
  }

  async _callHostedMethodRaw(method, params = {}) {
    const doPost = async () => {
      const payload = JSON.stringify({
        instanceId: this.instanceId,
        projectDir: this.tempDir,
        key: String(method),
        args: params && typeof params === 'object' ? params : {},
        allowProduction: false,
      });
      let response;
      let lastFetchErr = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(`${this.url}/__pyric/hosted/method`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              connection: 'close',
            },
            body: payload,
          });
          lastFetchErr = null;
          break;
        } catch (err) {
          lastFetchErr = err;
          const errCode = err?.cause?.code || err?.code;
          if (attempt === 0 && (errCode === 'ECONNRESET' || errCode === 'UND_ERR_SOCKET')) {
            await new Promise((r) => setTimeout(r, 25));
            continue;
          }
          throw err;
        }
      }
      if (lastFetchErr) {
        throw lastFetchErr;
      }
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { ok: false, summary: text || `HTTP ${response.status}` };
      }
      return { httpStatus: response.status, body };
    };

    let result = await doPost();
    if (result.httpStatus === 409) {
      await this._refreshInstanceId();
      result = await doPost();
    }
    return result;
  }

  /**
   * Invokes a Pyric hosted method (`POST /__pyric/hosted/method`).
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<{ ok: boolean, summary: string, data?: unknown }>}
   */
  async callHostedMethod(method, params = {}) {
    const { httpStatus, body } = await this._callHostedMethodRaw(method, params);
    if (!body || typeof body !== 'object') {
      throw new Error(`Hosted method "${method}" returned invalid response (HTTP ${httpStatus})`);
    }
    if (httpStatus >= 400 && body.ok !== true) {
      throw new Error(body.summary || `Hosted method "${method}" failed with HTTP ${httpStatus}`);
    }
    return body;
  }

  /**
   * Invokes an MCP tool on Pyric's Streamable HTTP MCP endpoint (`POST /__pyric/mcp`).
   *
   * @param {string} toolName
   * @param {Record<string, unknown>} [args]
   * @returns {Promise<unknown>}
   */
  async callMcpTool(toolName, args = {}) {
    const headers = () => ({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-pyric-project-dir': this.tempDir,
      'x-pyric-instance-id': this.instanceId,
      ...(this._mcpSessionId ? { 'mcp-session-id': this._mcpSessionId } : {}),
    });

    if (!this._mcpSessionId) {
      const initId = ++this._mcpSeq;
      const initRes = await fetch(this.mcpUrl, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: initId,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'pyric-sandbox-client', version: '1.0.0' },
          },
        }),
      });
      const sid = initRes.headers.get('mcp-session-id');
      if (sid) {
        this._mcpSessionId = sid;
      }
      await initRes.text();

      await fetch(this.mcpUrl, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        }),
      });
    }

    const reqId = ++this._mcpSeq;
    const callRes = await fetch(this.mcpUrl, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: reqId,
        method: 'tools/call',
        params: {
          name: String(toolName),
          arguments: args && typeof args === 'object' ? args : {},
        },
      }),
    });

    const contentType = callRes.headers.get('content-type') || '';
    const rawText = await callRes.text();
    const parsed = parseSseOrJson(rawText, contentType);
    if (!callRes.ok) {
      throw new Error(
        `MCP tool "${toolName}" failed (HTTP ${callRes.status}): ${JSON.stringify(parsed)}`,
      );
    }
    if (parsed?.error) {
      throw new Error(`MCP tool "${toolName}" error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
    }
    return parsed?.result ?? parsed;
  }

  /**
   * Ensures a user exists in the isolated sandbox Auth store.
   *
   * @param {{ uid: string, email?: string, password?: string, displayName?: string, customClaims?: Record<string, unknown>, tenantId?: string }} userSpec
   * @returns {Promise<{ uid: string, email: string }>}
   */
  async ensureUser(userSpec) {
    if (!userSpec || typeof userSpec.uid !== 'string' || !userSpec.uid.trim()) {
      throw new ContractValidationError('ensureUser requires a non-empty uid');
    }
    const uid = userSpec.uid.trim();
    const email = userSpec.email || `${uid}@sandbox.invalid`;
    const password =
      typeof userSpec.password === 'string' && userSpec.password.length >= 6
        ? userSpec.password
        : `sandbox-${uid}-pw`;

    let resolvedEmail = email;
    if (!this._knownUsers.has(uid)) {
      const existing = await this._callHostedMethodRaw('auth.getUser', { uid });
      if (existing.body?.ok === true) {
        if (existing.body?.data?.email && !userSpec.email) {
          resolvedEmail = String(existing.body.data.email);
        }
      } else {
        const createArgs = {
          uid,
          email: resolvedEmail,
          password,
          ...(userSpec.displayName ? { displayName: userSpec.displayName } : {}),
          ...(userSpec.customClaims ? { customClaims: userSpec.customClaims } : {}),
          ...(userSpec.tenantId ? { tenantId: userSpec.tenantId } : {}),
        };
        const created = await this._callHostedMethodRaw('auth.createUser', createArgs);
        if (created.body?.ok !== true) {
          // If already exists due to race, proceed; otherwise surface error
          if (!/already exists/i.test(created.body?.summary || '')) {
            throw new Error(created.body?.summary || `Failed to create user ${uid}`);
          }
        }
      }
      this._knownUsers.add(uid);
    }

    if (userSpec.customClaims && Object.keys(userSpec.customClaims).length > 0) {
      await this._callHostedMethodRaw('auth.setCustomUserClaims', {
        uid,
        customClaims: userSpec.customClaims,
      });
    }

    return { uid, email: resolvedEmail, password };
  }

  /**
   * Mints a sandbox-local Auth token for `uid` (ensuring the user exists in the sandbox pool).
   * Never touches production Firebase Auth.
   *
   * @param {string} uid
   * @param {Record<string, unknown>} [claims]
   * @returns {Promise<string>}
   */
  async mintCustomToken(uid, claims = {}) {
    if (typeof uid !== 'string' || !uid.trim()) {
      throw new ContractValidationError('mintCustomToken requires a non-empty uid');
    }
    const normalizedUid = uid.trim();
    const cleanClaims = claims && typeof claims === 'object' ? { ...claims } : {};

    await this.ensureUser({
      uid: normalizedUid,
      customClaims: cleanClaims,
    });

    const res = await this.callHostedMethod('auth.createCustomToken', {
      uid: normalizedUid,
      ...(Object.keys(cleanClaims).length > 0 ? { developerClaims: cleanClaims } : {}),
    });

    const token =
      res?.data?.idToken ??
      res?.data?.customToken ??
      res?.data?.token ??
      `pyric-custom.${Buffer.from(JSON.stringify({ uid: normalizedUid, claims: cleanClaims })).toString('base64url')}.${crypto.randomBytes(8).toString('hex')}`;

    this._tokenIdentities.set(token, {
      uid: normalizedUid,
      customClaims: cleanClaims,
    });

    return token;
  }

  _enqueueOp(fn) {
    const next = this._opQueue.then(fn, fn);
    this._opQueue = next.catch(() => {});
    return next;
  }

  _resolveTokenIdentity(idToken) {
    if (idToken === null || idToken === undefined) {
      return { mode: 'anonymous', uid: null, customClaims: {} };
    }
    if (typeof idToken === 'object') {
      if (idToken.admin === true) {
        return { mode: 'admin', uid: null, customClaims: {} };
      }
      const rawInner = idToken.idToken ?? idToken.token ?? idToken.customToken;
      if (idToken.uid) {
        return {
          mode: 'uid',
          uid: String(idToken.uid),
          customClaims: idToken.customClaims || idToken.claims || {},
          tenantId: idToken.tenantId,
        };
      }
      if (typeof rawInner === 'string') {
        return this._resolveTokenIdentity(rawInner);
      }
      return { mode: 'anonymous', uid: null, customClaims: {} };
    }
    if (typeof idToken === 'string') {
      if (!idToken.trim() || idToken === 'anonymous') {
        return { mode: 'anonymous', uid: null, customClaims: {} };
      }
      if (idToken === '__ADMIN__') {
        return { mode: 'admin', uid: null, customClaims: {} };
      }
      const cached = this._tokenIdentities.get(idToken);
      if (cached) {
        return { mode: 'uid', ...cached };
      }
      if (idToken.startsWith('uid:')) {
        return { mode: 'uid', uid: idToken.slice(4), customClaims: {} };
      }
      const jwt = decodeJwtPayloadUnsafe(idToken);
      if (jwt && (jwt.uid || jwt.sub || jwt.user_id)) {
        return {
          mode: 'uid',
          uid: String(jwt.uid || jwt.sub || jwt.user_id),
          customClaims: jwt.claims || jwt.developerClaims || {},
        };
      }
      return { mode: 'uid', uid: idToken, customClaims: {} };
    }
    return { mode: 'anonymous', uid: null, customClaims: {} };
  }

  async _applyIdentity(identity) {
    if (identity.mode === 'admin') {
      await this._callHostedMethodRaw('auth.actAsAdmin', {});
      return;
    }
    if (identity.mode === 'anonymous' || !identity.uid) {
      await this._callHostedMethodRaw('auth.actAsAnonymous', {});
      return;
    }
    await this._callHostedMethodRaw('auth.impersonate', {
      uid: identity.uid,
      ...(identity.customClaims && Object.keys(identity.customClaims).length > 0
        ? { customClaims: identity.customClaims }
        : {}),
      ...(identity.tenantId ? { tenantId: identity.tenantId } : {}),
    });
  }

  /**
   * Executes a single database, firestore, or storage operation against the isolated sandbox
   * under the supplied `idToken` (or anonymous if omitted), returning an ALLOW/DENY verdict.
   *
   * @param {{ operation: object, idToken?: string | object | null }} params
   * @returns {Promise<{ decision: 'ALLOW' | 'DENY', status: number, data: unknown, error: string | null, summary: string | null, latencyMs: number }>}
   */
  async executeOperation({ operation, idToken } = {}) {
    if (!operation || typeof operation !== 'object') {
      throw new ContractValidationError('executeOperation requires an operation object');
    }

    const service = normalizeServiceName(operation.service);
    if (service === 'auth') {
      throw new ContractValidationError(
        'executeOperation supports database, firestore, and storage data operations; use mintCustomToken/ensureUser for auth.',
      );
    }

    const rawMethod = String(operation.method || 'get').trim().toLowerCase();
    const payload =
      operation.value !== undefined
        ? operation.value
        : operation.data !== undefined
          ? operation.data
          : operation.values;

    let hostedKey;
    let hostedArgs;

    if (service === 'database') {
      const targetPath = normalizeRtdbPath(operation.path);
      const instanceOpt = operation.instance ? { instance: String(operation.instance) } : {};
      if (rawMethod === 'get' || rawMethod === 'read' || rawMethod === 'once' || rawMethod === 'onvalue' || rawMethod === 'query') {
        hostedKey = 'database.get';
        hostedArgs = { path: targetPath, ...instanceOpt };
      } else if (rawMethod === 'set' || rawMethod === 'put' || rawMethod === 'write') {
        hostedKey = 'database.set';
        hostedArgs = { path: targetPath, value: payload ?? null, ...instanceOpt };
      } else if (rawMethod === 'update' || rawMethod === 'patch') {
        hostedKey = 'database.update';
        hostedArgs = { path: targetPath, value: payload ?? {}, ...instanceOpt };
      } else if (rawMethod === 'push' || rawMethod === 'post') {
        hostedKey = 'database.push';
        hostedArgs = { path: targetPath, ...(payload !== undefined ? { value: payload } : {}), ...instanceOpt };
      } else if (rawMethod === 'remove' || rawMethod === 'delete' || rawMethod === 'del') {
        hostedKey = 'database.remove';
        hostedArgs = { path: targetPath, ...instanceOpt };
      } else {
        throw new ContractValidationError(`Unsupported database method "${operation.method}"`);
      }
    } else if (service === 'firestore') {
      if (rawMethod === 'get' || rawMethod === 'getdoc' || rawMethod === 'read') {
        hostedKey = 'firestore.getDoc';
        hostedArgs = { path: normalizeFirestorePath(operation, false) };
      } else if (rawMethod === 'getdocs' || rawMethod === 'query' || rawMethod === 'list') {
        hostedKey = 'firestore.getDocs';
        hostedArgs = { path: normalizeFirestorePath(operation, true) };
      } else if (rawMethod === 'set' || rawMethod === 'setdoc' || rawMethod === 'put' || rawMethod === 'create') {
        hostedKey = 'firestore.setDoc';
        hostedArgs = {
          path: normalizeFirestorePath(operation, false),
          data: payload && typeof payload === 'object' ? payload : {},
          ...(operation.options ? { options: operation.options } : {}),
        };
      } else if (rawMethod === 'update' || rawMethod === 'updatedoc' || rawMethod === 'patch') {
        hostedKey = 'firestore.updateDoc';
        hostedArgs = {
          path: normalizeFirestorePath(operation, false),
          data: payload && typeof payload === 'object' ? payload : {},
        };
      } else if (rawMethod === 'add' || rawMethod === 'adddoc' || rawMethod === 'post') {
        hostedKey = 'firestore.addDoc';
        hostedArgs = {
          path: normalizeFirestorePath(operation, true),
          data: payload && typeof payload === 'object' ? payload : {},
        };
      } else if (rawMethod === 'delete' || rawMethod === 'deletedoc' || rawMethod === 'remove') {
        hostedKey = 'firestore.deleteDoc';
        hostedArgs = { path: normalizeFirestorePath(operation, false) };
      } else {
        throw new ContractValidationError(`Unsupported firestore method "${operation.method}"`);
      }
    } else if (service === 'storage') {
      const storagePath = normalizeStoragePath(operation.path);
      if (rawMethod === 'get' || rawMethod === 'getbytes' || rawMethod === 'read') {
        hostedKey = 'storage.getBytes';
        hostedArgs = { path: storagePath };
      } else if (
        rawMethod === 'upload' ||
        rawMethod === 'uploadbytes' ||
        rawMethod === 'put' ||
        rawMethod === 'write' ||
        rawMethod === 'set' ||
        rawMethod === 'uploadstring' ||
        rawMethod === 'putstring'
      ) {
        hostedKey = 'storage.uploadBytes';
        const contentType = operation.contentType || operation.metadata?.contentType;
        hostedArgs = {
          path: storagePath,
          contentBase64: encodeUploadBase64(operation),
          ...(contentType ? { contentType: String(contentType) } : {}),
        };
      } else if (rawMethod === 'delete' || rawMethod === 'deleteobject' || rawMethod === 'remove') {
        hostedKey = 'storage.deleteObject';
        hostedArgs = { path: storagePath };
      } else {
        throw new ContractValidationError(`Unsupported storage method "${operation.method}"`);
      }
    }

    const identity = this._resolveTokenIdentity(idToken);

    return this._enqueueOp(async () => {
      const started = performance.now();
      await this._applyIdentity(identity);
      const { httpStatus, body } = await this._callHostedMethodRaw(hostedKey, hostedArgs);
      const latencyMs = Math.round((performance.now() - started) * 100) / 100;

      if (body?.ok === true) {
        if (
          service === 'database' &&
          !operation.instance &&
          this.secondaryRtdbInstances.length > 0 &&
          hostedKey !== 'database.get'
        ) {
          for (const secInst of this.secondaryRtdbInstances) {
            await this._callHostedMethodRaw(hostedKey, { ...hostedArgs, instance: secInst }).catch(() => {});
          }
        }
        return {
          decision: 'ALLOW',
          status: 200,
          data: body.data ?? null,
          error: null,
          summary: body.summary ?? null,
          latencyMs,
        };
      }

      const summary = body?.summary || `HTTP ${httpStatus}`;
      const isRuleDenial =
        body?.data?.code === 'denied_by_rules' ||
        /permission_denied|denied by rules|unauthorized/i.test(summary);
      const status = isRuleDenial
        ? identity.mode === 'anonymous'
          ? 401
          : 403
        : httpStatus >= 400
          ? httpStatus
          : /not.?found/i.test(summary)
            ? 404
            : 400;

      return {
        decision: 'DENY',
        status,
        data: body?.data ?? null,
        error: summary,
        summary,
        latencyMs,
      };
    });
  }

  /**
   * Reads the current JSON value or document at `targetPath` for state-diff capture.
   * Defaults to admin privileges when `idToken` is `undefined`.
   *
   * @param {string} service
   * @param {string} targetPath
   * @param {string | object | null} [idToken]
   * @returns {Promise<unknown>}
   */
  async readState(service, targetPath, idToken = undefined) {
    const normalized = normalizeServiceName(service);
    const effectiveIdentity = idToken === undefined ? { admin: true } : idToken;

    if (normalized === 'database') {
      const res = await this.executeOperation({
        operation: { service: 'database', method: 'get', path: targetPath },
        idToken: effectiveIdentity,
      });
      if (res.decision !== 'ALLOW') return null;
      return res.data?.exists ? (res.data.value ?? null) : null;
    }

    if (normalized === 'firestore') {
      const res = await this.executeOperation({
        operation: { service: 'firestore', method: 'getDoc', path: targetPath },
        idToken: effectiveIdentity,
      });
      if (res.decision !== 'ALLOW') return null;
      return res.data?.exists ? (res.data.data ?? null) : null;
    }

    if (normalized === 'storage') {
      const res = await this.executeOperation({
        operation: { service: 'storage', method: 'getBytes', path: targetPath },
        idToken: effectiveIdentity,
      });
      if (res.decision !== 'ALLOW') return null;
      return res.data ?? null;
    }

    throw new ContractValidationError(`readState does not support service "${service}"`);
  }

  /**
   * Hot-swaps security rules inside the isolated sandbox and updates the temp workspace files.
   *
   * @param {{ rtdbRules?: string | object, databaseRules?: string | object, firestoreRules?: string, storageRules?: string }} rulesSpec
   * @returns {Promise<{ ok: boolean, rulesHash: string | null, databaseRulesHash: string | null, storageRulesHash: string | null }>}
   */
  async updateRules({ rtdbRules, databaseRules, rtdbInstance, firestoreRules, storageRules } = {}) {
    return this._enqueueOp(async () => {
      const effectiveRtdb = rtdbRules !== undefined ? rtdbRules : databaseRules;
      if (effectiveRtdb !== undefined) {
        const source =
          typeof effectiveRtdb === 'string'
            ? effectiveRtdb
            : `${JSON.stringify(effectiveRtdb, null, 2)}\n`;
        fs.writeFileSync(path.join(this.tempDir, 'database.rules.json'), source, 'utf8');
        if (rtdbInstance) {
          await this.callHostedMethod('rules.set', {
            service: 'database',
            rules: source,
            rtdbInstance,
          });
        } else {
          await this.callHostedMethod('rules.set', {
            service: 'database',
            rules: source,
          });
          for (const secInst of this.secondaryRtdbInstances) {
            await this.callHostedMethod('rules.set', {
              service: 'database',
              rules: source,
              rtdbInstance: secInst,
            });
          }
        }
      }

      if (firestoreRules !== undefined) {
        const source = String(firestoreRules);
        fs.writeFileSync(path.join(this.tempDir, 'firestore.rules'), source, 'utf8');
        await this.callHostedMethod('rules.set', {
          service: 'firestore',
          rules: source,
        });
      }

      if (storageRules !== undefined) {
        const source = String(storageRules);
        fs.writeFileSync(path.join(this.tempDir, 'storage.rules'), source, 'utf8');
        await this.callHostedMethod('rules.set', {
          service: 'storage',
          rules: source,
        });
      }

      try {
        const initRes = await fetch(`${this.url}/__pyric/init.json`);
        if (initRes.ok) {
          const initMeta = await initRes.json();
          if (initMeta.rulesHash !== undefined) this.rulesHash = initMeta.rulesHash;
          if (initMeta.databaseRulesHash !== undefined) {
            this.databaseRulesHash = initMeta.databaseRulesHash;
          }
          if (initMeta.storageRulesHash !== undefined) {
            this.storageRulesHash = initMeta.storageRulesHash;
          }
        }
      } catch {
        // Ignore optional hash refresh failure
      }

      return {
        ok: true,
        rulesHash: this.rulesHash,
        databaseRulesHash: this.databaseRulesHash,
        storageRulesHash: this.storageRulesHash,
      };
    });
  }

  /**
   * Fetches recent security rule denial events recorded by the isolated sandbox.
   *
   * @param {{ limit?: number, since?: string }} [options]
   * @returns {Promise<Array<object>>}
   */
  async getDenials({ limit = 50, since } = {}) {
    const res = await this.callHostedMethod('sandbox.events', {
      kind: 'denials',
      limit,
      ...(since ? { since } : {}),
    });
    return Array.isArray(res?.data?.events) ? res.data.events : [];
  }

  async _applySnapshotState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const rawUsers = Array.isArray(snapshot.users)
      ? snapshot.users
      : Array.isArray(snapshot.auth?.users)
        ? snapshot.auth.users
        : snapshot.users && typeof snapshot.users === 'object'
          ? Object.entries(snapshot.users).map(([uid, spec]) => ({ uid, ...(spec || {}) }))
          : [];
    for (const user of rawUsers) {
      if (user?.uid) {
        await this.ensureUser(user);
      }
    }
    const rtdbRoot = snapshot.database?.data ?? snapshot.database ?? snapshot.rtdb?.data ?? snapshot.rtdb;
    if (rtdbRoot && typeof rtdbRoot === 'object') {
      for (const [key, value] of Object.entries(rtdbRoot)) {
        if (!key) continue;
        await this.executeOperation({
          operation: { service: 'database', method: 'set', path: key, data: value },
          idToken: { admin: true },
        });
      }
    }
    if (snapshot.databases && typeof snapshot.databases === 'object') {
      for (const [instanceName, tree] of Object.entries(snapshot.databases)) {
        if (tree && typeof tree === 'object') {
          await this.executeOperation({
            operation: {
              service: 'database',
              method: 'set',
              path: '/',
              data: tree,
              instance: instanceName,
            },
            idToken: { admin: true },
          });
        }
      }
    }
    const firestoreDocs = snapshot.firestore?.documents ?? snapshot.firestore;
    if (firestoreDocs && typeof firestoreDocs === 'object') {
      for (const [docPath, docData] of Object.entries(firestoreDocs)) {
        if (docData && typeof docData === 'object') {
          await this.executeOperation({
            operation: { service: 'firestore', method: 'setDoc', path: docPath, data: docData },
            idToken: { admin: true },
          });
        }
      }
    }
    if (Array.isArray(snapshot.storage)) {
      for (const item of snapshot.storage) {
        if (item?.path) {
          await this.executeOperation({
            operation: {
              service: 'storage',
              method: 'upload',
              path: item.path,
              contentBase64: item.contentBase64,
              data: item.data,
              contentType: item.contentType,
            },
            idToken: { admin: true },
          });
        }
      }
    }
  }

  /**
   * Terminates the Pyric child process group and removes the isolated temporary directory.
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this._disposed) return;
    this._disposed = true;

    const proc = this.child;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      await new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(killTimer);
          resolve();
        };

        proc.once('exit', finish);

        const killTimer = setTimeout(() => {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
          setTimeout(finish, 150);
        }, 1500);

        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {
          try {
            proc.kill('SIGTERM');
          } catch {
            finish();
          }
        }
      });
    }

    if (proc) {
      proc.stdout?.unref?.();
      proc.stderr?.unref?.();
    }

    if (this.tempDir && this.tempDir.includes('pyric-sandbox-')) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }
}
