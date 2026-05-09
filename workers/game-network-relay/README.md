# Game Network Relay Worker

This Cloudflare Worker is the public Internet relay for Game Network.

It exposes:

```text
GET /health
WS  /ws?room=ROOM-ID
GET /j/ROOM-ID
GET /h/ROOM-ID
```

`/j/ROOM-ID` and `/h/ROOM-ID` are short redirects to the hosted chess guest and
host pages. They are meant for human-readable invites.

Each room is handled by one Durable Object. The browser transport protocol is
the same protocol used by the local Node WebSocket hub:

```json
{ "kind": "register", "peerId": "chess-host" }
{ "kind": "transport", "toPeerId": "chess-guest", "channel": "realtime", "data": {} }
```

## Free-Tier Safety

The Worker intentionally has small limits:

- max 8 WebSocket clients per room;
- max 32 KiB per message;
- max 240 messages per 10 seconds per socket;
- room id must be explicit in `/ws?room=...`.

If the free service becomes saturated, connections fail or close instead of
silently growing the workload.

## Deploy

Install Wrangler once:

```bash
npm install -g wrangler
wrangler login
```

Deploy from this folder:

```bash
cd workers/game-network-relay
wrangler deploy
```

Cloudflare prints a URL like:

```text
https://game-network.<account>.workers.dev
```

The WebSocket URL to use in the game is:

```text
wss://game-network.<account>.workers.dev/ws?room=CHESS-1
```
