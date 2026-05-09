# Game Network Specification

Draft status: initial technical specification

## 1. Purpose

Game Network is a reusable TypeScript networking layer for small browser-based
multiplayer games on a local network.

The first consumer will be the QIX WebRTC project, but the library must remain
generic enough to support other real-time games with a host-authoritative model.

The library does not reimplement WebRTC. It provides a game-oriented abstraction
over WebRTC DataChannels and a small local signaling service.

## 2. Goals

- Support small rooms with game-configurable participant limits.
- Run on a local subnet with no external service required.
- Use a host-authoritative simulation model.
- Let guests join with a short manual room code or simple LAN URL.
- Provide stable player identifiers and display names.
- Expose a small event-based API to games.
- Keep game protocol messages typed and versioned.
- Allow optional LAN discovery through Zeroconf/mDNS.
- Keep the transport replaceable: PeerJS first, native WebRTC later if needed.

## 3. Non-goals

- No internet matchmaking in the first version.
- No persistent accounts.
- No anti-cheat guarantees.
- No authoritative cloud server.
- No audio/video calls.
- No file transfer.
- No generic chat system.
- No generic peer-to-peer data tunnel.
- No generic relay service.
- No arbitrary socket abstraction exposed as the main API.
- No direct dependency on any specific game engine.
- No attempt to bypass browser or operating-system network security rules.

## 4. Target Use Case

The main target is a casual real-time game where:

- one browser instance is the host;
- the host owns the simulation;
- guests send input commands;
- the host broadcasts state snapshots and game events;
- all peers are expected to be on the same LAN;
- the game can tolerate occasional packet loss but not divergent simulation.

QIX multiplayer is the reference case:

- host simulates the complete game state;
- guests send input frames;
- host sends authoritative snapshots;
- clients render the most recent known state.

## 5. Architecture

The project is split into four logical layers.

### 5.1 Core

The core package defines:

- public API;
- connection lifecycle;
- room model;
- player model;
- message types;
- error types;
- transport-agnostic interfaces.

The core must not import PeerJS, WebSocket, Zeroconf, or any game code.

### 5.2 Transport Adapter

The transport adapter connects the core API to a concrete peer transport.

Initial adapter:

- PeerJS client adapter.

Possible future adapters:

- native WebRTC adapter;
- WebSocket-only adapter for development;
- in-memory fake adapter for tests.

### 5.3 Signaling Server

The signaling server is a small Node process used only to establish WebRTC
connections.

Initial implementation options:

- PeerServer from the PeerJS project;
- custom WebSocket signaling service.

The signaling server should not simulate the game and should not be on the
critical gameplay path after the DataChannels are open.

### 5.4 Discovery

Discovery is optional.

A Node helper may advertise the local signaling endpoint through mDNS/Zeroconf.
The browser client must also support manual connection, because multicast
discovery can be blocked by network settings or firewalls.

## 6. Roles

### Host

The host:

- creates the room;
- receives guest join requests;
- assigns player slots;
- starts and stops the round;
- receives player inputs;
- runs the authoritative simulation;
- broadcasts snapshots and events.

The host is always player `p1` in games that use fixed player slots.

### Guest

A guest:

- joins an existing room;
- sends a nickname or initials;
- receives an assigned player id;
- sends input frames;
- renders authoritative snapshots from the host.

### Signaling Helper

The signaling helper:

- runs locally on the host machine or another machine in the LAN;
- exchanges signaling metadata;
- may publish a Zeroconf service;
- does not need to know game rules.

## 7. Player Identity

The network layer distinguishes between three identifiers.

### Peer ID

Transport-level identifier used by PeerJS or WebRTC signaling.

It may be generated or chosen, but games should not depend on its format.

### Player ID

Stable in-game slot assigned by the host.

For QIX:

- `p1`: host;
- `p2`: first guest;
- `p3`: second guest;
- `p4`: third guest.

### Display Name

Short user-facing name.

For arcade-style games, the recommended display name is 3 characters. If the
player does not choose one, the client generates a short random name.

## 8. Room Model

A room has:

- room id;
- host peer id;
- protocol version;
- max players;
- current players;
- room status;
- optional game metadata.

Room statuses:

