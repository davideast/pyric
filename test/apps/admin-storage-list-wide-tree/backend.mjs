// An app's backend lists a bucket that holds a folder per object (#1183):
// 1,000 single-object folders under media/, 400 under users/, a chain 40
// folders deep with an object at each level, and two root files. It lists
// with firebase-admin's bucket.getFiles() as the app does, then reads one
// object's metadata on the same client, and reports what it saw and how long
// each listing took.
import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

const bucket = getStorage(initializeApp({ projectId: "demo-app", storageBucket: "demo-app.appspot.com" })).bucket();

const media = Array.from({ length: 1000 }, (_, n) => `media/${n}/original.jpg`);
const users = Array.from({ length: 400 }, (_, n) => `users/u${n}/avatar.png`);
const deep = Array.from({ length: 41 }, (_, depth) => `${["deep", ...Array.from({ length: depth }, () => "d")].join("/")}/level.txt`);
const all = [...media, ...users, ...deep, "media-index.json", "media0.txt"];
for (let start = 0; start < all.length; start += 32) {
  await Promise.all(all.slice(start, start + 32).map((name) => bucket.file(name).save(Buffer.from(name), { resumable: false })));
}

const report = { seeded: all.length, timingsMs: {} };
const timed = async (label, query) => {
  const began = performance.now();
  try {
    const [files, nextQuery, apiResponse] = await bucket.getFiles(query);
    return { names: files.map((file) => file.name), nextQuery, prefixes: apiResponse?.prefixes ?? [] };
  } catch (error) {
    return { error: `${error?.code ?? error?.name}: ${error?.message ?? error}` };
  } finally {
    report.timingsMs[label] = Math.round(performance.now() - began);
  }
};
report.whole = await timed("whole", undefined);
report.mediaPrefix = await timed("mediaPrefix", { prefix: "media/" });
report.firstHundred = await timed("firstHundred", { maxResults: 100 });
report.mediaFolders = await timed("mediaFolders", { prefix: "media/", delimiter: "/" });
try {
  const [metadata] = await bucket.file("media/7/original.jpg").getMetadata();
  report.metadataAfter = metadata.name;
} catch (error) {
  report.metadataAfter = `${error?.code ?? error?.name}: ${error?.message ?? error}`;
}
console.log(JSON.stringify(report));
process.exit(0);
