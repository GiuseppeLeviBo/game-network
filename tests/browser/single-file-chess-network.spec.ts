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
    await expect(host.locator("#playerBadge")).toHaveText("Bianco (Tu)");
    await expect(guest.locator("#playerBadge")).toHaveText("Nero (Tu)");

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
    await expect.poll(() => guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getSnapshot().oneWay)).not.toBe("--");
    await expect.poll(() => host.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getSnapshot().oneWaySamples)).not.toBe("0");
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

test("single-file chess connects through native WebRTC transport", async ({ browser }) => {
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

  const room = `CHESS-RTC-${Date.now()}`;
  const hostUrl = `${hostServer.url}/single-file-chess-game/?transport=native-webrtc&role=host&room=${room}&peer=chess-host-${room}&signaling=${hub.url}`;
  const guestUrl = `${guestServer.url}/single-file-chess-game/?transport=native-webrtc&role=guest&room=${room}&peer=chess-guest-${room}&host=chess-host-${room}&signaling=${hub.url}`;

  let failed = false;
  try {
    await host.goto(hostUrl);
    await guest.goto(guestUrl);

    await expectConnected(host);
    await expectConnected(guest);
    await expect(host.locator("#networkTransport")).toHaveText("native-webrtc");
    await expect(guest.locator("#networkTransport")).toHaveText("native-webrtc");

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

test("diagnostic probes exercise adaptive timing without changing the chess game", async ({ browser }) => {
  const hub = await startHub();
  const hostServer = await startStaticServer(gameNetworkRoot);
  const guestServer = await startStaticServer(gameNetworkRoot);
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  await installChessPageStubs(host);
  await installChessPageStubs(guest);

  const room = `CHESS-PROBE-${Date.now()}`;
  const hostUrl = `${hostServer.url}/single-file-chess-game/?transport=websocket&role=host&room=${room}&peer=chess-host-${room}&signaling=${hub.url}`;
  const guestUrl = `${guestServer.url}/single-file-chess-game/?transport=websocket&role=guest&room=${room}&peer=chess-guest-${room}&host=chess-host-${room}&signaling=${hub.url}`;

  try {
    await host.goto(hostUrl);
    await guest.goto(guestUrl);

    await expectConnected(host);
    await expectConnected(guest);

    const hostFenBefore = await fen(host);
    const guestFenBefore = await fen(guest);

    await host.evaluate(() => window.__CHESS_GAME_NETWORK__.sendDiagnosticProbe());
    await expect.poll(() => guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getSnapshot().probeSamples)).not.toBe("0");
    await expect.poll(() => guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getSnapshot().lookahead)).not.toBe("--");
    await expect.poll(() => guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getSnapshot().probeSlack)).not.toBe("--");
    await expect
      .poll(() => guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getSnapshot().timelineClock))
      .toMatch(/^\d+:\d{2}:\d{2}\.\d{3}$/);
    await expect
      .poll(() => guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getTelemetry().samples.length))
      .toBeGreaterThan(0);
    await expect
      .poll(() => guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getTelemetry().probes.length))
      .toBeGreaterThan(0);
    await expect(guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getTelemetryCsv())).resolves.toContain("probeSlackMs");
    await expect
      .poll(() => host.evaluate(() => ((window.__CHESS_NETWORK_DIAGNOSTICS__.getTelemetry() as unknown) as { remoteRows: unknown[] }).remoteRows.length), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect(host.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getTelemetryCsv())).resolves.toContain("source");
    await expect(host.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getTelemetryCsv())).resolves.toContain("remote");

    await expect.poll(() => guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getSnapshot().oneWaySamples)).not.toBe("0");
    await expect.poll(() => guest.evaluate(() => window.__CHESS_GAME_ADAPTER__.getSnapshot().fen)).toBe(guestFenBefore);

    await expect
      .poll(async () => {
        await guest.evaluate(() => window.__CHESS_GAME_NETWORK__.sendDiagnosticProbe());
        return host.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getSnapshot().probeSamples);
      })
      .not.toBe("0");
    await expect.poll(() => host.evaluate(() => window.__CHESS_GAME_ADAPTER__.getSnapshot().fen)).toBe(hostFenBefore);
  } finally {
    await context.close();
    await closeServer(hostServer.server);
    await closeServer(guestServer.server);
    await closeServer(hub.server);
  }
});

test("single-file chess can assign black to the host and rotates local black perspective", async ({ browser }) => {
  const hub = await startHub();
  const hostServer = await startStaticServer(gameNetworkRoot);
  const guestServer = await startStaticServer(gameNetworkRoot);
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  await installChessPageStubs(host);
  await installChessPageStubs(guest);

  const room = `CHESS-COLOR-${Date.now()}`;
  const hostUrl = `${hostServer.url}/single-file-chess-game/?transport=websocket&role=host&room=${room}&peer=chess-host-${room}&hostColor=black&signaling=${hub.url}`;
  const guestUrl = `${guestServer.url}/single-file-chess-game/?transport=websocket&role=guest&room=${room}&peer=chess-guest-${room}&host=chess-host-${room}&signaling=${hub.url}`;

  try {
    await host.goto(hostUrl);
    await guest.goto(guestUrl);

    await expectConnected(host);
    await expectConnected(guest);
    await expect(host.locator("#playerBadge")).toHaveText("Nero (Tu)");
    await expect(guest.locator("#playerBadge")).toHaveText("Bianco (Tu)");
    await expect(host.locator("#chessboard > div").first()).toHaveAttribute("data-square", "H1");
    await expect(guest.locator("#chessboard > div").first()).toHaveAttribute("data-square", "A8");
  } finally {
    await context.close();
    await closeServer(hostServer.server);
    await closeServer(guestServer.server);
    await closeServer(hub.server);
  }
});

