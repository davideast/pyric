import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifest, sha, versionNs } from '../../../arcade/corpus.mjs';
import { materialize } from './fixture.mjs';

export const target = manifest.target;
export const stockSha256 = manifest.files['v1/rules/stock.rules'];
export const databasePath = `projects/${target.project}/databases/${target.database}`;
export const releaseName = `projects/${target.project}/releases/cloud.firestore/${target.database}`;
const digest = /^[a-f0-9]{64}$/;
const timestampType = 'firestore/timestamp/1.0';
const billion = 1_000_000_000n;
const segment = /^[A-Za-z0-9_-]+$/;

export function readProbe(probe) {
  const recipeBytes = readFileSync(new URL('recipe.json', probe));
  const fixtureBytes = readFileSync(new URL('fixture.json', probe));
  const recipe = JSON.parse(recipeBytes);
  const fixture = JSON.parse(fixtureBytes);
  const fixtureSha256 = sha(fixtureBytes);
  assert.equal(fixtureSha256, recipe.pins['fixture.json']);
  assert.equal(recipe.pins['@oracle/arcade/v1/rules/stock.rules'], stockSha256);
  assert.deepEqual(recipe.cases, fixture.cases.map(({ id }) => id));
  return { fixture, fixtureSha256, recipeSha256: sha(recipeBytes), cases: recipe.cases };
}

export function wireFields(data) {
  function value(entry) {
    if (typeof entry === 'boolean') return { booleanValue: entry };
    if (typeof entry === 'string') return { stringValue: entry };
    if (Number.isSafeInteger(entry)) return { integerValue: String(entry) };
    if (Array.isArray(entry)) return { arrayValue: { values: entry.map(value) } };
    assert.ok(entry && typeof entry === 'object', 'unexpected fixture value');
    return { mapValue: { fields: wireFields(entry) } };
  }
  return Object.fromEntries(Object.entries(data).map(([key, entry]) => [key, value(entry)]));
}

function timestampNs(value) {
  const { type, seconds, nanoseconds } = value;
  assert.equal(type, timestampType);
  assert.ok(Number.isSafeInteger(seconds));
  assert.ok(Number.isInteger(nanoseconds) && nanoseconds >= 0 && nanoseconds < Number(billion));
  assert.deepEqual(Object.keys(value).sort(), ['nanoseconds', 'seconds', 'type']);
  return BigInt(seconds) * billion + BigInt(nanoseconds);
}

function timestampJSON(iso) {
  const nanos = versionNs(iso);
  return { type: timestampType, seconds: Number(nanos / billion), nanoseconds: Number(nanos % billion) };
}

export function checkWire(document, path, expected) {
  assert.equal(document.name, `${databasePath}/documents/${path}`);
  const { createdAt, ...fields } = document.fields;
  const { createdAt: expectedTime, ...expectedFields } = expected;
  assert.equal(versionNs(createdAt.timestampValue), timestampNs(expectedTime));
  assert.deepEqual(fields, wireFields(expectedFields));
  return versionNs(document.updateTime);
}

export function checkIdentity(identity) {
  assert.match(identity.uid, segment);
  assert.equal(identity.audience, target.project);
  assert.equal(identity.issuer, `https://securetoken.google.com/${target.project}`);
  assert.equal(identity.provider, 'anonymous');
}

export function checkDeployment(proof, runId) {
  assert.equal(proof.databaseUid, target.uid);
  assert.equal(proof.releaseName, releaseName);
  const rulesetPrefix = `projects/${target.project}/rulesets/`;
  assert.ok(proof.rulesetName.startsWith(rulesetPrefix));
  assert.match(proof.rulesetName.slice(rulesetPrefix.length), segment);
  assert.equal(proof.rulesSha256, stockSha256);
  assert.equal(proof.lockRunId, runId);
  assert.match(proof.propagationReceiptSha256, digest);
  return versionNs(proof.verifiedAt);
}

