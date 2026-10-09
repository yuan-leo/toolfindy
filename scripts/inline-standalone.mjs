import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = path.join(projectRoot, "standalone-dist");
const sourceHtmlPath = path.join(outputDirectory, "index.html");
const finalHtmlPath = path.join(outputDirectory, "Tool-Findy-Standalone.html");

let html = await readFile(sourceHtmlPath, "utf8");

for (const match of [...html.matchAll(/<link rel="stylesheet" crossorigin href="([^"]+)">/g)]) {
  const cssPath = path.join(outputDirectory, match[1].replace(/^\.\//, ""));
  const css = await readFile(cssPath, "utf8");
  html = html.replace(match[0], () => `<style>${css.replaceAll("</style", "<\\/style")}</style>`);
}

for (const match of [...html.matchAll(/<script type="module" crossorigin src="([^"]+)"><\/script>/g)]) {
  const scriptPath = path.join(outputDirectory, match[1].replace(/^\.\//, ""));
  const script = await readFile(scriptPath, "utf8");
  html = html.replace(match[0], "");
  html = html.replace("</body>", () => `<script>${script.replaceAll("</script", "<\\/script")}</script></body>`);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(finalHtmlPath, html, "utf8");

const outputs = await readdir(outputDirectory);
if (outputs.length !== 1 || outputs[0] !== path.basename(finalHtmlPath)) {
  throw new Error(`Standalone build must contain exactly ${path.basename(finalHtmlPath)}.`);
}

console.log(finalHtmlPath);
