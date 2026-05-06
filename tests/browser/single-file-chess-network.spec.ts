import { expect, test, type Page } from "@playwright/test";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { WebSocketServer } from "ws";
import { startWebSocketHubServer } from "../../src/webSocketHubServer.js";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const gameNetworkRoot = resolve(testDir, "../..");
type LocalServer = Server | WebSocketServer;

test("single-file chess mirrors host snapshots and guest moves over WebSocket", async ({ browser }) => {
  const hub = await startHub();
  const hostServer = await startStaticServer(gameNetworkRoot);
  const guestServer = await startStaticServer(gameNetworkRoot);
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  const pageLogs: string[] = [];
  for (const [label, page] of [["host", host], ["guest", guest]] as const) {
    page.on("console", (message) => pageLogs.push(`${label} console ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => pageLogs.push(`${label} pageerror: ${error.message}`));
  }
  await installChessPageStubs(host);
  await installChessPageStubs(guest);

  const room = `CHESS-${Date.now()}`;
  const hostUrl = `${hostServer.url}/single-file-chess-game/?transport=websocket&role=host&room=${room}&peer=chess-host-${room}&signaling=${hub.url}`;
  const guestUrl = `${guestServer.url}/single-file-chess-game/?transport=websocket&role=guest&room=${room}&peer=chess-guest-${room}&host=chess-host-${room}&signaling=${hub.url}`;

  let failed = false;
  try {
    await host.goto(hostUrl);
    await guest.goto(guestUrl);

    await expectConnected(host);
    await expectConnected(guest);

    await host.evaluate(() => {
      window.__CHESS_GAME_ADAPTER__.applyMove({ from: "E2", to: "E4" });
      window.__CHESS_GAME_NETWORK__.sendSnapshot();
    });
    await expectFenToContain(guest, '"E4":"P"');

    await guest.evaluate(() => {
      window.__CHESS_GAME_NETWORK__.sendLocalMove({ from: "E7", to: "E5" });
    });
    await expectFenToContain(host, '"E5":"p"');
    await expectFenToContain(guest, '"E5":"p"');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed && pageLogs.length > 0) console.log(pageLogs.join("\n"));
    await context.close();
    await closeServer(hostServer.server);
    await closeServer(guestServer.server);
    await closeServer(hub.server);
  }
});

async function installChessPageStubs(page: Page) {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.includes("/single-file-chess-game/")) {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/js-chess-engine@1\.0\.2\/dist\/js-chess-engine\.js"><\/script>/,
        `<script>${chessEngineStub}</script>`,
      );
      await route.fulfill({
        response,
        contentType: "text/html; charset=utf-8",
        body,
      });
      return;
    }
    if (url.includes("js-chess-engine")) {
      await route.fulfill({
        contentType: "application/javascript",
        body: "",
      });
      return;
    }
    if (url.includes("@tailwindcss") || url.includes("font-awesome") || url.includes("fonts.googleapis.com")) {
      await route.fulfill({ contentType: "text/css", body: "" });
      return;
    }
    if (url.includes("fonts.gstatic.com") || url.includes("chessboardjs.com/img")) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.continue();
  });
}

async function expectConnected(page: Page) {
  await expect(page.locator("#networkStatusBadge")).toHaveText("Collegato", { timeout: 10_000 });
}

async function expectFenToContain(page: Page, value: string) {
  await expect
    .poll(() => page.evaluate(() => window.__CHESS_GAME_ADAPTER__.getSnapshot().fen), {
      timeout: 10_000,
    })
    .toContain(value);
}

async function startHub() {
  const server = startWebSocketHubServer({ host: "127.0.0.1", port: 0 });
  await onceListening(server);
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

async function startStaticServer(root: string) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const decodedPath = decodeURIComponent(url.pathname);
    const candidate = normalize(join(root, decodedPath.endsWith("/") ? `${decodedPath}index.html` : decodedPath));
    if (!candidate.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const fileStat = await stat(candidate);
      if (!fileStat.isFile()) throw new Error("Not a file");
      response.setHeader("Content-Type", contentType(candidate));
      createReadStream(candidate).pipe(response);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function onceListening(server: LocalServer) {
  if ("listening" in server && server.listening) return Promise.resolve();
  return new Promise<void>((resolveListening) => server.once("listening", resolveListening));
}

function closeServer(server: LocalServer) {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function contentType(path: string) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

const chessEngineStub = `
{
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const start = () => ({ turn: "white", pieces: { E1: "K", E2: "P", E7: "p", E8: "k" }, isFinished: false, checkMate: false, check: false });
  class Game {
    constructor(config) {
      if (typeof config === "string") {
        try { this.state = JSON.parse(config); } catch { this.state = start(); }
      } else {
        this.state = config && config.pieces ? clone(config) : start();
      }
    }
    exportJson() { return clone(this.state); }
    exportFEN() { return JSON.stringify(this.state); }
    moves(square) {
      const normalized = String(square).toUpperCase();
      if (normalized === "E2") return ["E3", "E4"];
      if (normalized === "E7") return ["E6", "E5"];
      return [];
    }
    move(from, to) {
      const source = String(from).toUpperCase();
      const target = String(to).toUpperCase();
      const piece = this.state.pieces[source];
      if (!piece) throw new Error("No piece on source square");
      this.state.pieces[target] = piece;
      delete this.state.pieces[source];
      this.state.turn = this.state.turn === "white" ? "black" : "white";
    }
    setPiece(square, piece) {
      this.state.pieces[String(square).toUpperCase()] = piece;
    }
    aiMove() { return {}; }
  }
  window["js-chess-engine"] = { Game };
}
`;

declare global {
  interface Window {
    __CHESS_GAME_ADAPTER__: {
      applyMove(move: { from: string; to: string; promotion?: string }): boolean;
      getSnapshot(): { fen: string };
    };
    __CHESS_GAME_NETWORK__: {
      sendSnapshot(): void;
      sendLocalMove(move: { from: string; to: string; promotion?: string }): void;
    };
    __CHESS_NETWORK_DIAGNOSTICS__: {
      getSnapshot(): { quality: string };
    };
  }
}
