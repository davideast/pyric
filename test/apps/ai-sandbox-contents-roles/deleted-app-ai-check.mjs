import { FirebaseError, deleteApp, initializeApp } from "firebase/app";
import { ReCaptchaV3Provider, getToken, initializeAppCheck } from "firebase/app-check";
import { AIError, getAI, getGenerativeModel } from "firebase/ai";

const MODEL_NAME = "gemini-flash-lite-latest";

function captureSyncModelGuard(fn) {
  try {
    fn();
    return {
      threw: false,
      isAIError: false,
      isFirebaseError: false,
      code: null,
    };
  } catch (err) {
    let code = null;
    if (err && typeof err === "object" && typeof err.code === "string") {
      code = err.code;
    }
    return {
      threw: true,
      isAIError: err instanceof AIError,
      isFirebaseError: err instanceof FirebaseError,
      code,
    };
  }
}

export async function checkDeletedAppAiLifecycle(baseOptions) {
  const deletedFactoryApp = initializeApp({ ...baseOptions }, "del-ai-factory");
  const retainedAiApp = initializeApp({ ...baseOptions }, "del-ai-retained-handle");
  const retainedAiBeforeDelete = getAI(retainedAiApp);
  await deleteApp(deletedFactoryApp);
  await deleteApp(retainedAiApp);

  const deletedAppAi = getAI(deletedFactoryApp);
  const usesDeletedApp = deletedAppAi.app === deletedFactoryApp;
  const modelOnDeletedAppAi = captureSyncModelGuard(() =>
    getGenerativeModel(deletedAppAi, { model: MODEL_NAME }),
  );
  const modelOnRetainedAi = captureSyncModelGuard(() =>
    getGenerativeModel(retainedAiBeforeDelete, { model: MODEL_NAME }),
  );

  const warmOwnerApp = initializeApp({ ...baseOptions }, "del-ai-warm-owner");
  const warmAppCheck = initializeAppCheck(warmOwnerApp, {
    provider: new ReCaptchaV3Provider("6Lc-site-key-from-the-console"),
    isTokenAutoRefreshEnabled: false,
  });
  await getToken(warmAppCheck);
  const retainedWarmModel = getGenerativeModel(getAI(warmOwnerApp), { model: MODEL_NAME });

  const siblingApp = initializeApp({ ...baseOptions }, "del-ai-sibling");
  initializeAppCheck(siblingApp, {
    provider: new ReCaptchaV3Provider("6Lc-site-key-from-the-console"),
    isTokenAutoRefreshEnabled: false,
  });
  const siblingModel = getGenerativeModel(getAI(siblingApp), { model: MODEL_NAME });

  await deleteApp(warmOwnerApp);

  const warmTokens = await retainedWarmModel.countTokens("Count after delete.");
  const warmGen = await retainedWarmModel.generateContent("Reply after delete.");
  const warmStream = await retainedWarmModel.generateContentStream("Stream after delete.");
  let warmChunks = 0;
  for await (const _chunk of warmStream.stream) {
    warmChunks += 1;
  }
  await warmStream.response;

  const coldOwnerApp = initializeApp({ ...baseOptions }, "del-ai-cold-owner");
  initializeAppCheck(coldOwnerApp, {
    provider: new ReCaptchaV3Provider("6Lc-site-key-from-the-console"),
    isTokenAutoRefreshEnabled: false,
  });
  const retainedColdModel = getGenerativeModel(getAI(coldOwnerApp), { model: MODEL_NAME });
  await deleteApp(coldOwnerApp);
  const coldTokens = await retainedColdModel.countTokens("Cold count after delete.");

  const siblingTokens = await siblingModel.countTokens("Sibling count.");
  await deleteApp(siblingApp);

  return {
    usesDeletedApp,
    modelOnDeletedAppAi,
    modelOnRetainedAi,
    warmCountPositive: typeof warmTokens.totalTokens === "number" && warmTokens.totalTokens > 0,
    warmTextNonEmpty: warmGen.response.text().trim().length > 0,
    warmStreamChunksPositive: warmChunks > 0,
    coldCountPositive: typeof coldTokens.totalTokens === "number" && coldTokens.totalTokens > 0,
    siblingCountPositive:
      typeof siblingTokens.totalTokens === "number" && siblingTokens.totalTokens > 0,
  };
}
