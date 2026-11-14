// Repo policy checks, run by `pnpm lint`:
// 1. No em dashes in any tracked text file (code, docs, config).
// 2. Every Playwright container image in the workflows matches the installed @playwright/test
//    version, so CI screenshots are taken with the browsers the baselines were made with.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EM_DASH = String.fromCharCode(0x2014);
// Generated files we do not control.
const SKIP = new Set(["apps/worker/worker-configuration.d.ts"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip|gz)$/i;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !BINARY.test(f) && !SKIP.has(f));

const problems = [];
const playwright = JSON.parse(readFileSync("e2e/package.json", "utf8")).devDependencies["@playwright/test"];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  text.split("\n").forEach((line, i) => {
    if (line.includes(EM_DASH)) {
      problems.push(`${file}:${i + 1}: em dash (use a comma, colon, parentheses or a new sentence)`);
    }
    if (file.startsWith(".github/")) {
      for (const [, tag] of line.matchAll(/mcr\.microsoft\.com\/playwright:v([\w.-]+?)-\w+\b/g)) {
        if (tag !== playwright) {
          problems.push(`${file}:${i + 1}: Playwright image v${tag} does not match @playwright/test ${playwright}`);
        }
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`Repo policy check failed:\n${problems.join("\n")}`);
  process.exit(1);
}
