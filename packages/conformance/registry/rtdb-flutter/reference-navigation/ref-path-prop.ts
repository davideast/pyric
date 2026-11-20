import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DatabaseReference.path',
  behavior: 'Returns the normalized slash-delimited full path of the reference.',
  featureKeys: ['path'],
});