test("single-file chess restarts a network game without reload and swaps colors", async ({ browser }) => {
  const hub = await startHub();
  const hostServer = await startStaticServer(gameNetworkRoot);
  const guestServer = await startStaticServer(gameNetworkRoot);
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  await installChessPageStubs(host);
  await installChessPageStubs(guest);

  const room = `CHESS-RESTART-${Date.now()}`;
  const hostUrl = `${hostServer.url}/single-file-chess-game/?transport=websocket&role=host&room=${room}&peer=chess-host-${room}&hostColor=white&signaling=${hub.url}`;
  const guestUrl = `${guestServer.url}/single-file-chess-game/?transport=websocket&role=guest&room=${room}&peer=chess-guest-${room}&host=chess-host-${room}&signaling=${hub.url}`;

  try {
    await host.goto(hostUrl);
    await guest.goto(guestUrl);

    await expectConnected(host);
    await expectConnected(guest);
    await expect(host.locator("#playerBadge")).toHaveText("Bianco (Tu)");
    await expect(guest.locator("#playerBadge")).toHaveText("Nero (Tu)");

    await host.evaluate(() => {
      window.__CHESS_GAME_ADAPTER__.applyMove({ from: "E2", to: "E4" });
      window.__CHESS_GAME_NETWORK__.sendSnapshot();
    });
    await expectFenToContain(guest, '"E4":"P"');

    await guest.evaluate(() => {
      window.__CHESS_GAME_NETWORK__.sendRestartRequest();
    });

    await expect(host.locator("#playerBadge")).toHaveText("Nero (Tu)", { timeout: 10_000 });
    await expect(guest.locator("#playerBadge")).toHaveText("Bianco (Tu)", { timeout: 10_000 });
    await expectFenToContain(host, '"E2":"P"');
    await expectFenToContain(guest, '"E2":"P"');
    await expect.poll(() => guest.evaluate(() => window.__CHESS_GAME_ADAPTER__.getSnapshot().fen)).not.toContain('"E4":"P"');
    await expect(host.locator("#gameOverModal")).toHaveClass(/hidden/);
    await expect(guest.locator("#gameOverModal")).toHaveClass(/hidden/);
  } finally {
    await context.close();
    await closeServer(hostServer.server);
    await closeServer(guestServer.server);
    await closeServer(hub.server);
  }
});

test("guest game-over restart button asks host for a new swapped-color game", async ({ browser }) => {
  const hub = await startHub();
  const hostServer = await startStaticServer(gameNetworkRoot);
  const guestServer = await startStaticServer(gameNetworkRoot);
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  await installChessPageStubs(host);
  await installChessPageStubs(guest);

  const room = `CHESS-GAMEOVER-${Date.now()}`;
  const hostUrl = `${hostServer.url}/single-file-chess-game/?transport=websocket&role=host&room=${room}&peer=chess-host-${room}&hostColor=white&signaling=${hub.url}`;
  const guestUrl = `${guestServer.url}/single-file-chess-game/?transport=websocket&role=guest&room=${room}&peer=chess-guest-${room}&host=chess-host-${room}&signaling=${hub.url}`;

  try {
    await host.goto(hostUrl);
    await guest.goto(guestUrl);

    await expectConnected(host);
    await expectConnected(guest);

    await guest.evaluate(() => {
      document.getElementById("gameOverModal")?.classList.remove("hidden");
    });
    await expect(guest.locator("#gameOverModal")).not.toHaveClass(/hidden/);
    await guest.locator("#gameOverModal button", { hasText: "Nuova Partita" }).click();

    await expect(guest.locator("#gameOverModal")).toHaveClass(/hidden/, { timeout: 10_000 });
    await expect(host.locator("#playerBadge")).toHaveText("Nero (Tu)", { timeout: 10_000 });
    await expect(guest.locator("#playerBadge")).toHaveText("Bianco (Tu)", { timeout: 10_000 });
  } finally {
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

async function fen(page: Page) {
  return page.evaluate(() => window.__CHESS_GAME_ADAPTER__.getSnapshot().fen);
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
      sendDiagnosticProbe(): void;
      sendRestartRequest(): void;
    };
    __CHESS_NETWORK_DIAGNOSTICS__: {
      getSnapshot(): {
        quality: string;
        oneWay?: string;
        oneWaySamples?: string;
        timelineClock?: string;
        lookahead?: string;
        probeSlack?: string;
        probeSamples?: string;
      };
      getTelemetry(): { samples: unknown[]; probes: unknown[] };
      getTelemetryCsv(): string;
    };
  }
}
