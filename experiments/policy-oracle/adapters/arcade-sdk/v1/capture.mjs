import assert from 'node:assert/strict';
import { materialize } from './fixture.mjs';
import {
  checkDeployment, checkIdentity, checkWire, databasePath, readProbe, releaseName,
  stockSha256, target, validateAttempt, wireFields,
} from './evidence.mjs';

export async function captureAttempt(probeUrl, caseId, context) {
  const probe = readProbe(probeUrl);
  assert.ok(probe.cases.includes(caseId));

  const { runId, writerAuth, readerAuth, sdk, sdkVersion, getIdTokenResult, createDocument, readDocument, verifyStock, journal } = context;
  assert.equal(sdkVersion, target.sdk);
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) assert.ok(!process.env[key], key);
  const { Timestamp, doc, getDocFromServer, initializeFirestore, runTransaction, serverTimestamp, setDoc } = sdk;

  async function identity(auth) {
    assert.equal(auth.app.options.projectId, target.project);
    assert.ok(auth.currentUser, 'expected an authenticated Firebase client');
    const { uid } = auth.currentUser;
    const { claims, signInProvider } = await getIdTokenResult(auth.currentUser);
    assert.equal(claims.sub, uid);
    const result = { uid, audience: claims.aud, issuer: claims.iss, provider: signInProvider };
    checkIdentity(result);
    return result;
  }

  const actor = await identity(writerAuth);
  const reader = await identity(readerAuth);
  const attempt = materialize(probe.fixture, caseId, { actor: actor.uid, reader: reader.uid, runId });
  const { operation, path, data, expected } = attempt;
  const timestamp = Timestamp.fromDate(new Date(attempt.before.createdAt));
  const normalize = fields => {
    const { createdAt, ...rest } = fields;
    assert.ok(createdAt instanceof Timestamp, 'expected a Firestore SDK Timestamp');
    return { ...rest, createdAt: createdAt.toJSON() };
  };
  const before = normalize({ ...attempt.before, createdAt: timestamp });

  async function deployment(phase) {
    const proof = await verifyStock({ phase, runId, databasePath, releaseName, stockSha256 });
    checkDeployment(proof, runId);
    return proof;
  }

  const deploymentBefore = await deployment('before');
  const settings = { host: 'firestore.googleapis.com', ssl: true };
  const writerRef = doc(initializeFirestore(writerAuth.app, settings, target.database), path);
  const readerRef = doc(initializeFirestore(readerAuth.app, settings, target.database), path);
  const { createdAt, ...seed } = attempt.before;
  const fields = { ...wireFields(seed), createdAt: { timestampValue: createdAt } };
  const seedDocument = await createDocument(path, fields);
  const seedVersion = checkWire(seedDocument, path, before);

  async function snapshot() {
    const snap = await getDocFromServer(readerRef);
    assert.ok(snap.exists());
    assert.equal(snap.metadata.fromCache, false);
    assert.equal(snap.metadata.hasPendingWrites, false);
    return { data: normalize(snap.data()), metadata: { fromCache: false, hasPendingWrites: false } };
  }
  const baseline = await snapshot();
  assert.deepEqual(baseline.data, before);
  const beforeDocument = await readDocument(path);
  assert.equal(checkWire(beforeDocument, path, baseline.data), seedVersion);
  const row = {
    runId, caseId, operation, path, actor, reader, expected, before: baseline,
    proposal: data, seedDocument, beforeDocument, beforeVersion: beforeDocument.updateTime, deploymentBefore,
    fixtureSha256: probe.fixtureSha256, recipeSha256: probe.recipeSha256,
    project: target.project, database: target.database, sdkVersion, endpoint: settings.host,
    attemptedAt: new Date().toISOString(), writeSubmitted: false,
  };
  const save = () => journal(structuredClone(row));
  await save();

  try {
    assert.equal(writerAuth.currentUser?.uid, actor.uid);
    if (operation === 'transaction-update') {
      await runTransaction(writerRef.firestore, async tx => {
        row.writeSubmitted = false;
        const current = await tx.get(writerRef);
        assert.ok(current.exists());
        row.transactionRead = normalize(current.data());
        assert.deepEqual(row.transactionRead, before);
        tx.update(writerRef, data);
        row.writeSubmitted = true;
      });
    } else {
      assert.equal(operation, 'set');
      assert.equal(data.createdAt, '$serverTimestamp');
      const write = setDoc(writerRef, { ...data, createdAt: serverTimestamp() });
      row.writeSubmitted = true;
      await write;
    }
    row.decision = 'ALLOW';
    row.code = 'ok';
  } catch (error) {
    row.code = error?.code ?? 'unknown';
    row.decision = row.writeSubmitted && row.code === 'permission-denied' ? 'DENY' : 'ERROR';
  }
  await save();

  assert.equal(readerAuth.currentUser?.uid, reader.uid);
  row.stored = await snapshot();
  row.readAt = new Date().toISOString();
  await save();
  row.afterDocument = await readDocument(path);
  row.afterVersion = row.afterDocument.updateTime;
  row.deploymentAfter = await deployment('after');
  await save();

  validateAttempt(probe, caseId, row);
  return row;
}