export function validateAttempt(probe, caseId, row) {
  const { fixture, fixtureSha256, recipeSha256 } = probe;
  assert.equal(row.caseId, caseId);
  assert.equal(row.fixtureSha256, fixtureSha256);
  assert.equal(row.recipeSha256, recipeSha256);
  assert.equal(row.sdkVersion, target.sdk);
  assert.equal(row.project, target.project);
  assert.equal(row.database, target.database);
  assert.equal(row.endpoint, 'firestore.googleapis.com');
  assert.equal(row.writeSubmitted, true);
  checkIdentity(row.actor);
  checkIdentity(row.reader);
  const { runId } = row;
  const attempt = materialize(fixture, caseId, { actor: row.actor.uid, reader: row.reader.uid, runId });
  assert.equal(row.path, attempt.path);
  assert.equal(row.operation, attempt.operation);
  assert.equal(row.expected, attempt.expected);
  assert.deepEqual(row.proposal, attempt.data);

  const { deploymentBefore, deploymentAfter } = row;
  const verifiedBefore = checkDeployment(deploymentBefore, runId);
  const verifiedAfter = checkDeployment(deploymentAfter, runId);
  const attemptedAt = versionNs(row.attemptedAt);
  const readAt = versionNs(row.readAt);
  assert.ok(verifiedBefore <= attemptedAt && attemptedAt <= readAt && readAt <= verifiedAfter);
  assert.equal(deploymentAfter.rulesetName, deploymentBefore.rulesetName);
  assert.equal(deploymentAfter.propagationReceiptSha256, deploymentBefore.propagationReceiptSha256);

  const before = { ...attempt.before, createdAt: timestampJSON(attempt.before.createdAt) };
  const serverMetadata = { fromCache: false, hasPendingWrites: false };
  assert.deepEqual(row.before.metadata, serverMetadata);
  assert.deepEqual(row.stored.metadata, serverMetadata);
  assert.deepEqual(row.before.data, before);
  if (attempt.operation === 'transaction-update') assert.deepEqual(row.transactionRead, before);
  const seededVersion = checkWire(row.seedDocument, row.path, before);
  const beforeVersion = checkWire(row.beforeDocument, row.path, before);
  const afterVersion = checkWire(row.afterDocument, row.path, row.stored.data);
  const createdVersion = versionNs(row.seedDocument.createTime);
  assert.ok(createdVersion <= seededVersion);
  assert.equal(versionNs(row.beforeDocument.createTime), createdVersion);
  assert.equal(versionNs(row.afterDocument.createTime), createdVersion);
  assert.equal(beforeVersion, seededVersion);
  assert.equal(row.beforeVersion, row.beforeDocument.updateTime);
  assert.equal(row.afterVersion, row.afterDocument.updateTime);

  if (row.decision === 'ALLOW') {
    assert.equal(row.code, 'ok');
    const after = attempt.operation === 'transaction-update'
      ? { ...before, ...attempt.data }
      : { ...attempt.data, createdAt: row.stored.data.createdAt };
    if (attempt.operation === 'set') assert.ok(timestampNs(after.createdAt) > timestampNs(before.createdAt));
    assert.deepEqual(row.stored.data, after);
    assert.ok(afterVersion > beforeVersion);
  } else {
    assert.equal(row.decision, 'DENY', 'unscorable SDK outcome: ' + row.code);
    assert.equal(row.code, 'permission-denied');
    assert.deepEqual(row.stored.data, before);
    assert.equal(afterVersion, beforeVersion);
  }
  return row.decision;
}

export function normalizeEvidence(probe, receipt) {
  const { rows } = receipt;
  assert.deepEqual(Object.keys(rows).sort(), [...probe.cases].sort(), 'expected exactly the recipe cases');
  const decisions = {};
  const first = rows[probe.cases[0]];
  const paths = new Set();
  for (const caseId of probe.cases) {
    const row = rows[caseId];
    decisions[caseId] = validateAttempt(probe, caseId, row);
    assert.equal(row.runId, first.runId);
    assert.equal(row.deploymentBefore.rulesetName, first.deploymentBefore.rulesetName);
    assert.equal(row.deploymentBefore.propagationReceiptSha256, first.deploymentBefore.propagationReceiptSha256);
    assert.ok(!paths.has(row.path), 'each attempt must use a distinct document');
    paths.add(row.path);
  }
  return decisions;
}
