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
- Node unit tests;
- Playwright browser test with two app pages exchanging data.

Not implemented yet:

- PeerJS transport adapter;
- PeerServer or custom LAN signaling server;
- WebRTC DataChannel transport;
- Zeroconf/mDNS discovery;
- reconnect handling;
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

Planned transports:

- PeerJS DataConnection adapter;
- native WebRTC DataChannel adapter;
- optional WebSocket adapter for development.

### Signaling

WebRTC needs signaling before DataChannels can open.

The intended first LAN solution is a small Node signaling helper, probably based
on PeerServer first. The helper is not authoritative and does not simulate the
game. It only helps peers find each other and establish WebRTC connections.

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
    protocol.ts
    room.ts
    transport.ts
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

Start the skeleton PWA manually:

```bash
npm run dev:skeleton
```

Then open:

```text
http://127.0.0.1:5173/?role=host&room=ROOM-1&name=HST&peer=host-peer
http://127.0.0.1:5173/?role=guest&room=ROOM-1&name=GST&peer=guest-peer&host=host-peer
```

The skeleton example currently uses `BroadcastChannel`, so it is a browser-page
test harness rather than the final LAN/WebRTC transport.

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
later it will be a PeerJS or WebRTC transport.

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
- skeleton PWA exchanges data across two browser pages.

The browser test opens two pages:

- one host page;
- one guest page.

The guest joins, sends an input, the host receives it, and the guest receives an
authoritative snapshot in response.

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
5. Add a PeerJS transport adapter.
6. Add a local PeerServer-based signaling helper.
7. Test real WebRTC between two browser pages.
8. Test LAN connection between two machines.
9. Add optional Zeroconf/mDNS room discovery.
10. Integrate with QIX as the first real game.

## Notes

The detailed technical specification lives in:

```text
Notes/game_network_spec.md
```

