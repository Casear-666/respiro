import { writeFile } from "node:fs/promises";
import { build } from "vite";
import react from "@vitejs/plugin-react";

// A classic, self-contained bundle lets the demo run from file:// as well as localhost.
const result = await build({
  configFile: false,
  plugins: [react()],
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    minify: true,
    lib: { entry: "examples/dial-demo.jsx", name: "DialDemo", formats: ["iife"] },
  },
});
const output = [result].flat().flatMap(bundle => bundle.output);
const script = output.find(file => file.type === "chunk" && file.isEntry).code;
const styles = output.find(file => file.fileName.endsWith(".css")).source;
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>精力日历 · 潮汐蓝表盘</title><style>${styles}</style></head>
<body><div id="root"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
await writeFile(new URL("../public/dial-demo.html", import.meta.url), html);
