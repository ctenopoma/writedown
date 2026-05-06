const esbuild = require("esbuild");
const fs      = require("fs");
const path    = require("path");

const production = process.argv.includes("--production");

/** Extension main bundle */
const mainBuild = esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: [
    "vscode",         // VS Code API は実行時に提供される
    "puppeteer-core", // 動的 require / __dirname に依存するため外部のまま
  ],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

/** highlight.js — common languages, IIFE for browser */
const hljsBuild = esbuild.build({
  entryPoints: ["node_modules/highlight.js/es/common.js"],
  bundle: true,
  outfile: "media/highlight.min.js",
  format: "iife",
  globalName: "hljs",
  platform: "browser",
  minify: true,
  logLevel: "info",
});

/** Mermaid — browser global for markdown preview */
const mermaidBuild = esbuild.build({
  entryPoints: ["node_modules/mermaid/dist/mermaid.core.mjs"],
  bundle: true,
  outfile: "media/mermaid.min.js",
  format: "iife",
  globalName: "mermaid",
  platform: "browser",
  minify: true,
  logLevel: "info",
});

/** Copy static assets to media/ */
function copyMedia() {
  const copies = [
    // highlight.js theme CSS
    ["node_modules/highlight.js/styles/github.min.css", "media/hljs-github.min.css"],
  ];
  for (const [src, dst] of copies) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      const kb = (fs.statSync(dst).size / 1024).toFixed(1);
      console.log(`  copied ${dst} (${kb} KB)`);
    }
  }
}

Promise.all([mainBuild, hljsBuild, mermaidBuild])
  .then(() => copyMedia())
  .catch(() => process.exit(1));
