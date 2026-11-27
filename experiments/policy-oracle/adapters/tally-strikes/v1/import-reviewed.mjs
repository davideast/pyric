import {fileURLToPath} from 'node:url';
import {importReviewed} from '../../../arcade/live/controller/import-reviewed.mjs';
const file = path=>fileURLToPath(new URL(path,import.meta.url));
importReviewed(file('../../../suites/satisfy/tally-slate/claims/compiled-two-strike-validation/v1/probes/turns/v1'),
  file('verify.mjs'),...process.argv.slice(2));
