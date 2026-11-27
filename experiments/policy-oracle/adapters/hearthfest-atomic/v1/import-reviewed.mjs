import {fileURLToPath} from 'node:url';
import {importReviewed} from '../../../arcade/live/controller/import-reviewed.mjs';

const probe = new URL('../../../suites/ai-jrpg/pixelwood/claims/hearthfest-atomic-award/v1/probes/contribution-and-award/v1/', import.meta.url);
const verifier = new URL('./verify.mjs', import.meta.url);
importReviewed(fileURLToPath(probe), fileURLToPath(verifier), ...process.argv.slice(2));
