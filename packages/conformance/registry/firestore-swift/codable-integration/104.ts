import { row } from './section.ts';

export default row({
  order: 20,
  api: '@ServerTimestamp',
  behavior: 'Property wrapper encoding nil as serverTimestamp sentinel on write.',
  featureKeys: ['serverTimestampPropertyWrapper'],
  flipped: 'unit-backed',
});
