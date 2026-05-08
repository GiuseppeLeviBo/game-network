# Cloudflare Relay Setup

This setup is for networks where clients cannot reach a local host directly,
even on port `80`.

GitHub Pages serves the dashboard and game files. Cloudflare Workers provides a
public WebSocket relay on `443`.

## 1. Create A Cloudflare Account

Use the Free plan. Do not enable paid Workers features while testing.

## 2. Install Wrangler

On the development machine:

```bash
npm install -g wrangler
wrangler login
```

`wrangler login` opens a browser and authorizes the CLI.

## 3. Deploy The Relay

From the repository root:

```bash
cd workers/game-network-relay
wrangler deploy
```

Cloudflare prints a URL shaped like:

```text
https://game-network-relay.<account>.workers.dev
```

The WebSocket relay URL is:

```text
wss://game-network-relay.<account>.workers.dev/ws
```

The static dashboard automatically adds `?room=ROOM-ID`.

## 4. Test

Open the GitHub Pages dashboard:

```text
https://<github-user>.github.io/game-network/
```

Paste the relay URL:

```text
wss://game-network-relay.<account>.workers.dev/ws
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
