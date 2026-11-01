// A module Vite loads for server rendering that imports the app's shared
// firebase.ts, as a framework's loader would.
import { getToken } from "firebase/app-check";
import { appCheck } from "./firebase.ts";

export async function render() {
  return { tokenSegments: (await getToken(appCheck)).token.split(".").length };
}
