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
- in-memory fake transport for deterministic tests;
- skeleton PWA example using `BroadcastChannel`;
- PeerJS transport adapter using WebRTC DataConnections;
- local PeerServer-based signaling helper;
- skeleton PWA `transport=peerjs` mode;
- WebSocket hub and development transport;
- native WebRTC DataChannel transport with WebSocket signaling;
- Node unit tests;
- Playwright browser tests for `BroadcastChannel`, WebSocket, PeerJS/WebRTC,
  and native WebRTC.

Not implemented yet:

- Zeroconf/mDNS discovery;
- reconnect handling;
- multiple physical DataChannels with different reliability settings;
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
library's logical `control` and `realtime` channels inside each message. Future
versions may use separate physical DataChannels with different reliability
settings.

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

## Testing Strategy

The project grows one feature at a time.

Current test coverage:

- protocol envelopes are created and recognized;
- invalid envelopes are rejected;
- fake transport delivers direct messages;
- fake transport broadcasts to all peers except sender;
- guest can join host room;
- host assigns player ids;
- room limit is enforced;
- guest input reaches host;
- host snapshot reaches guest;
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
4. Add ping/pong latency diagnostics.
5. Test LAN connection between two machines.
6. Add optional Zeroconf/mDNS room discovery.
7. Add separate physical DataChannels for control and realtime traffic.
8. Harden disconnect/reconnect behavior.
9. Prepare npm package metadata and exports.
10. Integrate with QIX as the first real game.

## Notes

The detailed technical specification lives in:

```text
Notes/game_network_spec.md
```
