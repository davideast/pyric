import {fileURLToPath} from 'node:url';
import {importReviewed} from '../../../arcade/live/controller/import-reviewed.mjs';
const file = path => fileURLToPath(new URL(path,import.meta.url));
importReviewed(file('../../../suites/arcade/air-hockey/claims/winning-goal/v1/probes/host-writes/v1'),
  file('verify.mjs'),...process.argv.slice(2));
