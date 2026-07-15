---
title: Prepare the Firebase project
navLabel: Set up the Firebase project
outcome: Configure the real Firebase services that production will use, without confusing project setup with local development.
status: draft
---

# Prepare the Firebase project

Pyric does not create, configure, or administer production Firebase projects. Local development needs no Firebase account or project. Production does.

Before shipping, create or select the real project and complete only the Firebase setup the application requires:

- [Register the web app and copy its Firebase configuration](https://firebase.google.com/docs/web/setup).
- [Enable the Authentication providers used by the app](https://firebase.google.com/docs/auth/web/start).
- [Create the Firestore database](https://firebase.google.com/docs/firestore/quickstart), if the app uses Firestore.
- [Create the Realtime Database](https://firebase.google.com/docs/database/web/start), if the app uses Realtime Database.
- [Create the default Storage bucket](https://firebase.google.com/docs/storage/web/start), if the app uses Storage.
- [Install and select a project with the Firebase CLI](https://firebase.google.com/docs/cli) before deploying rules, indexes, Hosting, or Functions.

These steps affect a real project. Confirm the selected project before running a Firebase CLI command.

The resulting Firebase configuration stays in the application code. During local development, Pyric accepts that configuration while resolving `firebase/*` to the sandbox. A production build resolves the same imports to Firebase and uses the configuration for the real project.

Continue with [Ship to production](./ship-to-production.md) for the unchanged build and deployment path.
