// Dev mode: rebuilds the client on change and restarts the server on change.
// Reload the browser tab to pick up client changes.
import { spawn } from "node:child_process";

const opts = { stdio: "inherit", shell: process.platform === "win32" };
const build = spawn("node", ["tools/build.mjs", "--watch"], opts);
const server = spawn("npx", ["tsx", "watch", "src/server/main.ts"], opts);
const stop = () => {
  build.kill();
  server.kill();
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
