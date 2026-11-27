import assert from 'node:assert/strict';
import {variants} from '../../../adapters/ai-jrpg-campaign/v1/catalog.mjs';
import {families} from '../../../adapters/ai-jrpg-campaign/v1/other.mjs';
import {family, steps} from '../../../adapters/conversation-queries/v1/fixture.mjs';

// Register this fixture for this controller process. Historical recipes pin
// the original campaign catalog, controller, and rules bytes by content hash.
assert.equal(process.argv.length, 3, 'Supply the private capture archive');
variants.genkit.families.push(family);
families[family] = steps;
process.argv.push('genkit', family);
await import('./ai-jrpg-campaign.mjs');
