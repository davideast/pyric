import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuthPlatform.setLanguageCode(languageCode)',
  behavior: 'Configures locale language code for out-of-band auth communications.',
  featureKeys: ['setLanguageCode'],
  flipped: 'unit-backed',
});
