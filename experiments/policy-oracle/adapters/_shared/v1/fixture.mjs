// Shared fixture, digest, and canonicalization utilities for policy-oracle probes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function readText(pathOrUrl) {
  return readFileSync(pathOrUrl, 'utf8');
}

export function readJson(pathOrUrl) {
  return JSON.parse(readFileSync(pathOrUrl, 'utf8'));
}

// Matches oracle.py:canonical (sorted keys, compact separators, no NaN/Infinity).
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalJson does not allow non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw new TypeError('Unsupported value in canonicalJson: ' + typeof value);
}

// Matches oracle.py: sha256(claim.json + NUL + recipe.json).
export function computeInputDigest(claimBytes, recipeBytes) {
  const claim = Buffer.isBuffer(claimBytes) ? claimBytes : Buffer.from(claimBytes, 'utf8');
  const recipe = Buffer.isBuffer(recipeBytes) ? recipeBytes : Buffer.from(recipeBytes, 'utf8');
  return sha256(Buffer.concat([claim, Buffer.from([0]), recipe]));
}

export function assertCaseIds(caseIds) {
  assert.ok(Array.isArray(caseIds) && caseIds.length > 0, 'cases must be a non-empty array');
  const seen = new Set();
  for (const id of caseIds) {
    assert.ok(typeof id === 'string' && id.length > 0, 'case id must be a non-empty string');
    assert.ok(!seen.has(id), 'duplicate case id: ' + id);
    seen.add(id);
  }
  return caseIds;
}

export function defineProbeFixtures(entries) {
  const list = Array.isArray(entries)
    ? entries.map((entry) => ({ ...entry }))
    : Object.entries(entries).map(([id, spec]) => ({ id, ...spec }));
  const ids = assertCaseIds(list.map((entry) => entry.id));
  const byId = Object.fromEntries(list.map((entry) => [entry.id, entry]));
  return { ids, byId, list };
}

export function buildStorageCase(spec) {
  assert.ok(typeof spec.id === 'string' && spec.id.length > 0, 'storage case needs id');
  assert.ok(typeof spec.path === 'string' && spec.path.length > 0, 'storage case needs path');
  const out = {
    description: spec.description ?? spec.id,
    expectation: spec.expectation ?? 'ALLOW',
    method: spec.method ?? 'create',
    path: spec.path,
  };
  if (spec.bucket !== undefined) out.bucket = spec.bucket;
  if (spec.auth !== undefined) out.auth = spec.auth;
  if (spec.requestResource !== undefined) out.requestResource = spec.requestResource;
  if (spec.resource !== undefined) out.resource = spec.resource;
  if (spec.firestore !== undefined) out.firestore = spec.firestore;
  if (spec.requestTime !== undefined) out.requestTime = spec.requestTime;
  return out;
}

export function buildRtdbCase(spec) {
  assert.ok(typeof spec.id === 'string' && spec.id.length > 0, 'rtdb case needs id');
  assert.ok(typeof spec.path === 'string' && spec.path.startsWith('/'), 'rtdb case path must start with /');
  const out = {
    description: spec.description ?? spec.id,
    expectation: spec.expectation ?? 'ALLOW',
    operation: spec.operation ?? 'write',
    path: spec.path,
  };
  if (spec.auth !== undefined) out.auth = spec.auth;
  if (spec.data !== undefined) out.data = spec.data;
  if (spec.newData !== undefined) out.newData = spec.newData;
  if (spec.updates !== undefined) out.updates = spec.updates;
  if (spec.now !== undefined) out.now = spec.now;
  return out;
}

export function computePinMap(oracleRoot, probeDir, names) {
  const pins = {};
  for (const name of names) {
    const filePath = name.startsWith('@oracle/')
      ? join(oracleRoot, name.slice('@oracle/'.length))
      : join(probeDir, name);
    pins[name] = sha256(readFileSync(filePath));
  }
  return pins;
}
