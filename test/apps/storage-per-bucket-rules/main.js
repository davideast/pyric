// Uploads one object, signed in to nothing, to the app's default bucket, to
// media-bucket, and to a bucket firebase.json deploys no rules to, and
// returns one line per upload: the bucket's label and "ok" or the error code.
import { initializeApp } from "firebase/app";
import { getMetadata, getStorage, ref, uploadString } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
});

async function outcome(label, storage, path) {
  try {
    await uploadString(ref(storage, path), "from the page");
    return `${label} ok`;
  } catch (error) {
    return `${label} ${error.code}`;
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

window.uploadToEachBucket = async (path) => [
  await outcome("default", getStorage(app), path),
  await outcome("media", getStorage(app, "gs://media-bucket"), path),
  await outcome("undeployed", getStorage(app, "gs://other-bucket"), path),
];

window.observeBucketUrlContract = async (path) => {
  const defaultStorage = getStorage(app);
  const ownGsStorage = getStorage(app, "gs://demo-app.appspot.com");
  const mediaGsStorage = getStorage(app, "gs://media-bucket");
  const mediaBareStorage = getStorage(app, "media-bucket");

  const defaultRef = ref(defaultStorage, path);
  const ownGsRef = ref(ownGsStorage, path);
  const defaultUploaded = await uploadString(defaultRef, "default payload");
  const defaultMetadata = await getMetadata(ownGsRef);

  const mediaUploaded = await uploadString(ref(mediaGsStorage, path), "media payload");
  const mediaMetadata = await getMetadata(ref(mediaBareStorage, path));

  const crossObjectPath = `uploads/${path}`;
  const crossGsRef = ref(defaultStorage, `gs://media-bucket/${crossObjectPath}`);
  const crossDlRef = ref(
    defaultStorage,
    `https://firebasestorage.googleapis.com/v0/b/media-bucket/o/${encodeURIComponent(crossObjectPath)}?alt=media&token=t`,
  );
  const crossUploaded = await uploadString(crossGsRef, "cross-bucket media payload");
  const crossMetadata = await getMetadata(crossDlRef);
  let crossUndeployedCode = "did-not-throw";
  try {
    await uploadString(ref(defaultStorage, `gs://other-bucket/${crossObjectPath}`), "denied");
  } catch (error) {
    crossUndeployedCode = String(error.code);
  }

  return {
    defaultRefBucket: defaultRef.bucket,
    defaultRefString: defaultRef.toString(),
    ownGsRefBucket: ownGsRef.bucket,
    defaultUploadBucket: defaultUploaded.metadata.bucket,
    defaultMetadataBucket: defaultMetadata.bucket,
    mediaUploadBucket: mediaUploaded.metadata.bucket,
    mediaMetadataBucket: mediaMetadata.bucket,
    crossUrlRefBucket: crossGsRef.bucket,
    crossUrlSameStorage: crossGsRef.storage === defaultStorage,
    crossUrlUploadBucket: crossUploaded.metadata.bucket,
    crossUrlDownloadMetaBucket: crossMetadata.bucket,
    crossUrlUndeployedCode: crossUndeployedCode,
    defaultDistinctFromOwnGs: defaultStorage !== ownGsStorage,
    mediaGsDistinctFromBare: mediaGsStorage !== mediaBareStorage,
    invalidGsPathCode: invalidBucketCode("gs://media-bucket/sub/path"),
  };
};
