# Developer API Guide

This guide is for developers integrating Game Network into another browser game.

## Contract

Game Network does not know game rules. Your game owns:

- player limits;
- player ids;
- input payloads;
- snapshots;
- events;
- state validation;
- rendering.

Game Network provides:

- room lifecycle;
- host and guest APIs;
- transport abstraction;
- message envelopes;
- low-level clock synchronization.

## Host Room

```ts
import { HostRoom } from "@local/game-network";

type GameInput = {
  kind: "move";
  direction: "up" | "down" | "left" | "right";
};

type GameSnapshot = {
  tick: number;
  players: Array<{ id: string; x: number; y: number }>;
};

const hostRoom = new HostRoom<GameInput, GameSnapshot>({
  roomId: "ROOM-1",
  maxPlayers: 4,
  displayName: "HST",
  transport,
  assignPlayerId: (index) => `p${index + 1}`,
});

hostRoom.onPlayerJoined((player) => {
  console.log("joined", player);
  hostRoom.sendSnapshot(currentSnapshot());
});

hostRoom.onInput((payload) => {
  applyInput(payload.playerId, payload.input);
  hostRoom.sendSnapshot(currentSnapshot());
});
```

## Guest Room

```ts
import { GuestRoom } from "@local/game-network";

const guestRoom = new GuestRoom<GameInput, GameSnapshot>({
  roomId: "ROOM-1",
  displayName: "GST",
  hostPeerId: "host-peer",
  transport,
});

guestRoom.onConnected((payload) => {
  console.log("assigned player", payload.localPlayer.id);
});

guestRoom.onSnapshot((payload) => {
  render(payload.snapshot);
});

guestRoom.join();

guestRoom.sendInput({
  kind: "move",
  direction: "left",
});
```

## Transports

`transport` is intentionally abstract.

Currently available:

- `FakeTransport`: deterministic tests;
- `WebSocketTransport`: development, LAN relay, and service-hosted games;
- `PeerJsTransport`: WebRTC DataConnection through PeerJS;
- `NativeWebRtcTransport`: direct browser WebRTC with WebSocket signaling.

For service-hosted games, `WebSocketTransport` is the simplest transport because
it works through the same local service and can be collapsed onto one port.

## WebSocket Transport

```ts
import { WebSocketTransport } from "@local/game-network";

const transport = await WebSocketTransport.create({
  peerId: "guest-peer",
  url: "ws://192.168.0.197:9201/ws",
});
```

The service prints the right address at startup. In normal non-privileged mode
it looks like:

```text
ws://192.168.0.197:9201/ws
```

If the service is running on port `80`, it is:

```text
ws://192.168.0.197/ws
```

Two-port WebSocket hub commands still exist for low-level transport debugging,
but games should prefer the service URL.

## Clock Sync

Clock sync is a low-level service used to estimate host time from a guest page.
It does not change the OS clock.

Host:

```ts
import { ClockSyncHost } from "@local/game-network";

const clockHost = new ClockSyncHost({
  roomId: "ROOM-1",
  transport: hostTransport,
});
```

Guest:

```ts
import { ClockSyncClient } from "@local/game-network";

const clockClient = new ClockSyncClient({
  roomId: "ROOM-1",
  hostPeerId: "host-peer",
  transport: guestTransport,
});

clockClient.requestBurstScheduled(16, 40);
```

Useful APIs:

- `clockClient.now()`: estimated host time;
- `hostTimeFromLocal(localTime)`;
- `localTimeFromHost(hostTime)`;
- `scheduleAtHostTime(hostTime, callback)`;
- `requestBurst(count)`: immediate compatibility burst;
- `requestBurstScheduled(count, spacingMs)`: preferred browser/WebRTC burst
  because samples are spread across multiple event-loop and network turns;
- `getEstimate()`: RTT, best RTT, offset, drift, intercept, lock status.

`scheduleAtHostTime()` uses `setTimeout()` under the hood. It is useful for
countdowns, UI triggers, diagnostic probes, and events scheduled with a small
lookahead, but it is not a hard real-time browser scheduler.

### Assisted One-Way Delay

Room messages now carry envelope timestamps:

- host snapshots/events include `sentAt` in host time;
- guest inputs can include `sentAt` in estimated host time when `GuestRoom` is
  constructed with `now: () => clockClient.now()`;
- room handlers receive timing metadata on payloads:
  `sentAt`, `receivedAt`, and `oneWayDelayMs`.

This is not a standalone clock synchronization method. Use the bidirectional
clock sync first, then use one-way samples as a refinement for diagnostics,
lookahead tuning, and critical-event scheduling.

Example guest setup:

```ts
const clockClient = new ClockSyncClient({
  roomId: "ROOM-1",
  hostPeerId: "host-peer",
  transport,
});

const guestRoom = new GuestRoom<GameInput, GameSnapshot>({
  roomId: "ROOM-1",
  displayName: "GST",
  hostPeerId: "host-peer",
  transport,
  now: () => clockClient.now(),
});
```

Example host use:

```ts
hostRoom.onInput((payload) => {
  console.log("guest one-way delay", payload.oneWayDelayMs);
});
```

For rolling diagnostics, use `OneWayDelayTracker`:

```ts
const oneWay = new OneWayDelayTracker();

guestRoom.onSnapshot((payload) => {
  if (payload.sentAt !== undefined && payload.receivedAt !== undefined) {
    const estimate = oneWay.add(payload.sentAt, payload.receivedAt);
    console.log(estimate.delayMs, estimate.jitterMs);
  }
});
```

For details see [PROTOCOLLO DI SINCRONIZZAZIONE](../Notes/PROTOCOLLO%20DI%20SINCRONIZZAZIONE.md).

## Recommended Game Integration Pattern

For each game create a small adapter layer:

```ts
type GameNetworkAdapter = {
  getSnapshot(): GameSnapshot;
  applySnapshot(snapshot: GameSnapshot): void;
  applyRemoteInput(playerId: string, input: GameInput): boolean;
  sendLocalInput(input: GameInput): void;
};
```

Keep this adapter separate from the renderer and from the service launcher. That
makes the same game usable in:

- standalone local mode;
- Game Network hosted mode;
- automated browser tests;
- future packaged service mode.

## Publishing Checklist

Before npm publishing:

- choose package name and public exports;
- remove `private: true`;
- document runtime dependencies;
- add `exports` in `package.json`;
- add generated `.d.ts` files to the package;
- run `npm run audit:prod`;
- publish a GitHub release with the service and examples.

## Example Game

The chess app is a worked example, not the model for all games. Its integration
notes live separately:

[Chess Example Integration](CHESS_EXAMPLE_INTEGRATION.md)
