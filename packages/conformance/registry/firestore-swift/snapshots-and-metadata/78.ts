import { row } from './section.ts';

export default row({
  order: 150,
  api: 'DocumentChange (type, document, oldIndex, newIndex)',
  behavior: 'Delta change descriptor indicating added, modified, or removed mutations.',
  featureKeys: ['documentChange'],
  flipped: 'unit-backed',
});
