import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DocumentReferencePlatform.set(data, SetOptions(merge: true))',
  behavior: 'Merges payload fields into existing document without overwriting unspecified fields.',
  featureKeys: ['set', 'merge'],
  flipped: 'unit-backed',
});
