// Build the Tide Dial demo into ONE self-contained HTML file that opens by
// double-click from file://: IIFE bundle, CSS and fonts inlined as data URIs.
// Mirrors scripts/build-dial-demo.js, but writes outside EC/public so the
// file never ships inside the Electron app.
import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const result = await build({
  configFile: false,
  plugins: [react()],
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    minify: true,
    assetsInlineLimit: () => true, // fonts land in the CSS as data URIs
    lib: { entry: "examples/today/main.jsx", name: "TideDial", formats: ["iife"] },
  },
});
const output = [result].flat().flatMap((bundle) => bundle.output);
const script = output.find((file) => file.type === "chunk" && file.isEntry).code;
const styles = output
  .filter((file) => file.fileName.endsWith(".css"))
  .map((file) => file.source)
  .join("\n");
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>今日表盘 · Tide Dial — 精力日历</title><style>${styles}</style></head>
<body><div id="root"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;

const outDirs = [
  "D:/Programs/check in software/日历动效源码/今日表盘",
  "D:/前端/素材/日历动效/源码与演示/今日表盘",
];
for (const dir of outDirs) {
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/index.html`, html);
}
const kb = (html.length / 1024).toFixed(1);
console.log(`today demo → ${outDirs.map((d) => `${d}/index.html`).join(", ")}`);
console.log(`single-file size: ${kb} KB (${(html.length / 1048576).toFixed(2)} MB)`);
