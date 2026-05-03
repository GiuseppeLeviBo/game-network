import { startWebSocketHubServer } from "./webSocketHubServer.js";

const port = Number(readArg("--port") ?? process.env.PORT ?? 9100);
const host = readArg("--host") ?? process.env.HOST ?? "127.0.0.1";

startWebSocketHubServer({ port, host });

console.log(`WebSocket hub listening on ws://${host}:${port}`);

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

