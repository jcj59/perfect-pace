// Render the app icons in apps/web/public/icons from the SVG sources in apps/web/icons, with the
// Playwright Chromium the E2E suite already installs (no image library). Run `pnpm icons` after
// changing a source, and commit the PNGs.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../e2e/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const SOURCES = new URL("../apps/web/icons/", import.meta.url);
const PUBLIC = new URL("../apps/web/public/", import.meta.url);
const OUT = new URL("icons/", PUBLIC);

const FULL_BLEED = "icon.svg without its rounded corners";

/** Each PNG: its file, the SVG it comes from, and its size in pixels. */
const ICONS = [
  { file: "icon-192.png", source: "icon.svg", size: 192 },
  { file: "icon-512.png", source: "icon.svg", size: 512 },
  { file: "maskable-192.png", source: "icon-maskable.svg", size: 192 },
  { file: "maskable-512.png", source: "icon-maskable.svg", size: 512 },
  // iOS rounds the corners itself, so the touch icon is the full-bleed square.
  { file: "apple-touch-icon.png", source: FULL_BLEED, size: 180 },
];

/** The full-bleed square with the mark at the rounded icon's scale (iOS masks it, but without Android's safe zone). */
function fullBleed() {
  return readFileSync(new URL("icon.svg", SOURCES), "utf8").replace(' rx="112"', "");
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, source, size } of ICONS) {
    const svg = source === FULL_BLEED ? fullBleed() : readFileSync(new URL(source, SOURCES), "utf8");
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    writeFileSync(new URL(file, OUT), await page.screenshot({ omitBackground: true }));
    console.log(`apps/web/public/icons/${file}`);
  }
} finally {
  await browser.close();
}
copyFileSync(new URL("icon.svg", SOURCES), new URL("favicon.svg", PUBLIC));
console.log("apps/web/public/favicon.svg");
