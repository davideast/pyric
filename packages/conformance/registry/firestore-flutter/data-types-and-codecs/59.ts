import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Timestamp codec',
  behavior: 'Serializes and revives Timestamp preserving seconds and nanoseconds across bridge wire format.',
  featureKeys: ['Timestamp'],
  flipped: 'unit-backed',
});
