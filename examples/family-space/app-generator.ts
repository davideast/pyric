import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";
import { app } from "./data";
import { generationModelOptions, generateWithModel } from "./generation-model";
export function generateFamilyApp(
  prompt: string,
  context: string,
  onProgress: (text: string) => void,
  signal: AbortSignal,
  onSummary?: (text: string) => void,
) {
  const model = getGenerativeModel(
    getAI(app, { backend: new GoogleAIBackend() }),
    generationModelOptions,
  );
  return generateWithModel(
    model,
    prompt,
    context,
    onProgress,
    signal,
    onSummary,
  );
}
