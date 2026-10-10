// Bundles the client with esbuild and copies static files to dist/client.
// Usage: node tools/build.mjs [--watch]
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "client");
const watch = process.argv.includes("--watch");

mkdirSync(out, { recursive: true });

// Every build gets its own asset URLs (lobby.css?v=…), so a browser or CDN
// that kept an old stylesheet or image can never pair it with a new page.
const LOCAL_ASSET = /(src|href)="((?!https?:|\/\/|#|data:)[^"?#]+\.(?:css|js|png|svg|jpe?g|webp))"/g;
function stampVersions() {
  const v = Date.now().toString(36);
  for (const page of ["index.html", "viewer.html"]) {
    const file = join(out, page);
    const html = readFileSync(file, "utf8");
    writeFileSync(file, html.replace(LOCAL_ASSET, `$1="$2?v=${v}"`));
  }
}
const copyStatic = () => {
  cpSync(join(root, "public"), out, { recursive: true });
  stampVersions();
};
copyStatic();

const options = {
  entryPoints: {
    main: join(root, "src", "client", "main.ts"),
    viewer: join(root, "src", "client", "viewer.ts"),
  },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: out,
  minify: process.argv.includes("--minify"),
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
