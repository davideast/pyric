import { createMemoryFileSystem } from "@inbrowser/workspace/fs";
import { createReactPreviewRuntime } from "@inbrowser/workspace/preview/react";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
export async function compileFamilyApp(source: string) {
  const fs = createMemoryFileSystem({ root: "/work" });
  {
    await fs.promises.writeFile("/work/App.tsx", source);
    const preview = createReactPreviewRuntime({
      fs,
      entry: "/work/App.tsx",
      react: {},
      jsxRuntime: {},
      esbuildOptions: {
        wasmURL: new URL(wasmURL, import.meta.url).href,
        worker: false,
      },
      extraHostModules: {
        "@kin/app": { module: {}, exports: ["useAppData", "useAppIdentity"] },
      },
    });
    const result = await preview.compile();
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    // Never evaluate generated code in the signed-in application.
    return result.code;
  }
}
