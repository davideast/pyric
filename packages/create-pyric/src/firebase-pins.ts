/**
 * The Firebase lines a scaffolded app installs (#1188): patch ranges on the
 * versions pyric is certified against. `firebase` follows
 * FIREBASE_TESTED_AGAINST (packages/cli/src/version/compat-target.ts), the
 * version `compat:check` certifies and the `fb<major>.<minor>` dist-tag names.
 * `firebase-admin` follows the version the oracle observations were captured
 * against (`compat:oracle-versions`). A caret range would install a newer
 * minor, whose exports pyric may not mirror yet.
 *
 * packages/create-pyric/test/firebase-pins.test.ts keeps these equal to the
 * certified versions and to the chat template's package.json files, which are
 * static assets and cannot import this module.
 */
export const FIREBASE_PIN = '~12.19.0';
export const FIREBASE_ADMIN_PIN = '~13.10.0';