- `lobby`;
- `starting`;
- `running`;
- `paused`;
- `ended`;
- `closed`.

The room id should be short enough for manual entry.

Example room ids:

- `QIX-7K2`;
- `GAME-4F9`;
- `ABCD`.

## 9. Connection Flow

### 9.1 Host flow

1. Start signaling helper.
2. Create host peer.
3. Create room id.
4. Show manual join information:
   - host IP or local URL;
   - room id;
   - optional full link.
5. Accept guest connections.
6. Assign player slots.
7. Send welcome messages.
8. Start the game when ready.

### 9.2 Guest flow

1. Open the game page.
2. Enter room id or follow a join link.
3. Enter nickname or accept generated one.
4. Connect to signaling helper.
5. Open DataChannel to host.
6. Send join request.
7. Receive assigned player id and room config.
8. Enter lobby or running game.

## 10. Public API Draft

```ts
export interface CreateHostRoomOptions<GameConfig = unknown> {
  roomId?: string;
  maxPlayers: number;
  displayName: string;
  gameConfig?: GameConfig;
  signalingUrl: string;
}

export interface JoinRoomOptions {
  roomId: string;
  displayName: string;
  signalingUrl: string;
}

export interface HostRoom<GameInput, GameSnapshot, GameEvent> {
  readonly roomId: string;
  readonly localPlayer: PlayerInfo;
  readonly players: readonly PlayerInfo[];

  start(): Promise<void>;
  close(): Promise<void>;
  kick(playerId: PlayerId, reason?: string): void;
  sendSnapshot(snapshot: GameSnapshot): void;
  sendEvent(event: GameEvent): void;

  onPlayerJoined(handler: (player: PlayerInfo) => void): Unsubscribe;
  onPlayerLeft(handler: (playerId: PlayerId, reason?: string) => void): Unsubscribe;
  onInput(handler: (input: InputEnvelope<GameInput>) => void): Unsubscribe;
}

export interface GuestRoom<GameInput, GameSnapshot, GameEvent> {
  readonly roomId: string;
  readonly localPlayer: PlayerInfo;
  readonly players: readonly PlayerInfo[];

  close(): Promise<void>;
  sendInput(input: GameInput): void;

  onSnapshot(handler: (snapshot: SnapshotEnvelope<GameSnapshot>) => void): Unsubscribe;
  onEvent(handler: (event: GameEventEnvelope<GameEvent>) => void): Unsubscribe;
  onPlayersChanged(handler: (players: readonly PlayerInfo[]) => void): Unsubscribe;
  onDisconnected(handler: (reason?: string) => void): Unsubscribe;
}
```

## 11. Protocol Messages

All messages include:

- protocol version;
- message type;
- sender id;
- sequence number where applicable;
- timestamp where useful.

### 11.1 Lobby messages

- `join_request`
- `join_accept`
- `join_reject`
- `player_joined`
- `player_left`
- `room_update`
- `ready_state`
- `start_game`
- `end_game`

### 11.2 Runtime messages

- `input`
- `snapshot`
- `game_event`
- `ping`
- `pong`
- `sync_req`
- `sync_resp`
- `resync_request`
- `resync_snapshot`

### 11.3 Error messages

- `version_mismatch`
- `room_full`
- `invalid_room`
- `invalid_message`
- `host_closed`
- `timeout`

## 12. Transport Channels

The abstraction should support at least three logical channels.

### Control channel

Purpose:

- lobby;
- join/leave;
- round start/end;
- reliable game events;
- error messages.

Recommended transport:

- ordered;
- reliable.

### Realtime channel

Purpose:

- frequent input frames;
- frequent snapshots;
- transient state updates.

Recommended transport:

- low latency;
- loss tolerant;
- sequence-numbered;
- stale messages may be dropped.

### Sync channel

Purpose:

- low-level host/client application clock synchronization;
- small timestamp messages;
- latency and quality estimates for game scheduling.

Recommended transport:

- low latency;
- loss tolerant;
- old samples may be dropped;
- ideally a dedicated unordered WebRTC DataChannel.

If the selected adapter does not support multiple DataChannel reliability modes,
the core should still expose logical channels and let the adapter downgrade to
the available capability.

## 13. Simulation Model

The first supported simulation model is host authoritative.

