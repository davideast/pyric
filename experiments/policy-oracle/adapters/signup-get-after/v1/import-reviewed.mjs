import {fileURLToPath} from 'node:url';
import {importReviewed} from '../../../arcade/live/controller/import-reviewed.mjs';

const probe = new URL('../../../suites/ai-jrpg/pixelwood/claims/signup-get-after/v1/probes/paired-signup/v1/', import.meta.url);
const verifier = new URL('./verify.mjs', import.meta.url);
importReviewed(fileURLToPath(probe), fileURLToPath(verifier), ...process.argv.slice(2));
