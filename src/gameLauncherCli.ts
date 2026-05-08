import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toString as qrToString } from "qrcode";
import { attachWebSocketHubServer, startWebSocketHubServer } from "./webSocketHubServer.js";

const wsPort = Number(readOption("ws-port", "WS_PORT") ?? 9100);
const host = readOption("host", "HOST") ?? "0.0.0.0";
const singlePort = !hasArg("--split-port") && !hasArg("--split");
const httpPort = Number(readOption("http-port", "HTTP_PORT") ?? readOption("port", "PORT") ?? 9201);
const serviceOnly = hasArg("--service-only");
const wsPath = readOption("ws-path", "WS_PATH") ?? "/ws";
const shouldOpenBrowser = !hasArg("--no-open") && !serviceOnly;
const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
const lanAddress = findLanIpv4Addresses()[0]?.address ?? "127.0.0.1";
const publicBaseUrl = `http://${formatHostPort(lanAddress, httpPort)}`;
const publicSignalingUrl = singlePort
  ? `ws://${formatHostPort(lanAddress, httpPort)}${wsPath}`
  : `ws://${formatHostPort(lanAddress, wsPort)}`;

type GameManifest = {
  id: string;
  title: string;
  entry: string;
  description?: string;
};

const server = createServer((request, response) => {
  void handleRequest(request, response);
});
const hub = singlePort
  ? attachWebSocketHubServer({ server, path: wsPath })
  : startWebSocketHubServer({ host, port: wsPort });