Guests never decide final game state. They send input only.

The host:

- collects inputs;
- advances the simulation on fixed ticks;
- resolves collisions and scoring;
- sends snapshots;
- may send reliable events for important transitions.

Guests:

- render snapshots;
- may apply local prediction in future versions;
- must accept host correction.

For QIX, prediction is optional and should not be part of the first integration.

## 14. Timing

Messages that affect simulation should include tick or sequence information.

Recommended fields:

- `clientSeq`: monotonically increasing input sequence from a guest;
- `hostTick`: authoritative simulation tick;
- `sentAt`: sender local timestamp;
- `receivedAt`: optional local diagnostic timestamp.

The library should provide ping/pong latency estimates, but games decide how to
use them.

The library also provides optional clock synchronization as a separate low-level
service. It uses a host/client model and four timestamp messages:

- guest sends `sync_req(syncSeq, t1)`;
- host records receive time `t2`;
- host sends `sync_resp(syncSeq, t1, t2, t3)`;
- guest records receive time `t4`.

The client computes:

```text
rtt    = (t4 - t1) - (t3 - t2)
offset = ((t2 - t1) + (t3 - t4)) / 2
```

The client keeps recent samples, filters the lowest-RTT subset, estimates median
offset, and fits a linear model for drift. This produces a virtual host clock
without changing the operating-system clock. Games can use it for synchronized
round starts, rendering interpolation, and event scheduling, while the host
remains authoritative for simulation state.

After the bidirectional clock-sync phase has a stable model, game messages can
carry assisted one-way timing metadata:

- `sentAt`: sender timestamp in its local or virtual application clock;
- `receivedAt`: receiver timestamp captured as close as possible to delivery;
- `oneWayDelayMs`: diagnostic estimate computed by the receiver.

These values are not a replacement for clock synchronization. They are useful
only after the receiver can compare the sender timestamp against an aligned
clock model. Implementations should keep housekeeping traffic, such as
`clock_stats`, separate from gameplay one-way samples so dashboards do not mix
maintenance traffic with player inputs or snapshots.

Diagnostic integrations may also exchange no-op application probes. A
`diagnostic_probe` carries a sequence number, a sender direction, and a
`scheduledAt` timestamp in the shared application timeline. Receivers compare
arrival time with `scheduledAt` to show the current safety margin. The probe must
not modify game state, scoring, turn order, or user-visible move history.

## 15. Message Encoding

The first version should use JSON for clarity and debuggability.

The protocol should keep the message schema explicit so a binary encoding can be
added later without changing game-level APIs.

Future options:

- MessagePack;
- CBOR;
- compact custom binary encoding for snapshots.

## 16. Validation

Runtime validation is recommended at the network boundary.

The implementation may use a schema library such as Zod, or a lightweight custom
validator if dependency size becomes important.

Invalid messages should be rejected without crashing the room.

## 17. Security And Trust Model

The first version assumes friendly LAN play.

The library should still:

- reject unsupported protocol versions;
- reject unknown message types;
- enforce max player count;
- enforce room code matching;
- avoid evaluating remote data;
- close connections that repeatedly send invalid messages.

The library does not prevent cheating by a modified client.

## 18. Intended Use And Safety Boundaries

Game Network is intended only for connecting browser-based multiplayer PWA game
instances controlled by the users who are actively playing together.

The project must not become a general-purpose communication, tunneling, relay,
file-transfer, remote-control, or anonymous peer-to-peer messaging library.

Allowed uses:

- local or LAN multiplayer PWA games;
- host-authoritative game sessions;
- deterministic game-input exchange;
- authoritative game snapshots;
- lobby metadata for players in the same game session;
- local development and testing of multiplayer game flows.

Disallowed uses:

- arbitrary peer-to-peer data exchange unrelated to a game session;
- file transfer;
- hidden background communication;
- remote administration or remote-control features;
- anonymous internet matchmaking;
- public relay services;
- generic chat or messaging products;
- attempts to bypass browser, operating-system, router, or network policies.

API safety constraints:

- Public APIs should stay room-oriented: `HostRoom`, `GuestRoom`, game inputs,
  snapshots, and game events.
- Raw transports should remain adapter internals or clearly marked development
  tools.
