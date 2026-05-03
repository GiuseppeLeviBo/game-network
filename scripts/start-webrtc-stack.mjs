import { spawn } from "node:child_process";

const children = [];
let isShuttingDown = false;

start("peer-signaling", [
  "node",
  "dist/src/signalingServerCli.js",
  "--host",
  "127.0.0.1",
  "--port",
  "9000",
  "--path",
  "/game-network",
]);

start("vite", [
  "node",
  "node_modules/vite/bin/vite.js",
  "examples/skeleton-pwa",
  "--host",
  "127.0.0.1",
  "--port",
  "5175",
]);

function start(name, command) {
  const [executable, ...args] = command;
  const child = spawn(executable, args, {
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code && !isShuttingDown) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });
}

function shutdown(code = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
