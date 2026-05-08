# Architecture And Service Model

Game Network is intended to become a reusable local service plus a game API.

## Layers

```text
Browser game
  uses HostRoom / GuestRoom / ClockSync

Game Network client API
  room lifecycle, player ids, inputs, snapshots, events

Transport
  WebSocketTransport today, WebRTC transports available for development

Game Network service
  dashboard, invite links, static game hosting, WebSocket hub

LAN / browser
```

## Current Host-Authoritative Model

The game is still responsible for game rules.

The host browser:

- creates the room;
- owns the authoritative state;
- accepts guest inputs;
- applies legal moves/actions;
- broadcasts snapshots.

The guest browser:

- joins a room;
- sends local inputs;
- may render optimistically;
- accepts the host snapshot as the source of truth.

The service does not simulate chess. It serves files and relays messages.

## Service Versus Game

The long-term goal is to install the Game Network service once on a machine and
let games attach to it.

The service should provide:

- HTTP server;
- WebSocket signaling/relay;
- room/invite URL generation;
- optional room registry;
- static game hosting;
- diagnostics;
- future HTTPS/WSS support.

Games should provide:

- game assets and UI;
- game-specific host and guest boot code;
- input type;
- snapshot type;
- player assignment rules;
- game-specific room options.

## Current Launcher

`src/gameLauncherCli.ts` is the first combined service prototype.

It currently knows about the chess demo, but its responsibilities are already
close to the desired generic service:

- starts HTTP;
- starts or attaches WebSocket hub;
- detects LAN address;
- opens the system browser;
- renders dashboard;
- creates short host/join links;
- serves static files.

## Game Catalog

The generic service reads `games/catalog.json` and shows registered games in
the service dashboard. A game entry has this shape:

```ts
type GameManifest = {
  id: string;
  title: string;
  entry: string;
  description?: string;
};
```

For example:

```text
games/qix/index.html
games/qix/assets/...
games/catalog.json
```

The current chess launcher still has player-friendly `/host/:room` and
`/join/:room` shortcuts because it is the first packaged example. Future
multi-game links can be built on top of the same catalog, for example:

```text
/games/chess/host/CHESS-A1B2
/games/chess/join/CHESS-A1B2
/games/qix/host/QIX-7K9D
/games/qix/join/QIX-7K9D
```

Each game should receive a bootstrap object or equivalent URL parameters:

```ts
type GameBootstrap = {
  gameId: string;
  role: "host" | "guest";
  room: string;
  peer: string;
  hostPeer?: string;
  signalingUrl: string;
  options: Record<string, string>;
};
```

## Room Creation From Client URLs

Today, room ownership is browser-driven.

If a machine opens:

```text
http://server/?room=CHESS-DEMO
```

it receives the dashboard preloaded with `CHESS-DEMO`. If it then opens the host
page, that browser becomes the host for that room.

This is useful in a classroom:

- any teacher machine can create a room from a known code;
- a room code can be reused intentionally for a demonstration;
- the service can serve multiple independent rooms at the same time.

But it also means:

- room ids are not secret credentials;
- the service does not yet reserve rooms;
- two hosts using the same room and peer id will conflict.

Future service versions should add:

- room registry;
- host tokens;
- dashboard-only admin controls;
- explicit room status;
- room expiry and cleanup.

## Single-Port Mode

Single-port mode is the default. The WebSocket hub is attached to the same HTTP
server:

```text
GET /                    dashboard
GET /host/:room          configured host page
GET /join/:room          configured guest page
GET /single-file-chess-game/...
GET /games/...
WS  /ws                  signaling / relay
```

This is the preferred deployment shape for locked-down networks because it uses
only one externally visible port. The `--split-port` option remains available
for transport debugging.
