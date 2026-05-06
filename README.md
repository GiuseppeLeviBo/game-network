# Game Network

Game Network is a reusable TypeScript networking layer for small browser-based
multiplayer games.

It is designed for games where one player acts as host, owns the authoritative
simulation, receives guest inputs, and broadcasts snapshots or game events back
to the other players.

The first target game is a multiplayer QIX clone, but the library is intentionally
game-agnostic. Player limits, player ids, input payloads, snapshots, game events,
and room configuration are all supplied by the game.

## Current Status

This repository is in an early implementation phase.

Implemented:

- typed protocol envelopes;
- transport-agnostic room API;
- host and guest room lifecycle;
- game-configurable player limits;
- guest join and reject flow;
- guest input delivery to host;
- host snapshot and event broadcast;
- low-level host/client clock synchronization;
- in-memory fake transport for deterministic tests;
- skeleton PWA example using `BroadcastChannel`;
- PeerJS transport adapter using WebRTC DataConnections;
- local PeerServer-based signaling helper;
- skeleton PWA `transport=peerjs` mode;
- WebSocket hub and development transport;
- native WebRTC DataChannel transport with WebSocket signaling;
- single-file chess candidate demo with network diagnostics panel;
- Node unit tests;
- Playwright browser tests for `BroadcastChannel`, WebSocket, PeerJS/WebRTC,
  and native WebRTC.

Not implemented yet:

- Zeroconf/mDNS discovery;
- reconnect handling;
- separate physical DataChannels with different reliability settings;
- binary snapshot encoding;
- package publishing.

## What It Offers

Game Network gives a game a small multiplayer contract:

- create a host room;
- let guests join;
- assign stable player ids;
- send guest inputs to the host;
- broadcast authoritative snapshots from the host;
- broadcast reliable game events;
- keep the transport replaceable.

The core does not know game rules. A game decides:

- maximum players;
- player id format;
- player display names;
- input shape;
- snapshot shape;
- game event shape;
- room metadata;
- simulation rules.

## Architecture

The project is built around four layers.

### Core

The core defines:

- room lifecycle;
- protocol messages;
- player model;
- host and guest APIs;
- transport interfaces.

The core does not depend on WebRTC, PeerJS, WebSocket, or any specific game.

### Transport

Transport adapters move protocol messages between peers.

Current transport:

- `FakeNetwork` / `FakeTransport` for tests and local simulation.
- `WebSocketTransport` for development and debugging.
- `PeerJsTransport` for browser-to-browser WebRTC through PeerJS.
- `NativeWebRtcTransport` for browser-to-browser WebRTC DataChannels with a
  minimal WebSocket signaling hub.

Possible future transports:

- native WebRTC adapter with separate physical DataChannels for different
  reliability profiles;
- WebSocket adapter variants for non-browser test runners or dedicated servers.

### Signaling

WebRTC needs signaling before DataChannels can open.

The first LAN signaling helper is based on PeerServer. The helper is not
authoritative and does not simulate the game. It only helps peers find each
other and establish WebRTC connections.

The native WebRTC adapter uses `WebSocketHubServer` as a small custom signaling
hub for offer/answer/ICE exchange. The same hub can also carry messages directly
for the WebSocket development transport.

### Discovery

LAN discovery is optional.

A future Node helper may publish rooms with Zeroconf/mDNS, while manual host
address plus room code remains the reliable fallback.

## Repository Layout

```text
Game_Network/
  Notes/
    game_network_spec.md
  examples/
    skeleton-pwa/
  src/
    events.ts
    fakeTransport.ts
    clockSync.ts
    index.ts
    nativeWebRtcTransport.ts
    peerJsTransport.ts
    protocol.ts
    room.ts
    signalingServer.ts
    signalingServerCli.ts
    transport.ts
    webSocketHubServer.ts
    webSocketHubServerCli.ts
    webSocketTransport.ts
  scripts/
    start-webrtc-stack.mjs
  single-file-chess-game/
    index.html
  tests/
    browser/
    fakeTransport.test.ts
    protocol.test.ts
    room.test.ts
```

## Installation

This project is not published to npm yet.

For local development:

```bash
npm install
```

In this workspace the dependencies may already be available from the parent
project, but `Game_Network` has its own `package.json` so it can become a
separate repository cleanly.

