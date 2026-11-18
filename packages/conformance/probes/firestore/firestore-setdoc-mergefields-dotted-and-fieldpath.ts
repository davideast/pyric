import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#28',
  rowIds: ['firestore#28'],
  description:
    'setDoc(ref, data, { mergeFields }) writes only the listed dot-separated string and FieldPath paths, ignoring unmasked input keys and preserving other stored fields.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { FieldPath, collection, doc, getDoc, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('setdoc-mergefields'));

      const maskedRef = doc(items, 'masked-doc');
      await setDoc(maskedRef, {
        keep: 'intact',
        ignoredTop: 'before',
        profile: {
          name: 'Ada',
          role: 'admin',
          prefs: { theme: 'light', lang: 'en' },
        },
      });

      await setDoc(
        maskedRef,
        {
          ignoredTop: 'after-ignored',
          extraIgnored: 123,
          profile: {
            name: 'Grace',
            role: 'owner-ignored',
            prefs: { theme: 'dark', lang: 'fr-ignored' },
          },
        },
        {
          mergeFields: ['profile.name', new FieldPath('profile', 'prefs', 'theme')],
        },
      );
      const maskedSnap = await getDoc(maskedRef);

      const emptyMaskExistingRef = doc(items, 'empty-mask-existing');
      await setDoc(emptyMaskExistingRef, { preserved: 'yes', count: 1 });
      await setDoc(emptyMaskExistingRef, { preserved: 'no', count: 99 }, { mergeFields: [] });
      const emptyMaskExistingSnap = await getDoc(emptyMaskExistingRef);

      const emptyMaskAbsentRef = doc(items, 'empty-mask-absent');
      await setDoc(emptyMaskAbsentRef, { ignoredField: 'ignored' }, { mergeFields: [] });
      const emptyMaskAbsentSnap = await getDoc(emptyMaskAbsentRef);

      return {
        maskedData: maskedSnap.data() ?? null,
        emptyMaskExistingData: emptyMaskExistingSnap.data() ?? null,
        emptyMaskAbsentExists: emptyMaskAbsentSnap.exists(),
        emptyMaskAbsentData: emptyMaskAbsentSnap.data() ?? null,
      };
    });
  },
};
