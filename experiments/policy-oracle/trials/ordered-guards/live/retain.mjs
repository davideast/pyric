import {retain} from '../../for-of/live/retain.mjs';
import * as fixtures from './fixtures.mjs';

retain(process.argv.slice(2),fixtures,new URL('receipts/',import.meta.url));
