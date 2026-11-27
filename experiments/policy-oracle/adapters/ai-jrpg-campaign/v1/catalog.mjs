import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

export const root = fileURLToPath(new URL('../../../',import.meta.url));
export const revision = 'b3bed5e36acaa7bfc47a600e86e015fb84b1ac70';
const previous = 'suites/ai-jrpg/pixelwood/claims/world-role/v1/probes/app-and-mirror/v1/';
export const variants = {
  app:{source:'app/firestore.rules',pin:previous+'app.rules',
    families:['world-admin-lifecycle','invite-contention','profile-lifecycle','combat-profile-create','trade-ledger','chest-claim','house-claim','event-ledger']},
  deploy:{source:'deploy/firestore.rules',pin:previous+'mirror.rules',families:['combat-profile-create']},
  genkit:{source:'firestore.genkit-idx.rules',pin:'adapters/ai-jrpg-campaign/v1/sources/genkit.rules',families:['conversation-membership']},
  blocking:{source:'firestore.blockingfun.rules',pin:'adapters/ai-jrpg-campaign/v1/sources/blocking.rules',families:['session-access','lobby-transitions']}
};
export const fixtureModule = variant=>['app','deploy'].includes(variant) ? 'pixelwood' : 'other';
export const fixtureApi = variant=>import('./'+fixtureModule(variant)+'.mjs');
export const rulesFor = variant=>readFileSync(join(root,variants[variant].pin),'utf8');
export const testContext = variant=>({variant,runId:'offline-run',uids:{a:'caller-a',b:'caller-b',c:'caller-c'},
  emails:Object.fromEntries(['a','b','c'].map(k=>[k,k+'@example.invalid']))});
export function directory(family,variant) {
  const suite = {app:'pixelwood',deploy:'pixelwood',genkit:'genkit',blocking:'blockingfun'}[variant];
  return 'suites/ai-jrpg/'+suite+'/claims/'+family+'/v1/probes/'+variant+'/v1';
}
