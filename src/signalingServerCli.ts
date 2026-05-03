import { startPeerSignalingServer } from "./signalingServer.js";

const port = Number(readArg("--port") ?? process.env.PORT ?? 9000);
const host = readArg("--host") ?? process.env.HOST ?? "127.0.0.1";
const path = readArg("--path") ?? process.env.PEER_PATH ?? "/game-network";
const allowDiscovery = hasArg("--allow-discovery");

startPeerSignalingServer({
  port,
  host,
  path,
  allowDiscovery,
});

console.log(`Peer signaling server listening on http://${host}:${port}${path}`);

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

