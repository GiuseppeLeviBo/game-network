import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outDir = join(rootDir, "pages-dist");

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
    code, .code { font-family: Consolas, monospace; background: #070d1a; border: 1px solid #223047; border-radius: 10px; padding: 10px; overflow-wrap: anywhere; color: #bfdbfe; }
    .code { display: block; }
    .status { color: #86efac; font-family: Consolas, monospace; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 29px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="status">STATIC BUILD</p>
      <h1>Game Network</h1>
      <p>Dashboard statica pubblicata da GitHub Pages. Il gioco di scacchi puo girare in locale standalone; il multiplayer via Internet richiede un relay WebSocket pubblico, che sara il prossimo blocco.</p>
    </header>

    <section class="grid">
      <div class="panel">
        <h2>Chess Example</h2>
        <p>Apri il gioco in modalita locale. Questa pagina non avvia un server sulla tua macchina.</p>
        <div class="row">
          <a class="button" href="single-file-chess-game/">Apri scacchi</a>
          <a class="button secondary" href="single-file-chess-game/index.html?transport=standalone">Standalone</a>
        </div>
      </div>

      <div class="panel">
        <h2>Modalita locale</h2>
        <p>Per giocare in LAN con servizio locale, usa ancora il launcher Node sulla macchina host.</p>
        <span class="code">npm run play:chess</span>
        <p>Su reti bloccate serve invece un relay pubblico WSS su porta 443.</p>
      </div>

      <div class="panel">
        <h2>Prossimo relay pubblico</h2>
        <p>La forma prevista sara un endpoint Cloudflare Workers Free, per esempio:</p>
        <span class="code">wss://&lt;nome-worker&gt;.&lt;account&gt;.workers.dev/ws</span>
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
</body>
</html>`;
}
