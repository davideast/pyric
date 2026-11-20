import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DatabaseReference.push()',
  behavior: 'Generates a new child DatabaseReference with a chronologically ordered unique push ID.',
  featureKeys: ['push'],
});
