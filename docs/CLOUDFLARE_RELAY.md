# Cloudflare Relay Setup

This setup is for networks where clients cannot reach a local host directly,
even on port `80`.

The static dashboard and the WebSocket relay are two different deploy targets:

- **Pages/static site** serves the dashboard, documentation and example games.
- **Worker relay** serves only the WebSocket signaling endpoint on `443`.

Do not use `npx wrangler deploy` as the deploy command of the static Pages
project. That command deploys the relay Worker, not the static dashboard.

## 1. Create A Cloudflare Account

Use the Free plan. Do not enable paid Workers features while testing.

## 2. Static Dashboard On Cloudflare Pages

Create a Cloudflare Pages project connected to this repository.

Use these build settings:

```text
Framework preset: None
Build command: npm run cloudflare:pages:build
Build output directory: pages-dist
Deploy command: leave empty
Root directory: leave empty if this repository root is Game_Network
```

If Cloudflare asks for a deploy command and suggests `npx wrangler deploy`, clear
that field for the Pages project. The Pages project only needs the output folder
`pages-dist`.

## 3. Worker Relay

The relay Worker lives in:

```text
workers/game-network-relay/wrangler.jsonc
```

The repository root also contains `wrangler.jsonc` pointing at that Worker, so a
Cloudflare connected build that runs this pair from the repository root is valid:

```text
Build command: npm run build
Deploy command: npx wrangler deploy
```

Deploy it as a separate Worker project, or run the deploy command from this
repository root.

### Option A: Cloudflare Dashboard / Connected Build

Use this command when Cloudflare asks how to deploy the Worker:

```bash
npm run cloudflare:relay:deploy
```

### Option B: Local Machine

Install Wrangler once:

On the development machine:

```bash
npm install -g wrangler
wrangler login
```

`wrangler login` opens a browser and authorizes the CLI.

From the repository root:

```bash
npm run cloudflare:relay:deploy
```

Cloudflare prints a URL shaped like:

```text
https://game-network.<account>.workers.dev
```

The WebSocket relay URL is:

```text
wss://game-network.<account>.workers.dev/ws
```

The static dashboard automatically adds `?room=ROOM-ID`.

Current deployed relay:

```text
wss://game-network.giuseppe-levi.workers.dev/ws
```

The same Worker also provides short redirect links for human-readable invites:

```text
https://game-network.giuseppe-levi.workers.dev/j/CHESS-1
https://game-network.giuseppe-levi.workers.dev/h/CHESS-1
```

## 4. Test

Open the GitHub Pages dashboard:

```text
https://<github-user>.github.io/game-network/
```

Paste the relay URL:

```text
wss://game-network.<account>.workers.dev/ws
```

Then:

1. choose a room;
2. click **Apri host**;
3. click **Copia link guest**;
4. open the guest link in another browser or another machine.

## Free-Tier Guard Rails

The Worker has local limits before Cloudflare limits are reached:

- max 8 WebSocket clients per room;
- max 32 KiB per message;
- max 240 messages per 10 seconds per socket;
- explicit room id required.

If the free service saturates, connections fail or close. It should not silently
scale into a paid workload while the account remains on the Free plan.
