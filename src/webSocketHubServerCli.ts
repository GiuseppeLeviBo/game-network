import { networkInterfaces } from "node:os";
import { startWebSocketHubServer } from "./webSocketHubServer.js";

const port = Number(readArg("--port") ?? process.env.PORT ?? 9100);
const host = readArg("--host") ?? process.env.HOST ?? "127.0.0.1";
const path = readArg("--path") ?? process.env.WS_PATH;

startWebSocketHubServer({ port, host, path });

console.log(`WebSocket hub listening on ws://${host}:${port}${path ?? ""}`);
printLanHints(host, port, path ?? "");

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function printLanHints(host: string, port: number, path: string): void {
  const lanAddresses = findLanIpv4Addresses();

  if (!isWildcardHost(host)) {
    if (isLoopbackHost(host) && lanAddresses.length > 0) {
      console.log("");
      console.log("LAN hint: this hub is bound to localhost only.");
      console.log("To accept another PC in the same network, restart it with:");
      console.log(`  node dist/src/webSocketHubServerCli.js --host 0.0.0.0 --port ${port}`);
    }
    return;
  }

  console.log("");
  console.log("Local signaling URL:");
  console.log(`  ws://127.0.0.1:${port}${path}`);

  if (lanAddresses.length === 0) {
    console.log("");
    console.log("No LAN IPv4 address found. Check Wi-Fi/Ethernet connection.");
    return;
  }

  console.log("");
  console.log("LAN signaling URL candidates:");
  for (const entry of lanAddresses) {
    console.log(`  ws://${entry.address}:${port}${path}  (${entry.name})`);
  }

  const preferred = lanAddresses[0];
  console.log("");
  console.log("Suggested chess test URLs if the static game server is on port 9201:");
  console.log(
    `  Host:  http://${preferred.address}:9201/single-file-chess-game/?transport=websocket&role=host&room=CHESS-1&peer=chess-host&hostColor=white&signaling=auto`,
  );
  console.log(
    `  Guest: http://${preferred.address}:9201/single-file-chess-game/?transport=websocket&role=guest&room=CHESS-1&peer=chess-guest&host=chess-host&signaling=auto`,
  );
}

function findLanIpv4Addresses(): Array<{ name: string; address: string; score: number }> {
  const results: Array<{ name: string; address: string; score: number }> = [];
  const interfaces = networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addressInfo of addresses ?? []) {
      if (addressInfo.family !== "IPv4" || addressInfo.internal) continue;
      if (addressInfo.address.startsWith("169.254.")) continue;
      results.push({
        name,
        address: addressInfo.address,
        score: scoreIpv4Address(addressInfo.address),
      });
    }
  }
  return results.sort((left, right) => left.score - right.score || left.name.localeCompare(right.name));
}

function scoreIpv4Address(address: string): number {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  const [first, second] = address.split(".").map(Number);
  if (first === 172 && second >= 16 && second <= 31) return 2;
  return 3;
}

function isWildcardHost(value: string): boolean {
  return value === "0.0.0.0" || value === "::" || value === "";
}

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}