## Available Commands

Build TypeScript:

```bash
npm run build
```

Run Node unit tests:

```bash
npm run test
```

Run Playwright browser tests:

```bash
npm run test:browser
```

Run the complete test suite:

```bash
npm run test:all
```

Run a security audit for all dependencies:

```bash
npm run audit
```

Run a security audit for runtime dependencies only:

```bash
npm run audit:prod
```

Start the skeleton PWA manually:

```bash
npm run dev:skeleton
```

Then open:

```text
http://127.0.0.1:5173/?role=host&room=ROOM-1&name=HST&peer=host-peer
http://127.0.0.1:5173/?role=guest&room=ROOM-1&name=GST&peer=guest-peer&host=host-peer
```

Start only the local PeerServer signaling helper:

```bash
npm run dev:peer-signaling
```

Start only the local WebSocket hub:

```bash
npm run dev:websocket-hub
```

Start the full transport test stack:

- PeerServer on port `9000`;
- WebSocket hub on port `9100`;
- skeleton PWA on port `5175`.

```bash
npm run dev:webrtc-stack
```

Then open:

```text
http://127.0.0.1:5175/?transport=peerjs&role=host&room=ROOM-1&name=HST&peer=host-peer
http://127.0.0.1:5175/?transport=peerjs&role=guest&room=ROOM-1&name=GST&peer=guest-peer&host=host-peer
```

WebSocket development transport:

```text
http://127.0.0.1:5175/?transport=websocket&role=host&room=ROOM-1&name=HST&peer=host-peer
http://127.0.0.1:5175/?transport=websocket&role=guest&room=ROOM-1&name=GST&peer=guest-peer&host=host-peer
```

Native WebRTC transport:

```text
http://127.0.0.1:5175/?transport=native-webrtc&role=host&room=ROOM-1&name=HST&peer=host-peer
http://127.0.0.1:5175/?transport=native-webrtc&role=guest&room=ROOM-1&name=GST&peer=guest-peer&host=host-peer
```

The default skeleton mode uses `BroadcastChannel`, which is useful for fast
browser-page tests. The `transport=websocket` mode uses the hub as a direct
message relay. The `transport=peerjs` mode uses PeerJS and WebRTC
DataConnections through PeerServer. The `transport=native-webrtc` mode uses
native `RTCPeerConnection` / `RTCDataChannel` with the WebSocket hub only for
signaling.

## Basic Usage

The game defines its own input and snapshot types.

```ts
type GameInput = {
  direction: "up" | "down" | "left" | "right";
  actionPressed: boolean;
};

type GameSnapshot = {
  tick: number;
  players: Array<{ id: string; x: number; y: number }>;
};

type GameEvent = {
  kind: "round_started" | "round_ended";
};
```

### Host

```ts
import { HostRoom } from "@local/game-network";

const hostRoom = new HostRoom<GameInput, GameSnapshot, GameEvent>({
  roomId: "ROOM-1",
  maxPlayers: 4,
  displayName: "HST",
  transport,
  assignPlayerId: (index) => `p${index + 1}`,
});

hostRoom.onPlayerJoined((player) => {
  console.log("player joined", player);
});

hostRoom.onInput((payload) => {
  // The game owns the simulation.
  // Apply payload.input for payload.playerId, advance state, then broadcast.
  hostRoom.sendSnapshot({
    tick: payload.clientSeq,
    players: [],
  });
});
```

### Guest

```ts
import { GuestRoom } from "@local/game-network";

const guestRoom = new GuestRoom<GameInput, GameSnapshot, GameEvent>({
  roomId: "ROOM-1",
  displayName: "GST",
  hostPeerId: "host-peer",
  transport,
});

guestRoom.onConnected((payload) => {
  console.log("assigned player", payload.localPlayer.id);
});

guestRoom.onSnapshot((payload) => {
  renderGame(payload.snapshot);
});

guestRoom.join();

guestRoom.sendInput({
  direction: "left",
  actionPressed: true,
});
```

The `transport` in these examples is intentionally abstract. In tests it can be
`FakeTransport`; in the browser skeleton it is a `BroadcastChannel` transport;
in WebRTC mode it can be `PeerJsTransport` or `NativeWebRtcTransport`.

### Clock Sync

