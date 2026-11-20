import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Timestamp',
  behavior: 'UTC timestamp representing 64-bit seconds and nanosecond resolution.',
  featureKeys: ['timestamp'],
  flipped: 'unit-backed',
});
