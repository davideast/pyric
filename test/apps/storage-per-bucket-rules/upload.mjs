// Uploads one object, signed in to nothing, to the app's default bucket, to
// media-bucket, and to a bucket firebase.json deploys no rules to, as a
// server script of the app would under `node --import @pyric/cli/register`.
import { initializeApp, deleteApp } from "firebase/app";
import { getMetadata, getStorage, ref, uploadString } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
});

async function outcome(label, storage) {
  try {
    await uploadString(ref(storage, "uploads/a.txt"), "from a server script");
    console.log(`${label} ok`);
  } catch (error) {
    console.log(`${label} ${error.code}`);
  }
}

function invalidBucketCode(bucketUrl) {
  try {
    getStorage(app, bucketUrl);
    return "did-not-throw";
  } catch (error) {
    return String(error.code);
  }
}

await outcome("default", getStorage(app));
await outcome("media", getStorage(app, "gs://media-bucket"));
await outcome("undeployed", getStorage(app, "gs://other-bucket"));

const contractPath = "public/server-contract.txt";
const defaultStorage = getStorage(app);
const ownGsStorage = getStorage(app, "gs://demo-app.appspot.com");
const mediaGsStorage = getStorage(app, "gs://media-bucket");
const mediaBareStorage = getStorage(app, "media-bucket");

const defaultRef = ref(defaultStorage, contractPath);
const ownGsRef = ref(ownGsStorage, contractPath);
const defaultUploaded = await uploadString(defaultRef, "server default payload");
const defaultMetadata = await getMetadata(ownGsRef);
const mediaUploaded = await uploadString(ref(mediaGsStorage, contractPath), "server media payload");
const mediaMetadata = await getMetadata(ref(mediaBareStorage, contractPath));

console.log(`contract ${JSON.stringify({
  defaultRefBucket: defaultRef.bucket,
  defaultRefString: defaultRef.toString(),
  ownGsRefBucket: ownGsRef.bucket,
  defaultUploadBucket: defaultUploaded.metadata.bucket,
  defaultMetadataBucket: defaultMetadata.bucket,
  mediaUploadBucket: mediaUploaded.metadata.bucket,
  mediaMetadataBucket: mediaMetadata.bucket,
  defaultDistinctFromOwnGs: defaultStorage !== ownGsStorage,
  mediaGsDistinctFromBare: mediaGsStorage !== mediaBareStorage,
  invalidGsPathCode: invalidBucketCode("gs://media-bucket/sub/path"),
})}`);
await deleteApp(app);