`ClockSyncHost` and `ClockSyncClient` provide a low-level synchronized
application clock. The game engine remains host-authoritative; clock sync only
helps clients map local monotonic time to the host's monotonic time.

The protocol uses four timestamps:

- guest sends `sync_req(syncSeq, t1)`;
- host records receive time `t2`;
- host sends `sync_resp(syncSeq, t1, t2, t3)`;
- guest records receive time `t4`.

The client computes:

```text
rtt    = (t4 - t1) - (t3 - t2)
offset = ((t2 - t1) + (t3 - t4)) / 2
```

It keeps recent samples, selects the lowest-RTT samples, estimates median
offset, and fits a small linear model for clock drift. This gives the game:

- `client.now()` as estimated host time;
- `hostTimeFromLocal(localTime)`;
- `localTimeFromHost(hostTime)`;
- `scheduleAtHostTime(hostTime, callback)`;
- quality stats such as `offsetMs`, `rttMs`, `bestRttMs`, `drift`.

Host setup:

```ts
import { ClockSyncHost } from "@local/game-network";

const clockHost = new ClockSyncHost({
  roomId: "ROOM-1",
  transport: hostTransport,
});
```

Guest setup:

```ts
import { ClockSyncClient } from "@local/game-network";

const clockClient = new ClockSyncClient({
  roomId: "ROOM-1",
  hostPeerId: "host-peer",
  transport: guestTransport,
});

clockClient.requestBurst(32);
```

For game events, schedule a little in the future of the host clock:

```ts
const startAt = clockClient.now() + 40;
clockClient.scheduleAtHostTime(startAt, () => startRoundAnimation());
```

Current adapters multiplex the logical `sync` channel into the same physical
connection as `control` and `realtime`. The API is already separated so a future
WebRTC adapter can map `sync` to a dedicated unordered, low-latency
DataChannel.

### PeerJS Transport

```ts
import { PeerJsTransport } from "@local/game-network";

const hostTransport = await PeerJsTransport.create({
  peerId: "host-peer",
  peerOptions: {
    host: "127.0.0.1",
    port: 9000,
    path: "/game-network",
    secure: false,
    config: {
      iceServers: [],
    },
  },
});
```

Guests create their own transport and connect to the host peer before calling
`guestRoom.join()`.

```ts
const guestTransport = await PeerJsTransport.create({
  peerId: "guest-peer",
  peerOptions: {
    host: "127.0.0.1",
    port: 9000,
    path: "/game-network",
    secure: false,
    config: {
      iceServers: [],
    },
  },
});

await guestTransport.connect("host-peer");
```

The current adapter uses one reliable PeerJS DataConnection and multiplexes the
library's logical `control`, `realtime`, and `sync` channels inside each
message. Future versions may use separate physical DataChannels with different
reliability settings.

### WebSocket Development Transport

`WebSocketTransport` is intended for development, diagnostics, and tests where
WebRTC itself is not the thing being tested.

```ts
import { WebSocketTransport } from "@local/game-network";

const transport = await WebSocketTransport.create({
  peerId: "guest-peer",
  url: "ws://127.0.0.1:9100",
});
```

The WebSocket hub relays messages. This is not the desired final gameplay path
for LAN games, but it is useful when debugging room logic.

### Native WebRTC Transport

`NativeWebRtcTransport` uses browser WebRTC APIs directly. The WebSocket hub is
used only for signaling.

```ts
import { NativeWebRtcTransport } from "@local/game-network";

const hostTransport = await NativeWebRtcTransport.create({
  peerId: "host-peer",
  signalingUrl: "ws://127.0.0.1:9100",
  rtcConfig: {
    iceServers: [],
  },
});

const guestTransport = await NativeWebRtcTransport.create({
  peerId: "guest-peer",
  signalingUrl: "ws://127.0.0.1:9100",
  rtcConfig: {
    iceServers: [],
  },
});

await guestTransport.connect("host-peer");
```

The current native adapter uses one ordered reliable DataChannel and multiplexes
the library's logical channels in JSON messages.

### Single-File Chess Candidate Demo

`single-file-chess-game/index.html` is a compact candidate game for validating
room, clock-sync, and diagnostics features before integrating networking into
QIX. Its UI includes a `Collegamento` panel that shows local page address/port,
role, room id, peer ids, signaling endpoint, transport, RTT, best RTT, clock
offset, and sync quality.

