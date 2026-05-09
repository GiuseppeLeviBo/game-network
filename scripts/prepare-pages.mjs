import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outDir = join(rootDir, "pages-dist");
const publicRelayUrl = "wss://game-network.giuseppe-levi.workers.dev/ws";
const publicShortLinkBase = "https://game-network.giuseppe-levi.workers.dev";

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await copyIfExists("single-file-chess-game", "single-file-chess-game");
await copyIfExists("dist/src", "dist/src");
await copyIfExists("docs", "docs");
await copyIfExists("games", "games");
await copyIfExists("README.md", "README.md");
await writeFile(join(outDir, ".nojekyll"), "");
await writeFile(join(outDir, "index.html"), renderIndex(), "utf8");

console.log(`GitHub Pages artifact ready: ${outDir}`);

async function copyIfExists(from, to) {
  try {
    await cp(join(rootDir, from), join(outDir, to), { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function renderIndex() {
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Game Network</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, Arial, sans-serif; background: #101827; color: #e5edf8; }
    body { margin: 0; min-height: 100vh; background: #101827; }
    main { max-width: 980px; margin: 0 auto; padding: 36px 20px 48px; }
    header { border-bottom: 1px solid #314156; padding-bottom: 24px; margin-bottom: 24px; }
    h1 { margin: 0 0 10px; font-size: 34px; }
    h2 { margin: 0 0 12px; font-size: 20px; }
    p { color: #adc0d8; line-height: 1.55; }
    a { color: #fbbf24; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .panel { background: #1c293b; border: 1px solid #34465e; border-radius: 12px; padding: 20px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 0 16px; border-radius: 10px; background: #f59e0b; color: #111827; text-decoration: none; font-weight: 800; }
    .secondary { background: #34465e; color: #e5edf8; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
    label { display: block; color: #9fb4d0; font-size: 12px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; margin: 12px 0 7px; }
    input, select { box-sizing: border-box; width: 100%; min-height: 42px; border: 1px solid #34465e; border-radius: 10px; background: #070d1a; color: #e5edf8; padding: 0 12px; font: inherit; }
    code, .code { font-family: Consolas, monospace; background: #070d1a; border: 1px solid #223047; border-radius: 10px; padding: 10px; overflow-wrap: anywhere; color: #bfdbfe; }
    .code { display: block; }
    .status { color: #86efac; font-family: Consolas, monospace; }
    .wide { grid-column: 1 / -1; }
    .toast { min-height: 20px; color: #86efac; font-size: 13px; margin-top: 10px; }
    .error { color: #fca5a5; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 29px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="status">STATIC BUILD</p>
      <h1>Game Network</h1>
      <p>Dashboard statica pubblicata da GitHub Pages. Il gioco di scacchi puo girare in locale standalone oppure usare un relay WebSocket pubblico per il multiplayer via Internet.</p>
    </header>

    <section class="grid">
      <div class="panel wide">
        <h2>Internet Multiplayer Test</h2>
        <p>Relay Cloudflare gia configurato. Scegli stanza e colore host, poi apri la pagina host e condividi il link guest.</p>
        <label for="relayUrl">Relay WSS</label>
        <input id="relayUrl" value="${publicRelayUrl}" placeholder="${publicRelayUrl}">
        <label for="room">Stanza</label>
        <input id="room" value="CHESS-1">
        <label for="hostColor">Colore host</label>
        <select id="hostColor">
          <option value="white">Bianco</option>
          <option value="black">Nero</option>
        </select>
        <div class="row">
          <a id="openHost" class="button" href="single-file-chess-game/">Apri host</a>
          <button id="copyGuest" class="button secondary" type="button">Copia link guest</button>
          <button id="newRoom" class="button secondary" type="button">Nuova stanza</button>
        </div>
        <label>Link guest breve</label>
        <span id="guestLink" class="code">Configura il relay WSS.</span>
        <div id="copyStatus" class="toast" aria-live="polite"></div>
      </div>

      <div class="panel">
        <h2>Chess Example Locale</h2>
        <p>Apri il gioco in modalita standalone. Questa pagina non avvia un server sulla tua macchina.</p>
        <div class="row">
          <a class="button" href="single-file-chess-game/">Apri scacchi</a>
          <a class="button secondary" href="single-file-chess-game/index.html?transport=standalone">Standalone</a>
        </div>
      </div>

      <div class="panel">
        <h2>Servizio LAN locale</h2>
        <p>Per giocare in LAN con servizio locale, usa ancora il launcher Node sulla macchina host.</p>
        <span class="code">npm run play:chess</span>
        <p>Su reti bloccate serve invece un relay pubblico WSS su porta 443.</p>
      </div>

      <div class="panel">
        <h2>Relay pubblico</h2>
        <p>Endpoint Cloudflare Workers Free configurato per questa dashboard:</p>
        <span class="code">${publicRelayUrl}</span>
        <p>Host e guest useranno entrambi connessioni in uscita su 443.</p>
      </div>

      <div class="panel">
        <h2>Documentazione</h2>
        <p>Guide per giocatori, sviluppatori e deployment.</p>
        <div class="row">
          <a class="button secondary" href="README.md">README</a>
          <a class="button secondary" href="docs/CHESS_PLAYER_GUIDE.md">Chess guide</a>
          <a class="button secondary" href="docs/DEVELOPER_API.md">API</a>
          <a class="button secondary" href="docs/DEPLOYMENT.md">Deployment</a>
        </div>
      </div>
    </section>
  </main>
  <script>
    const relayInput = document.getElementById('relayUrl');
    const roomInput = document.getElementById('room');
    const hostColorInput = document.getElementById('hostColor');
    const openHost = document.getElementById('openHost');
    const guestLink = document.getElementById('guestLink');
    const copyStatus = document.getElementById('copyStatus');

    function cleanRoom(value) {
      return String(value || 'CHESS-1').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'CHESS-1';
    }

    function makeRoom() {
      return 'CHESS-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    }

    function signalingUrlForRoom() {
      const raw = relayInput.value.trim();
      if (!raw) return null;
      if (!/^(wss?|https?):\\/\\//i.test(raw)) throw new Error('Relay non valido');
      const parsed = new URL(raw, window.location.href);
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') throw new Error('Relay non valido');
      if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/ws';
      parsed.searchParams.set('room', cleanRoom(roomInput.value));
      return parsed.toString();
    }

    function chessUrl(role) {
      const room = cleanRoom(roomInput.value);
      const hostPeer = 'chess-host-' + room;
      const guestPeer = 'chess-guest-' + room;
      const signaling = signalingUrlForRoom();
      const hostColor = hostColorInput.value === 'black' ? 'black' : 'white';
      if (!signaling) throw new Error('Inserisci il relay WSS');
      const params = new URLSearchParams({
        transport: 'websocket',
        role,
        room,
        peer: role === 'host' ? hostPeer : guestPeer,
        signaling,
        hostColor,
      });
      if (role === 'guest') params.set('host', hostPeer);
      return new URL('single-file-chess-game/index.html?' + params.toString(), window.location.href).toString();
    }

    function shortGuestUrl() {
      const room = cleanRoom(roomInput.value);
      const hostColor = hostColorInput.value === 'black' ? 'black' : 'white';
      const url = new URL('/j/' + encodeURIComponent(room), '${publicShortLinkBase}');
      if (hostColor === 'black') url.searchParams.set('hostColor', 'black');
      return url.toString();
    }

    function updateLinks() {
      try {
        const hostUrl = chessUrl('host');
        chessUrl('guest');
        const guestUrl = shortGuestUrl();
        openHost.href = hostUrl;
        guestLink.textContent = guestUrl;
        copyStatus.textContent = '';
        copyStatus.className = 'toast';
      } catch (error) {
        openHost.href = 'single-file-chess-game/';
        guestLink.textContent = 'Configura un relay WSS valido.';
        copyStatus.textContent = error.message;
        copyStatus.className = 'toast error';
      }
    }

    async function copyGuestLink() {
      const text = guestLink.textContent;
      if (!text || !text.startsWith('http')) return;
      try {
        await navigator.clipboard.writeText(text);
        copyStatus.textContent = 'Link guest copiato.';
        copyStatus.className = 'toast';
      } catch {
        copyStatus.textContent = 'Copia bloccata: seleziona il link e premi Ctrl+C.';
        copyStatus.className = 'toast error';
      }
    }

    relayInput.addEventListener('input', updateLinks);
    roomInput.addEventListener('input', updateLinks);
    hostColorInput.addEventListener('change', updateLinks);
    document.getElementById('copyGuest').addEventListener('click', copyGuestLink);
    document.getElementById('newRoom').addEventListener('click', () => {
      roomInput.value = makeRoom();
      updateLinks();
    });
    updateLinks();
  </script>
</body>
</html>`;
}
