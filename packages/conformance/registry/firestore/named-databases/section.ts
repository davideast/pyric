import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 20,
  prefix: '## Named databases\n\nIn production `getFirestore(app, databaseId)` selects a named database with its own documents, and rules see that id in the `database` path variable. Pyric models one database per app, `(default)`. When `firebase.json` declares `firestore` as an array, pyric serves the `(default)` entry\'s rules and prints a startup warning for each named entry.\n',
  defaults: {
    section: "Named databases",
    status: "diverged-documented",
    automation: "unit-backed",
  },
});

export const row = section.row;
