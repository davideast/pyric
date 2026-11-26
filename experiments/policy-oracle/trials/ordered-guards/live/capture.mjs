import {capture} from '../../for-of/live/capture.mjs';
import * as fixtures from './fixtures.mjs';

await capture(process.argv.slice(2),fixtures);