The panel can be fed by the game or by tests through:

```ts
window.__CHESS_NETWORK_DIAGNOSTICS__.update({
  status: "connected",
  connectedPeerId: "guest-peer",
  rttMs: 18,
  bestRttMs: 12,
  offsetMs: 3.4,
  lastSyncAt: Date.now(),
});
```

It also has a localhost sync test mode through `WebSocketTransport`.
The chess page uses a host-authoritative model: the host owns the board state,
broadcasts snapshots, and accepts guest moves as realtime inputs. The guest can
play optimistically, but the next host snapshot is the source of truth.

Build the library, start the WebSocket hub, then serve the `Game_Network` folder
on two local ports:

```bash
npm run build
npm run dev:websocket-hub
```

In two other terminals, from the `Game_Network` directory:

```bash
python -m http.server 9201
python -m http.server 9202
```

Open the host:

```text
http://127.0.0.1:9201/single-file-chess-game/?transport=websocket&role=host&room=CHESS-1&peer=chess-host&signaling=ws://127.0.0.1:9100
```

Open the guest:

```text
http://127.0.0.1:9202/single-file-chess-game/?transport=websocket&role=guest&room=CHESS-1&peer=chess-guest&host=chess-host&signaling=ws://127.0.0.1:9100
```

When the guest joins, the `Collegamento` panel should show the remote peer,
RTT, best RTT, offset, and sync quality. Moving a piece on the host should update
the guest after the snapshot. Moving a legal piece on the guest sends a realtime
input to the host; the host applies it and broadcasts the resulting snapshot.

For the automated localhost browser test:

```bash
npm run test:chess
```

That spec starts its own temporary WebSocket hub and two temporary static
servers, then verifies host snapshot mirroring and guest move propagation.

## Testing Strategy

The project grows one feature at a time.

Current test coverage:

- protocol envelopes are created and recognized;
- clock sync computes NTP-style offset and RTT from four timestamps;
- clock sync filters low-RTT samples for robust estimates;
- clock sync exchanges host/client messages over the logical `sync` channel;
- invalid envelopes are rejected;
- fake transport delivers direct messages;
- fake transport broadcasts to all peers except sender;
- guest can join host room;
- host assigns player ids;
- room limit is enforced;
- guest input reaches host;
- host snapshot reaches guest;
- the single-file chess candidate mirrors host snapshots and guest moves over
  WebSocket;
- skeleton PWA exchanges data across two browser pages with `BroadcastChannel`;
- skeleton PWA exchanges data across two browser pages with WebSocket;
- skeleton PWA exchanges data across two browser pages with PeerJS/WebRTC;
- skeleton PWA exchanges data across two browser pages with native WebRTC.

The browser test opens two pages:

- one host page;
- one guest page.

The guest joins, sends an input, the host receives it, and the guest receives an
authoritative snapshot in response.

## Security Checks

Dependency security is part of the normal project workflow.

Run this before releases, before integrating the library into a game, and after
adding or upgrading dependencies:

```bash
npm run audit
```

For runtime-only risk, especially before packaging the library for another game:

```bash
npm run audit:prod
```

Known-vulnerability policy:

- critical or high runtime vulnerabilities block integration;
- moderate runtime vulnerabilities should be fixed or explicitly documented;
- development-only vulnerabilities are evaluated case by case;
- `npm audit fix --force` should not be used blindly because it may introduce
  breaking upgrades.

## Design Principles

- Host authoritative first.
- Game rules stay outside the library.
- Transport stays replaceable.
- JSON first for debuggability.
- Runtime validation at network boundaries.
- Manual LAN join must always work.
- Discovery is optional convenience, not a requirement.
- Tests should be possible without real WebRTC.

## Roadmap

1. Stabilize the core API.
2. Add stricter message validation.
3. Add disconnect and player-left handling.
4. Add clock sync burst scheduling and quality diagnostics.
5. Test LAN connection between two machines.
6. Add optional Zeroconf/mDNS room discovery.
7. Add separate physical DataChannels for control, realtime, and sync traffic.
8. Harden disconnect/reconnect behavior.
9. Prepare npm package metadata and exports.
10. Integrate with QIX as the first real game.

## Notes

The detailed technical specification lives in:

```text
Notes/game_network_spec.md
```
