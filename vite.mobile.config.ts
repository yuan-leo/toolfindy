import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, "mobile"),
  base: "./",
  resolve: { alias: { "@": projectRoot } },
  plugins: [react()],
  build: { outDir: path.join(projectRoot, "mobile-dist"), emptyOutDir: true },
});
