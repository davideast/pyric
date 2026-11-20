import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseReference.getData()',
  behavior: 'Fetches a one-shot DataSnapshot of the current data at the reference path.',
  featureKeys: ['getData'],
});
