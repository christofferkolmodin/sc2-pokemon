// Bundles the client with esbuild and copies static files to dist/client.
// Usage: node tools/build.mjs [--watch]
import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "client");
const watch = process.argv.includes("--watch");

mkdirSync(out, { recursive: true });
const copyStatic = () => cpSync(join(root, "public"), out, { recursive: true });
copyStatic();

const options = {
  entryPoints: [join(root, "src", "client", "main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(out, "main.js"),
  sourcemap: true,
  logLevel: "info",
  plugins: [{ name: "static", setup: (b) => b.onEnd(copyStatic) }],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching client sources…");
} else {
  await esbuild.build(options);
}