- The library should not expose a convenient generic `sendAnythingToAnyone`
  surface as the primary API.
- Message types must be versioned and validated at the network boundary.
- Unknown message types must be rejected.
- Message size limits must be enforced before npm publication.
- Repeated invalid messages should close or quarantine the connection.
- Runtime channels should be scoped to a known room id.
- Signaling helpers should not become public relay infrastructure.
- Examples must remain game/skeleton-game examples, not chat, file transfer, or
  generic communication demos.

Publishing safety requirements:

- README must include intended-use and prohibited-use language.
- `package.json` description and keywords must emphasize PWA multiplayer games.
- Security checks must include `npm audit` and `npm audit --omit=dev`.
- High or critical runtime vulnerabilities block publication.
- Moderate runtime vulnerabilities must be fixed or explicitly documented before
  publication.
- `npm audit fix --force` must not be used without review.

## 19. LAN Join UX

The desired first UX is simple manual entry.

Host screen shows:

- local URL or host address;
- room id;
- list of connected players;
- start button.

Guest screen accepts:

- room id;
- host address or full link;
- nickname.

Optional discovery can later show nearby rooms, but manual join remains the
fallback.

## 20. Suggested Repository Layout

```text
Game_Network/
  Notes/
  packages/
    core/
    peerjs-adapter/
    signaling-server/
    discovery/
    test-utils/
  examples/
    squares-demo/
  tests/
```

### packages/core

Transport-agnostic API and protocol types.

### packages/peerjs-adapter

PeerJS-backed browser adapter.

### packages/signaling-server

Node CLI or library that starts the local signaling service.

### packages/discovery

Optional Zeroconf/mDNS publication and discovery helpers.

### packages/test-utils

Fake transports, deterministic clocks, and protocol test helpers.

### examples/squares-demo

Minimal browser demo with one host and up to three guests moving colored squares.

## 21. Test Strategy

### Unit tests

- room state transitions;
- player assignment;
- protocol message validation;
- sequence handling;
- stale message dropping;
- reconnect/leave behavior.

### Integration tests

- host creates room;
- guest joins;
- max player count is enforced;
- guest sends input and host receives it;
- host sends snapshot and guests receive it;
- disconnect removes player;
- version mismatch is rejected.

### Browser tests

Use Playwright with multiple browser pages:

- one page as host;
- one to three pages as guests;
- verify lobby;
- verify input propagation;
- verify snapshot propagation;
- verify graceful disconnect.

### Fake transport tests

The core should be testable without real WebRTC.

Fake transport should simulate:

- latency;
- packet loss;
- reordering;
- disconnect;
- reconnect attempt.

## 22. Initial Milestones

### Milestone 1: Specification and protocol

- finalize this specification;
- define TypeScript protocol types;
- define public API;
- define fake transport contract.

### Milestone 2: Core without WebRTC

- implement room lifecycle;
- implement player assignment;
- implement message envelope validation;
- test with fake transport.

### Milestone 3: Minimal browser demo

- create the squares demo;
- use fake or WebSocket transport first if useful;
- validate host-authoritative flow.

### Milestone 4: PeerJS transport

- add PeerJS client adapter;
- add PeerServer-based signaling helper;
- connect host and guest browsers on the same machine.

### Milestone 5: LAN workflow

- expose host URL and room code;
- test across machines in the same subnet;
- add optional Zeroconf publication.

### Milestone 6: QIX integration

- integrate as external dependency or local workspace link;
- host sends snapshots;
- guests send input;
- keep QIX game rules outside Game Network.

## 23. Open Decisions

- Use PeerServer directly in the first MVP, or write a tiny custom WebSocket
  signaling service from the start?
- Use npm workspaces from day one?
- Use Zod or custom validators?
- Keep room ids purely random, or include a game prefix?
- Should the first adapter expose one physical DataChannel or two?
- Should discovery be implemented before or after QIX integration?

## 24. Recommended Defaults

- Language: TypeScript.
- Runtime: browser client plus Node signaling helper.
- First signaling backend: PeerServer.
- First game transport: PeerJS adapter.
- First encoding: JSON.
- First simulation model: host authoritative.
- First demo: colored squares.
- Discovery: optional after manual join works.
