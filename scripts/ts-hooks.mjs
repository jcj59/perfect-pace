/**
 * Run a TypeScript script with Node (`node --import ./scripts/ts-hooks.mjs script.ts`): a module
 * hook that compiles each `.ts` file with the repo's own `typescript` as it loads, types dropped
 * and nothing checked (`pnpm typecheck` does that). Node 22 here is built without type stripping.
 */
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { isMainThread } from "node:worker_threads";
import ts from "typescript";

// Imported with --import on the main thread: register this same file as the hooks (which Node
// loads again on its hooks thread, where it only exports `load`).
if (isMainThread) register(import.meta.url);

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: url,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  return { format: "module", source: outputText, shortCircuit: true };
}
