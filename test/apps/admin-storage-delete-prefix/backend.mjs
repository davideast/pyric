// The account-delete handler of an app's backend: it removes every Storage
// object under the user's prefix with firebase-admin, as the app does when it
// deletes a user, and reports what the bucket holds before and after.
import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

const bucket = getStorage(initializeApp({ projectId: "demo-app", storageBucket: "demo-app.appspot.com" })).bucket();

const under = ["users/123/avatar.png", "users/123/uploads/a.txt", "users/123/uploads/b.txt"];
const outside = ["users/1234/avatar.png", "users/124/avatar.png", "public/logo.png"];
for (const name of [...under, ...outside]) {
  await bucket.file(name).save(Buffer.from(name), { resumable: false });
}

const names = async (query) => (await bucket.getFiles(query))[0].map((file) => file.name);
const report = {};
try {
  report.listedUnderPrefix = await names({ prefix: "users/123/" });
  await bucket.deleteFiles({ prefix: "users/123/" });
  report.listedAfterDelete = await names({});
  report.existsAfterDelete = Object.fromEntries(
    await Promise.all([...under, ...outside].map(async (name) => [name, (await bucket.file(name).exists())[0]])),
  );
} catch (error) {
  report.error = `${error?.name}: ${error?.message ?? error}`;
}
console.log(JSON.stringify(report));
process.exit(0);
