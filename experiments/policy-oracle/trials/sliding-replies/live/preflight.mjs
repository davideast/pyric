import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {api,dbUrl,preflight} from '../../../arcade/live/control.mjs';
import {manifest} from '../../../arcade/corpus.mjs';

// gcloud may otherwise supply a cached credential with only a few minutes left.
// Ask the credential manager for ample validity before the controller caches it.
export async function inspectTarget() {
  const config=JSON.parse(execFileSync('gcloud',['config','config-helper','--min-expiry=45m',
    '--format=json(credential.access_token,credential.token_expiry)'],{encoding:'utf8'}));
  const expiry=config.credential.token_expiry;
  const active=execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8'}).trim();
  assert.ok(active && active===config.credential.access_token,'Management client received a different credential');
  assert.ok(Date.parse(expiry)-Date.now()>44*60_000,'Management credential expires too soon');
  const {release}=await preflight();
  const lock=dbUrl+'/documents/oracleLocks/arcade-counter';
  await assert.rejects(()=>api(lock),error=>error.message==='GET '+new URL(lock).pathname+' 404 NOT_FOUND');
  return {databaseUid:manifest.target.uid,closedRulesSha256:manifest.files['v1/rules/closed.rules'],
    restoredReleaseVersion:release.updateTime,activeLease:false,managementCredentialExpires:expiry};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await inspectTarget(),null,2));
}