server.listen(httpPort, host, () => {
  const dashboardUrl = serviceOnly ? publicBaseUrl : `${publicBaseUrl}/?room=${createRoomCode()}`;
  console.log("");
  console.log(serviceOnly ? "Game Network service ready" : "Game Network launcher ready");
  console.log(`  Dashboard: ${dashboardUrl}`);
  console.log(`  Signaling: ${publicSignalingUrl}`);
  if (singlePort) console.log(`  Mode: single port HTTP + WebSocket (${wsPath})`);
  console.log("");
  console.log("Keep this terminal open while players are connected.");
  if (shouldOpenBrowser) openBrowser(dashboardUrl);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const path = decodeURIComponent(url.pathname);

  if (path === "/" || path === "/dashboard") {
    if (serviceOnly) {
      sendHtml(response, await renderServiceDashboard());
      return;
    }
    sendHtml(response, await renderDashboard(url.searchParams.get("room") || createRoomCode()));
    return;
  }

  const hostMatch = path.match(/^\/host\/([A-Za-z0-9_-]+)$/);
  if (hostMatch) {
    sendHtml(response, renderGameShell("host", hostMatch[1], url.searchParams));
    return;
  }

  const joinMatch = path.match(/^\/join\/([A-Za-z0-9_-]+)$/);
  if (joinMatch) {
    sendHtml(response, renderGameShell("guest", joinMatch[1], url.searchParams));
    return;
  }

  if (path === "/qr") {
    await sendQr(response, url.searchParams.get("data") ?? publicBaseUrl);
    return;
  }

  await serveStatic(path, response);
}

async function renderServiceDashboard(): Promise<string> {
  const games = await loadGameCatalog();
  const gameCards = games
    .map(
      (game) => `<div class="game">
        <h3>${escapeHtml(game.title)}</h3>
        <p>${escapeHtml(game.description ?? "Browser game")}</p>
        <div class="code">${publicBaseUrl}${escapeHtml(game.entry)}</div>
      </div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Game Network Service</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, Arial, sans-serif; background: #0f172a; color: #e2e8f0; }
    body { margin: 0; min-height: 100vh; background: #0f172a; }
    main { max-width: 900px; margin: 0 auto; padding: 32px 20px; }
    h1 { margin: 0 0 10px; font-size: 30px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    p { color: #94a3b8; line-height: 1.5; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 22px; }
    .panel { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 20px; }
    .wide { grid-column: 1 / -1; }
    .game { border-top: 1px solid #334155; padding-top: 14px; margin-top: 14px; }
    h3 { margin: 0 0 8px; font-size: 16px; }
    .code { font-family: Consolas, monospace; background: #020617; border: 1px solid #1e293b; border-radius: 12px; padding: 12px; overflow-wrap: anywhere; color: #bfdbfe; }
    .ok { color: #86efac; font-family: Consolas, monospace; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Game Network Service</h1>
    <p class="ok">RUNNING</p>
    <p>Questo processo e il servizio generico: serve file, endpoint HTTP e WebSocket signaling. Non crea automaticamente una partita.</p>
    <section class="grid">
      <div class="panel">
        <h2>Endpoint</h2>
        <p>HTTP base</p>
        <div class="code">${publicBaseUrl}</div>
        <p>WebSocket signaling</p>
        <div class="code">${publicSignalingUrl}</div>
      </div>
      <div class="panel">
        <h2>Giochi disponibili</h2>
        <p>Il servizio serve giochi registrati nel catalogo. Il chess example e incluso come demo.</p>
        ${gameCards}
      </div>
      <div class="panel">
        <h2>Note</h2>
        <p>Per giocare subito a scacchi usa npm run play:chess. Questo pannello e il demone generico.</p>
      </div>
      <div class="panel wide">
        <h2>Aggiungere un gioco</h2>
        <p>Metti i file statici del gioco in <span class="code">games/&lt;id&gt;/</span> oppure in una cartella servita dal progetto. Poi registra il gioco in <span class="code">games/catalog.json</span> indicando id, titolo e entry HTML.</p>
        <div class="code">{
  "id": "qix",
  "title": "QIX",
  "entry": "/games/qix/index.html",
  "description": "Demo multiplayer QIX"
}</div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

async function renderDashboard(initialRoom: string): Promise<string> {
  const safeRoom = sanitizeRoom(initialRoom);
  const hostWhiteUrl = `${publicBaseUrl}/host/${safeRoom}?hostColor=white`;
  const hostBlackUrl = `${publicBaseUrl}/host/${safeRoom}?hostColor=black`;
  const joinUrl = `${publicBaseUrl}/join/${safeRoom}`;

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Game Network Launcher</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, Arial, sans-serif; background: #0f172a; color: #e2e8f0; }
    body { margin: 0; min-height: 100vh; background: #0f172a; }
    main { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 20px; }
    h1 { margin: 0; font-size: 30px; }
    h2 { margin: 0 0 16px; font-size: 18px; color: #f8fafc; }
    p { color: #94a3b8; line-height: 1.5; }
    .grid { display: grid; grid-template-columns: 1.1fr .9fr; gap: 20px; margin-top: 24px; }
    .panel { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 20px; box-shadow: 0 20px 50px rgba(2, 6, 23, .25); }
    label { display: block; color: #94a3b8; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
    input, select { width: 100%; box-sizing: border-box; background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 12px; padding: 12px; font-size: 15px; }
    button, a.button { border: 0; border-radius: 12px; padding: 12px 14px; font-weight: 800; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; color: #0f172a; background: #f59e0b; }
    button.secondary, a.secondary { background: #334155; color: #e2e8f0; }
    button.ghost { background: transparent; color: #fbbf24; border: 1px solid #475569; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .stack { display: grid; gap: 16px; }
    .linkbox { display: grid; gap: 8px; margin-top: 16px; }
    .code { font-family: Consolas, monospace; background: #020617; border: 1px solid #1e293b; border-radius: 12px; padding: 12px; overflow-wrap: anywhere; color: #bfdbfe; }
    .hint { font-size: 13px; color: #94a3b8; }
    .status { font-family: Consolas, monospace; color: #86efac; }
    .qr { display: none; margin-top: 16px; background: white; width: 220px; min-height: 220px; padding: 10px; border-radius: 12px; }
    .toast { min-height: 20px; margin-top: 10px; color: #86efac; font-size: 13px; }
    .toast.error { color: #fca5a5; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Game Network Launcher</h1>
        <p>Avvia la partita, copia il link al compagno e spiega. Il guest usa solo il browser.</p>
      </div>
      <div class="status">HTTP ${publicBaseUrl}<br>WS ${publicSignalingUrl}</div>
    </header>

    <section class="grid">
      <div class="panel stack">
        <h2>Crea stanza</h2>
        <div>
          <label for="room">Codice stanza</label>
          <input id="room" value="${safeRoom}">
        </div>
        <div>
          <label for="hostColor">Colore host</label>
          <select id="hostColor">
            <option value="white">Bianco</option>
            <option value="black">Nero</option>
          </select>
        </div>
        <div class="row">
          <button id="newRoom" class="secondary">Nuova stanza</button>
          <a id="openHost" class="button" href="${hostWhiteUrl}">Apri partita host</a>
        </div>
      </div>

      <div class="panel">
        <h2>Invito guest</h2>
        <p class="hint">Invia questo link via WhatsApp, mail o altro messaging. Chi lo apre entra nella pagina gia configurata.</p>
        <div class="linkbox">
          <label>Link semplice</label>
          <div id="joinLink" class="code">${joinUrl}</div>
        </div>
        <div class="row">
          <button id="copyJoin">Copia link</button>
          <button id="showQr" class="ghost">Mostra QR</button>
        </div>
        <div id="copyStatus" class="toast" aria-live="polite"></div>
        <img id="qr" class="qr" alt="QR link guest">
        <p class="hint">Il QR e comodo solo per giochi adatti a telefono/tablet. Per PC, copia link resta la strada maestra.</p>
      </div>
    </section>
  </main>
  <script>
    const base = ${JSON.stringify(publicBaseUrl)};
    const roomInput = document.getElementById('room');
    const hostColor = document.getElementById('hostColor');
    const openHost = document.getElementById('openHost');
    const joinLink = document.getElementById('joinLink');
    const copyButton = document.getElementById('copyJoin');
    const copyStatus = document.getElementById('copyStatus');
    const qr = document.getElementById('qr');

    function cleanRoom(value) {
      return String(value || 'CHESS-1').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'CHESS-1';
    }
    function makeRoom() {
      return 'CHESS-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    }
    async function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
      if (!copied) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(joinLink);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return copied;
    }
    function showCopyStatus(message, isError = false) {
      copyStatus.textContent = message;
      copyStatus.className = isError ? 'toast error' : 'toast';
      copyButton.textContent = isError ? 'Selezionato' : 'Copiato';
      setTimeout(() => {
        copyButton.textContent = 'Copia link';
        copyStatus.textContent = '';
        copyStatus.className = 'toast';
      }, 1800);
    }
    function updateLinks() {
      const room = cleanRoom(roomInput.value);
      const color = hostColor.value === 'black' ? 'black' : 'white';
      const hostUrl = base + '/host/' + room + '?hostColor=' + color;
      const guestUrl = base + '/join/' + room;
      openHost.href = hostUrl;
      joinLink.textContent = guestUrl;
      qr.src = '/qr?data=' + encodeURIComponent(guestUrl);
      history.replaceState(null, '', '/?room=' + encodeURIComponent(room));
    }
    document.getElementById('newRoom').addEventListener('click', () => { roomInput.value = makeRoom(); updateLinks(); });
    document.getElementById('copyJoin').addEventListener('click', async () => {
      try {
        const copied = await copyText(joinLink.textContent);
        showCopyStatus(copied ? 'Link copiato negli appunti.' : 'Copia bloccata dal browser: link selezionato, premi Ctrl+C.', !copied);
      } catch (error) {
        showCopyStatus('Copia bloccata dal browser: link selezionato, premi Ctrl+C.', true);
      }
    });
    document.getElementById('showQr').addEventListener('click', () => {
      qr.style.display = qr.style.display === 'block' ? 'none' : 'block';
      document.getElementById('showQr').textContent = qr.style.display === 'block' ? 'Nascondi QR' : 'Mostra QR';
    });
    roomInput.addEventListener('input', updateLinks);
    hostColor.addEventListener('change', updateLinks);
    updateLinks();
  </script>
</body>
</html>`;
}

function renderGameShell(role: "host" | "guest", room: string, searchParams: URLSearchParams): string {
  const safeRoom = sanitizeRoom(room);
  const hostColor = normalizeColor(searchParams.get("hostColor")) ?? "white";
  const hostPeer = `chess-host-${safeRoom}`;
  const guestPeer = `chess-guest-${safeRoom}`;
  const peer = role === "host" ? hostPeer : guestPeer;
  const gameParams = new URLSearchParams({
    transport: "websocket",
    role,
    room: safeRoom,
    peer,
    signaling: publicSignalingUrl,
  });
  if (role === "host") gameParams.set("hostColor", hostColor);
  if (role === "guest") gameParams.set("host", hostPeer);

  const title = role === "host" ? `Host ${safeRoom}` : `Guest ${safeRoom}`;
  const gameUrl = `/single-file-chess-game/?${gameParams.toString()}`;
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    html, body, iframe { margin: 0; width: 100%; height: 100%; border: 0; background: #0f172a; }
  </style>
</head>
<body>
  <iframe src="${escapeHtml(gameUrl)}" title="${title}" allow="clipboard-write"></iframe>
</body>
</html>`;
}

async function sendQr(response: ServerResponse, data: string): Promise<void> {
  const svg = await qrToString(data, {
    type: "svg",
    margin: 1,
    width: 220,
    errorCorrectionLevel: "M",
  });
  response.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" });
  response.end(svg);
}

async function serveStatic(path: string, response: ServerResponse): Promise<void> {
  const candidate = normalize(join(rootDir, path.endsWith("/") ? `${path}index.html` : path));
  if (!candidate.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(candidate);
    if (!fileStat.isFile()) throw new Error("Not a file");
    response.writeHead(200, { "Content-Type": contentType(candidate) });
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(html);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function sanitizeRoom(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return cleaned || createRoomCode();
}

function createRoomCode(): string {
  return `CHESS-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function normalizeColor(value: string | null): "white" | "black" | null {
  if (value === "white" || value === "bianco") return "white";
  if (value === "black" || value === "nero") return "black";
  return null;
}

async function loadGameCatalog(): Promise<GameManifest[]> {
  const fallback: GameManifest[] = [
    {
      id: "chess",
      title: "Single-file Chess",
      entry: "/single-file-chess-game/index.html",
      description: "Included chess example and integration test bed.",
    },
  ];
  try {
    const catalogPath = resolve(rootDir, "games", "catalog.json");
    const raw = await readFile(catalogPath, "utf8");
    const parsed = JSON.parse(raw) as { games?: GameManifest[] };
    const games = Array.isArray(parsed.games) ? parsed.games.filter(isGameManifest) : [];
    return games.length > 0 ? games : fallback;
  } catch {
    return fallback;
  }
}

function isGameManifest(value: unknown): value is GameManifest {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<GameManifest>;
  return typeof game.id === "string" && typeof game.title === "string" && typeof game.entry === "string";
}

function findLanIpv4Addresses(): Array<{ name: string; address: string; score: number }> {
  const results: Array<{ name: string; address: string; score: number }> = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const addressInfo of addresses ?? []) {
      if (addressInfo.family !== "IPv4" || addressInfo.internal) continue;
      if (addressInfo.address.startsWith("169.254.")) continue;
      results.push({ name, address: addressInfo.address, score: scoreIpv4Address(addressInfo.address) });
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

function formatHostPort(address: string, port: number): string {
  return port === 80 ? address : `${address}:${port}`;
}

function openBrowser(url: string): void {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}

function readOption(name: string, envName: string): string | undefined {
  const argName = `--${name}`;
  const assignmentPrefix = `${argName}=`;
  const assignedArg = process.argv.find((arg) => arg.startsWith(assignmentPrefix));
  if (assignedArg) return assignedArg.slice(assignmentPrefix.length);

  const index = process.argv.lastIndexOf(argName);
  if (index >= 0) return process.argv[index + 1];

  const npmConfigName = `npm_config_${name.replace(/-/g, "_")}`;
  return process.env[npmConfigName] ?? process.env[envName];
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function shutdown(code: number): void {
  hub.close();
  server.close(() => process.exit(code));
}
