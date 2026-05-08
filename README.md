# Game Network

Game Network is a small TypeScript networking layer and local launcher for
browser games.

It has two audiences:

- **Players / teachers**: start one local app, share one simple link, play from
  another browser with no client installation.
- **Developers**: integrate the room, transport, snapshot, input, and clock-sync
  APIs into any host-authoritative browser game.

The included chess app is an example game and a practical test bed. The network
system is intended to remain independent from chess so future games can reuse the
same service.

## Try It Online

Open the hosted dashboard:

```text
https://giuseppelevibo.github.io/game-network/
```

It uses the deployed Cloudflare relay by default:

```text
wss://game-network.giuseppe-levi.workers.dev/ws
```

Choose or generate a room, open the host page, then share the guest link.

## Quick Start For A Player Or Teacher

Install once on the host machine:

```bash
npm install
```

Start the chess launcher:

```bash
npm run play:chess
```

The launcher opens a browser dashboard. From there:

1. choose or generate a room code;
2. choose the host color;
3. click **Apri partita host**;
4. click **Copia link** and send the invite link through WhatsApp, mail, Teams,
   or any other messaging tool.

The guest opens the link in a browser and does not install anything.

`play:chess` uses a single HTTP port for dashboard, game files, invite links and
WebSocket signaling. For restricted networks that only allow standard web
ports, run the same launcher on port `80`:

```bash
npm run play:chess -- --port 80
```

On Windows, binding port `80` may require an administrator shell and the port
must be free.

More details: [Chess Player Guide](docs/CHESS_PLAYER_GUIDE.md).

## Quick Start For A Developer

Build and run tests:

```bash
npm run build
npm run test
npm run test:chess
```

Use the core API in a game:

```ts
import { GuestRoom, HostRoom } from "@local/game-network";
```

The host owns the authoritative simulation. Guests send inputs. The host applies
them and broadcasts snapshots or events.

More details: [Developer API Guide](docs/DEVELOPER_API.md).

## Current Distribution Shape

Game Network currently ships as one local Node project with:

- a reusable game networking library in `src/`;
- a local WebSocket hub;
- a single-port launcher/server;
- an included chess demo under `single-file-chess-game/`;
- automated Node and Playwright tests.

The intended packaged shape is:

- **Game Network service**: installed once on the host machine, exposes HTTP,
  WebSocket signaling, room links, and static game hosting;
- **games**: served by the service and integrated through the Game Network API;
- **guests**: browser-only, no installation.

Design notes: [Architecture And Service Model](docs/ARCHITECTURE.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run play:chess` | Player-facing chess launcher on one port, default `9201`, WebSocket path `/ws`. |
| `npm run play:chess -- --port 80` | Same chess launcher on privileged port `80`. |
| `npm run play:chess --port=80` | Convenience form supported through npm config variables. |
| `npm run service` | Generic Game Network service on one port, default `9201`; it does not open a game. |
| `npm run service -- --port 80` | Generic service on privileged port `80`. |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm run test` | Build and run Node unit tests. |
| `npm run test:chess` | Run the browser chess integration tests. |
| `npm run test:browser` | Run all Playwright browser tests. |
| `npm run test:all` | Run Node and browser tests. |
| `npm run dev:websocket-hub` | Start only the local WebSocket hub on `127.0.0.1:9100`. |
| `npm run dev:websocket-hub:lan` | Start only the WebSocket hub on `0.0.0.0:9100`. |
| `npm run dev:webrtc-stack` | Start the older multi-server transport test stack. |

The `dev:*` commands are for developers and transport debugging. The player
flow should use `play:chess`. The reusable service flow should use `service`.

Common launcher options after `--`:

```bash
npm run play:chess -- --port 80
npm run service -- --port 80
npm run service -- --port 8080
```

## Single-Port Mode

In single-port mode, the same server handles:

- dashboard;
- short invite links such as `/join/CHESS-A1B2`;
- static game files;
- WebSocket signaling on `/ws`.

Example:

```text
http://192.168.0.197:9201/join/CHESS-A1B2
ws://192.168.0.197:9201/ws
```

This is the preferred model for managed and locked-down networks.
On port `80`, the same URLs omit `:9201`. Port `443` will require HTTPS/WSS and
certificate configuration.

More details: [Deployment Guide](docs/DEPLOYMENT.md).

For managed networks where local hosting is blocked, deploy the public relay:
[Cloudflare Relay Setup](docs/CLOUDFLARE_RELAY.md).

Cloudflare has two separate targets:

- static dashboard: build command `npm run cloudflare:pages:build`, output
  directory `pages-dist`, no deploy command;
- relay Worker: build command `npm run build`, deploy command
  `npx wrangler deploy` from the repository root, or
  `npm run cloudflare:relay:deploy`.

Current relay endpoint:

```text
wss://game-network.giuseppe-levi.workers.dev/ws
```

## Adding A Game To The Service Dashboard

Put static game files under `games/<id>/` and register the entry point in
`games/catalog.json`. The service dashboard reads that catalog at startup and
shows the game link.

Minimal entry:

```json
{
  "id": "qix",
  "title": "QIX",
  "entry": "/games/qix/index.html",
  "description": "Local multiplayer QIX demo"
}
```

The game should use the printed service URL and the `/ws` WebSocket path, for
example `ws://<service-ip>:9201/ws` or `ws://<service-ip>/ws` on port `80`.

## Room Links And Room Ownership

The service does not currently maintain an authoritative room registry. A room
comes alive when a browser page opens a host URL for that room.

That means:

- `/join/ROOM` is a guest invite page;
- `/host/ROOM` opens a host page for that room;
- `/?room=ROOM` opens the dashboard preloaded with that room code.

On a trusted LAN this is useful: any machine that can reach the service can open
a host page and create a room with a chosen id. It also means room ids are not a
security boundary. Future service versions may add a room registry, admin page,
host tokens, and explicit room ownership.

## Repository Layout

```text
Game_Network/
  docs/
    ARCHITECTURE.md
    CHESS_EXAMPLE_INTEGRATION.md
    CHESS_PLAYER_GUIDE.md
    CLOUDFLARE_RELAY.md
    DEPLOYMENT.md
    DEVELOPER_API.md
  Notes/
    game_network_spec.md
    PROTOCOLLO DI SINCRONIZZAZIONE.md
  examples/
    skeleton-pwa/
  games/
    catalog.json
  single-file-chess-game/
    index.html
  src/
    clockSync.ts
    gameLauncherCli.ts
    room.ts
    transport.ts
    webSocketHubServer.ts
    webSocketTransport.ts
    ...
  tests/
```

## Test Coverage

Current coverage includes:

- protocol envelope validation;
- fake transport direct and broadcast delivery;
- host/guest room lifecycle;
- room limits and input routing;
- host snapshot delivery;
- low-level clock sync math and sampling;
- chess browser integration with host snapshots, guest moves, color assignment,
  and automatic black perspective.

## Roadmap Before Publishing

- Decide package names and exported entry points.
- Separate service launcher from example games in package layout.
- Add a room registry and optional host/admin ownership controls.
- Add HTTPS/WSS configuration for `443`.
- Extend the game catalog into full per-game launchers.
- Harden disconnect/reconnect handling.
- Add API reference generated from TypeScript declarations.
- Publish to GitHub, then prepare npm metadata.

## Example Game Documentation

The chess app is documented as an example integration, separate from the generic
developer API:

[Chess Example Integration](docs/CHESS_EXAMPLE_INTEGRATION.md)
