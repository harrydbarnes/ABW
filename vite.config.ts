import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
let revision = process.env.GITHUB_SHA?.slice(0, 7) || "local";
if (revision === "local") {
  try { revision = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { /* Source archives do not contain Git metadata. */ }
}

export default defineConfig({
  define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(`${version} (${revision})`) },
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "es2021",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
