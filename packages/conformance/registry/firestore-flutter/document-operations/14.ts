import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentReferencePlatform.get(options)',
  behavior: 'Reads a single document snapshot from server or cache based on GetOptions.',
  featureKeys: ['get'],
  flipped: 'unit-backed',
});
