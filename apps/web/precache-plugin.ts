import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";

/** Built files the service worker never precaches. */
const SKIP = [/\.map$/, /^_headers$/, /^_redirects$/, /^index\.html$/, /^sw\.js$/];

function publicFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return out;
}

/**
 * Builds the service worker (`src/sw/sw.ts`) as `/sw.js` beside the app, and fills in its
 * precache list (every built and public file, plus `/` for the app shell) and a version that
 * changes whenever any of those files does, so each deploy installs a fresh precache.
 */
export function precachePlugin(): Plugin {
  let publicDir = "";
  return {
    name: "pp-precache",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const sw = Object.values(bundle).find((f) => f.type === "chunk" && f.fileName === "sw.js");
      if (!sw || sw.type !== "chunk") throw new Error("pp-precache: no sw.js chunk in the bundle");
      const hash = createHash("sha256");
      const files: string[] = [];
      for (const file of Object.values(bundle)) {
        if (SKIP.some((re) => re.test(file.fileName))) {
          if (file.fileName === "index.html" && file.type === "asset") hash.update(file.source);
          continue;
        }
        files.push(file.fileName);
        hash.update(file.fileName).update(file.type === "chunk" ? file.code : file.source);
      }
      for (const name of publicDir ? publicFiles(publicDir) : []) {
        if (SKIP.some((re) => re.test(name))) continue;
        files.push(name);
        hash.update(name).update(readFileSync(join(publicDir, name)));
      }
      const precache = ["/", ...files.sort().map((f) => `/${f}`)];
      const version = hash.digest("hex").slice(0, 12);
      let replaced = 0;
      sw.code = sw.code
        .replace(/(["'`])__PP_VERSION__\1/, () => (replaced++, JSON.stringify(version)))
        .replace(/(["'`])__PP_PRECACHE__\1/, () => (replaced++, JSON.stringify(JSON.stringify(precache))));
      if (replaced !== 2) throw new Error("pp-precache: sw.js placeholders not found");
    },
  };
}
