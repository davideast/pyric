import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { manifest, sha } from '../corpus.mjs';

const { project, database, uid, closedRuleset } = manifest.target;
const projectPath = 'projects/' + project;
export const dbName = projectPath + '/databases/' + database;
export const dbUrl = 'https://firestore.googleapis.com/v1/' + dbName;
const rulesApi = 'https://firebaserules.googleapis.com/v1/';
export const releaseName = projectPath + '/releases/cloud.firestore/' + database;
let accessToken, nextManagementRead = 0;

export async function api(url, method = 'GET', body) {
  assert.ok(['firestore.googleapis.com', 'firebaserules.googleapis.com', 'firebase.googleapis.com'].includes(new URL(url).hostname));
  accessToken ??= execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  const readRules = method === 'GET' && new URL(url).hostname === 'firebaserules.googleapis.com';
  for (let attempt = 0; ; attempt++) {
    if (readRules) {
      const time = Math.max(Date.now(), nextManagementRead);
      nextManagementRead = time + 1700;
      await delay(Math.max(0,time-Date.now()));
    }
    let response, data;
    try {
      response = await fetch(url, {
        method, headers: { Authorization: 'Bearer ' + accessToken, 'x-goog-user-project': project, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      data = await response.json();
    } catch (error) {
      const transportFailure = error instanceof TypeError || error.name === 'TimeoutError';
      if (method !== 'GET' || !transportFailure || attempt >= 2) throw error;
      await delay(1000 * (attempt + 1));
      continue;
    }
    if (readRules && [429, 503].includes(response.status) && attempt < 8) {
      const quota = data.error?.details?.find(d => d.metadata?.quota_limit)?.metadata?.quota_limit;
      const retry = Number(response.headers.get('retry-after')) || Math.min(90, 15*(attempt+1));
      console.log('Pacing rules management reads',response.status,quota || '',retry,'s');
      await delay(retry*1000);
      continue;
    }
    if (!response.ok) throw new Error(method + ' ' + new URL(url).pathname + ' ' + response.status + ' ' + data.error?.status);
    return data;
  }
}
export async function currentRelease() {
  const value = await api(rulesApi + releaseName);
  assert.equal(value.name, releaseName);
  return value;
}
async function rulesDigest(name) {
  assert.match(name, /^projects\/digame-mas\/rulesets\/[a-zA-Z0-9-]+$/);
  const rules = await api(rulesApi + name);
  assert.equal(rules.source.files.length, 1);
  return sha(rules.source.files[0].content);
}
export async function preflight() {
  const db = await api(dbUrl);
  assert.equal(db.name, dbName);
  assert.equal(db.uid, uid);
  const release = await currentRelease();
  assert.equal(release.rulesetName, closedRuleset, 'original deny-all release must be active');
  assert.equal(await rulesDigest(closedRuleset), manifest.files['v1/rules/closed.rules']);
  const management = 'https://firebase.googleapis.com/v1beta1/';
  const {apps} = await api(management + projectPath + '/webApps?pageSize=100');
  const app = apps.find(a => a.displayName === 'pyric-arcade');
  assert.ok(app, 'Arcade web app missing');
  const config = await api(management + app.name + '/config');
  assert.equal(config.projectId, project);
  const info = await api(management + projectPath);
  assert.match(info.projectNumber, /^\d+$/);
  return { release, config, projectNumber: info.projectNumber };
}
export async function uploadRules(text, projectNumber, expected) {
  const res = await api(rulesApi + projectPath + '/rulesets', 'POST', {
    source: {files: [{name: 'firestore.rules', content: text}]},
    attachment_point: 'firestore.googleapis.com/projects/' + projectNumber + '/databases/' + database,
  });
  assert.equal(await rulesDigest(res.name), expected);
  return res.name;
}
export async function switchRelease(rulesetName) {
  assert.equal((await api(dbUrl)).uid, uid);
  await api(rulesApi + releaseName, 'PATCH', {release: {name: releaseName, rulesetName}});
  const active = await currentRelease();
  assert.equal(active.rulesetName, rulesetName);
  return active;
}
export async function takeLock(runId) {
  const document = await api(dbUrl + '/documents/oracleLocks?documentId=arcade-counter', 'POST', {
    fields: {runId: {stringValue: runId}},
  });
  assert.equal(document.name, dbName + '/documents/oracleLocks/arcade-counter');
  return document.updateTime;
}
export async function releaseLock(version) {
  await api(dbUrl + '/documents/oracleLocks/arcade-counter?currentDocument.updateTime=' + encodeURIComponent(version), 'DELETE');
}
