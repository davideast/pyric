import fs from 'node:fs';
import path from 'node:path';

const MULTI_SERVICE_SEED_ENVELOPE_KEYS = Object.freeze([
  'version',
  'firestore',
  'database',
  'databases',
  'rtdb',
  'auth',
  'users',
  'storage',
]);

const RTDB_SEED_ENVELOPE_KEYS = Object.freeze(['database', 'databases', 'rtdb']);

const MULTI_SERVICE_ENVELOPE_KEY_SET = new Set(MULTI_SERVICE_SEED_ENVELOPE_KEYS);
const RTDB_ENVELOPE_KEY_SET = new Set(RTDB_SEED_ENVELOPE_KEYS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inspectSeedEnvelope(parsedSeed, { requireRtdb = false, label = 'seed.json' } = {}) {
  if (!isPlainObject(parsedSeed)) {
    return {
      ok: false,
      isEnvelope: false,
      parsed: parsedSeed,
      reason: `Seed file ${label} must be a JSON object; wrap Realtime Database state in { "database": { ... } }.`,
    };
  }

  const keys = Object.keys(parsedSeed);
  const envelopeKeys = keys.filter((k) => MULTI_SERVICE_ENVELOPE_KEY_SET.has(k));
  const nonEnvelopeKeys = keys.filter((k) => !MULTI_SERVICE_ENVELOPE_KEY_SET.has(k));
  const hasRtdbKey = keys.some((k) => RTDB_ENVELOPE_KEY_SET.has(k));

  if (envelopeKeys.length > 0 && nonEnvelopeKeys.length > 0) {
    return {
      ok: false,
      isEnvelope: false,
      parsed: parsedSeed,
      reason: `Seed file ${label} mixes multi-service envelope keys (${envelopeKeys.join(', ')}) with bare keys (${nonEnvelopeKeys.join(', ')}); wrap the RTDB tree in { "database": { ... } }.`,
    };
  }

  if (requireRtdb) {
    if (!hasRtdbKey) {
      return {
        ok: false,
        isEnvelope: false,
        parsed: parsedSeed,
        reason: `RTDB seed file ${label} is missing the multi-service { "database": ... } envelope (top-level keys: ${keys.join(', ') || 'none'}); wrap the RTDB tree in { "database": { ... } }.`,
      };
    }
    for (const key of RTDB_SEED_ENVELOPE_KEYS) {
      if (key in parsedSeed && !isPlainObject(parsedSeed[key])) {
        return {
          ok: false,
          isEnvelope: true,
          parsed: parsedSeed,
          reason: `RTDB seed file ${label} "${key}" envelope value must be a JSON object.`,
        };
      }
    }
    if ('databases' in parsedSeed && isPlainObject(parsedSeed.databases)) {
      for (const [instanceName, tree] of Object.entries(parsedSeed.databases)) {
        if (!instanceName.trim() || !isPlainObject(tree)) {
          return {
            ok: false,
            isEnvelope: true,
            parsed: parsedSeed,
            reason: `RTDB seed file ${label} "databases.${instanceName}" must be a JSON object.`,
          };
        }
      }
    }
  }

  return {
    ok: true,
    isEnvelope: envelopeKeys.length > 0,
    parsed: parsedSeed,
    reason: null,
  };
}

/**
 * Inspect a seed file or snapshot directory on disk against the multi-service envelope contract.
 */
export function inspectSeedPath(seedPath, { requireRtdb = false } = {}) {
  const resolved = path.resolve(seedPath);
  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      isEnvelope: false,
      parsed: null,
      filePath: resolved,
      reason: `Seed path does not exist: ${resolved}`,
    };
  }

  const stat = fs.statSync(resolved);
  let targetFile = null;
  if (stat.isFile()) {
    targetFile = resolved;
  } else if (stat.isDirectory()) {
    const dirSeedJson = path.join(resolved, 'seed.json');
    const dirStateJson = path.join(resolved, 'state.json');
    if (fs.existsSync(dirSeedJson)) {
      targetFile = dirSeedJson;
    } else if (fs.existsSync(dirStateJson)) {
      targetFile = dirStateJson;
    } else if (requireRtdb) {
      return {
        ok: false,
        isEnvelope: false,
        parsed: null,
        filePath: resolved,
        reason: `RTDB seed directory ${resolved} contains neither seed.json nor state.json; provide a JSON file with a { "database": { ... } } envelope.`,
      };
    } else {
      return {
        ok: true,
        isEnvelope: false,
        parsed: null,
        filePath: null,
        reason: null,
      };
    }
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      isEnvelope: false,
      parsed: null,
      filePath: targetFile,
      reason: `Invalid JSON in seed file ${targetFile}: ${err?.message || String(err)}`,
    };
  }

  const envCheck = inspectSeedEnvelope(parsed, { requireRtdb, label: targetFile });
  return {
    ...envCheck,
    filePath: targetFile,
  };
}
